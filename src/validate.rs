//! From syntax tree to static HTML IR, in three steps:
//!
//! 1. **Script and props.** Evaluate the script's build-time bindings in order, then each prop's
//!    default in the script's scope, then apply build-time prop values (`--props`).
//! 2. **Resolve** (static, every branch): every name in every `{…}` must refer to a loop
//!    variable, a prop or a script binding — checked even in branches this build won't render,
//!    so a typo can't hide behind a condition. Literal URLs are checked here too.
//! 3. **Lower** (evaluate, taken branches only): conditions pick a branch, loops expand, slots
//!    fill, and dynamic values are escaped and safety-checked.
//!
//! Inside the template, names resolve innermost-first: loop variables, then props, then script
//! bindings. So in `<mnx-header title={title}><h1>{title}</h1>`, `{title}` is the *prop* (which
//! defaults to the script's `title`), and a build-time override reaches the template.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::{
    ast::{self, AttributeValue, Part as AstPart, PropDefault},
    diagnostic::{Diagnostic, Span},
    expression::{self, Expression},
    ir::{self, Node, Part},
};

const URL_ATTRIBUTES: &[&str] = &[
    "action",
    "background",
    "cite",
    "codebase",
    "data",
    "formaction",
    "href",
    "longdesc",
    "manifest",
    "poster",
    "profile",
    "src",
    "xlink:href",
    "usemap",
];
const BOOLEAN_ATTRIBUTES: &[&str] = &[
    "allowfullscreen",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "controls",
    "default",
    "defer",
    "disabled",
    "formnovalidate",
    "hidden",
    "inert",
    "ismap",
    "itemscope",
    "loop",
    "multiple",
    "muted",
    "nomodule",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "reversed",
    "selected",
];
const RESERVED_CUSTOM_ELEMENTS: &[&str] = &[
    "annotation-xml",
    "color-profile",
    "font-face",
    "font-face-src",
    "font-face-uri",
    "font-face-format",
    "font-face-name",
    "missing-glyph",
];

/// A script binding as the build sees it.
#[derive(Clone, Debug)]
enum Local {
    Value(Value),
    /// Declared, but its value only exists at runtime (a function, an import, a call result…).
    Runtime,
}

struct Prop {
    name: String,
    attribute: String,
    default: Option<Value>,
    value: Value,
}

pub fn validate(
    component: ast::ComponentAst,
    values: &Value,
    slot_values: &HashMap<String, Vec<ast::Node>>,
) -> Result<ir::Component, Diagnostic> {
    let overrides = values
        .as_object()
        .ok_or_else(|| Diagnostic::new(Span::new(1, 1), "component props must be a JSON object"))?;
    validate_custom_element(&component.tag, component.tag_span)?;

    let locals = evaluate_script(&component.script)?;
    let props = evaluate_props(&component, &locals, overrides)?;

    let context = Context {
        locals: &locals,
        props: &props,
        slot_values,
    };

    // 2. Resolve everything, including branches and slots this build won't render.
    let mut declared_slots = HashSet::new();
    collect_slots(&component.nodes, &mut declared_slots);
    for name in slot_values.keys() {
        if !declared_slots.contains(name) {
            return Err(Diagnostic::new(
                Span::new(1, 1),
                format!("slot `{name}` is not declared by this component"),
            ));
        }
    }
    let mut scopes = Vec::new();
    context.resolve_nodes(&component.nodes, &mut scopes)?;
    for nodes in slot_values.values() {
        context.resolve_nodes(nodes, &mut scopes)?;
    }

    // 3. Lower the branches that are taken.
    let mut state = LowerState::default();
    let nodes = context.lower_nodes(&component.nodes, &mut state)?;
    check_single_root(&nodes)?;

    let host_attributes = props
        .iter()
        .filter(|prop| prop.default.as_ref() != Some(&prop.value))
        .filter_map(|prop| host_attribute(prop).map(|value| (prop.attribute.clone(), value)))
        .collect();

    Ok(ir::Component {
        tag: component.tag,
        host_attributes,
        nodes,
    })
}

// ---- 1. script and props -------------------------------------------------------------------

fn evaluate_script(script: &ast::Script) -> Result<Vec<(String, Local)>, Diagnostic> {
    let mut locals: Vec<(String, Local)> = Vec::new();
    let mut seen = HashSet::new();
    for name in &script.runtime_names {
        if !seen.insert(name.clone()) {
            return Err(Diagnostic::new(
                Span::new(1, 1),
                format!("`{name}` is declared more than once in <script>"),
            ));
        }
        locals.push((name.clone(), Local::Runtime));
    }
    for binding in &script.bindings {
        if !seen.insert(binding.name.clone()) {
            return Err(Diagnostic::new(
                binding.span,
                format!("`{}` is declared more than once in <script>", binding.name),
            ));
        }
        let local = match &binding.init {
            None => Local::Runtime,
            Some(init) => {
                // A binding can use bindings declared before it (and runtime names, which make
                // it runtime-only too).
                let mut runtime = false;
                let mut unknown = None;
                init.for_each_identifier(&mut |name| match find_local(&locals, name) {
                    Some(Local::Runtime) => runtime = true,
                    Some(Local::Value(_)) => {}
                    None => {
                        unknown.get_or_insert_with(|| name.to_owned());
                    }
                });
                if let Some(name) = unknown {
                    let names: Vec<&str> = locals.iter().map(|(name, _)| name.as_str()).collect();
                    return Err(with_suggestion(
                        Diagnostic::new(
                            binding.span,
                            format!(
                                "`{name}` is used before it is declared (in `{}`)",
                                binding.name
                            ),
                        ),
                        &name,
                        &names,
                    ));
                }
                if runtime {
                    Local::Runtime
                } else {
                    let lookup = |name: &str| match find_local(&locals, name) {
                        Some(Local::Value(value)) => Some(value.clone()),
                        _ => None,
                    };
                    Local::Value(init.evaluate(&lookup).map_err(|message| {
                        Diagnostic::new(binding.span, format!("in `{}`: {message}", binding.name))
                    })?)
                }
            }
        };
        locals.push((binding.name.clone(), local));
    }
    Ok(locals)
}

fn find_local<'l>(locals: &'l [(String, Local)], name: &str) -> Option<&'l Local> {
    locals
        .iter()
        .rev()
        .find(|(local, _)| local == name)
        .map(|(_, local)| local)
}

fn evaluate_props(
    component: &ast::ComponentAst,
    locals: &[(String, Local)],
    overrides: &serde_json::Map<String, Value>,
) -> Result<Vec<Prop>, Diagnostic> {
    let mut props = Vec::new();
    let mut seen = HashSet::new();
    for declaration in &component.props {
        if !seen.insert(declaration.name.clone()) {
            return Err(Diagnostic::new(
                declaration.span,
                format!("duplicate prop `{}`", declaration.name),
            ));
        }
        let default = match &declaration.default {
            PropDefault::Required => None,
            PropDefault::Text(text) => Some(Ok(Value::String(text.clone()))),
            PropDefault::Expression(expression, span) => {
                let names: Vec<&str> = locals.iter().map(|(name, _)| name.as_str()).collect();
                let mut problem = None;
                expression.for_each_identifier(&mut |name| {
                    if problem.is_some() {
                        return;
                    }
                    match find_local(locals, name) {
                        Some(Local::Value(_)) => {}
                        Some(Local::Runtime) => problem = Some(Err(name.to_owned())),
                        None => problem = Some(Ok(name.to_owned())),
                    }
                });
                match problem {
                    Some(Ok(unknown)) => {
                        return Err(with_suggestion(
                            Diagnostic::new(
                                *span,
                                format!(
                                    "unknown reference `{unknown}` in the default for prop `{}`",
                                    declaration.name
                                ),
                            ),
                            &unknown,
                            &names,
                        ));
                    }
                    Some(Err(runtime)) => Some(Err(runtime)),
                    None => {
                        let lookup = |name: &str| match find_local(locals, name) {
                            Some(Local::Value(value)) => Some(value.clone()),
                            _ => None,
                        };
                        Some(Ok(expression
                            .evaluate(&lookup)
                            .map_err(|message| Diagnostic::new(*span, message))?))
                    }
                }
            }
        };
        let value = match (overrides.get(&declaration.name), &default) {
            (Some(value), Some(Ok(default))) => {
                if !same_type(default, value) {
                    return Err(Diagnostic::new(
                        declaration.span,
                        format!(
                            "prop `{}` must be {} (like its default), found {}",
                            declaration.name,
                            expression::type_name(default),
                            expression::type_name(value)
                        ),
                    ));
                }
                value.clone()
            }
            (Some(value), _) => value.clone(),
            (None, Some(Ok(default))) => default.clone(),
            (None, Some(Err(runtime))) => {
                return Err(Diagnostic::new(
                    declaration.span,
                    format!(
                        "the default for prop `{}` uses `{runtime}`, which only exists at runtime",
                        declaration.name
                    ),
                )
                .with_help(format!(
                    "pass `{}` with --props to render static HTML",
                    declaration.name
                )));
            }
            (None, None) => {
                return Err(Diagnostic::new(
                    declaration.span,
                    format!("missing required prop `{}`", declaration.name),
                ));
            }
        };
        props.push(Prop {
            name: declaration.name.clone(),
            attribute: kebab(&declaration.name),
            default: default.and_then(Result::ok),
            value,
        });
    }
    for name in overrides.keys() {
        if !props.iter().any(|prop| &prop.name == name) {
            let names: Vec<&str> = props.iter().map(|prop| prop.name.as_str()).collect();
            return Err(with_suggestion(
                Diagnostic::new(Span::new(1, 1), format!("unknown prop `{name}`")),
                name,
                &names,
            ));
        }
    }
    Ok(props)
}

fn same_type(default: &Value, value: &Value) -> bool {
    default.is_null() || std::mem::discriminant(default) == std::mem::discriminant(value)
}

fn kebab(name: &str) -> String {
    let mut output = String::new();
    for character in name.chars() {
        if character.is_ascii_uppercase() {
            output.push('-');
            output.push(character.to_ascii_lowercase());
        } else {
            output.push(character);
        }
    }
    output
}

/// How a prop value is written on the host so a runtime can pick it up again
/// (the same encoding the element parses: JSON for arrays/objects).
fn host_attribute(prop: &Prop) -> Option<String> {
    match &prop.value {
        Value::Null => None,
        Value::Bool(true) => Some(String::new()),
        // Absent means the default; only a default-true boolean needs an explicit "false".
        Value::Bool(false) => (prop.default == Some(Value::Bool(true))).then(|| "false".to_owned()),
        Value::String(text) => Some(text.clone()),
        Value::Number(_) => expression::to_display_string(&prop.value).ok(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(&prop.value).ok(),
    }
}

// ---- 2. resolve / 3. lower -----------------------------------------------------------------

struct Context<'a> {
    locals: &'a [(String, Local)],
    props: &'a [Prop],
    slot_values: &'a HashMap<String, Vec<ast::Node>>,
}

#[derive(Default)]
struct LowerState {
    /// Loop variables, innermost last.
    scopes: Vec<Vec<(String, Value)>>,
    active_slots: HashSet<String>,
}

enum Binding<'v> {
    Value(&'v Value),
    Runtime,
}

impl Context<'_> {
    fn names_in_scope<'s>(&'s self, scopes: &'s [Vec<String>]) -> Vec<&'s str> {
        scopes
            .iter()
            .flatten()
            .map(String::as_str)
            .chain(self.props.iter().map(|prop| prop.name.as_str()))
            .chain(self.locals.iter().map(|(name, _)| name.as_str()))
            .collect()
    }

    fn resolve_expression(
        &self,
        expression: &Expression,
        span: Span,
        scopes: &[Vec<String>],
    ) -> Result<(), Diagnostic> {
        let mut unknown = None;
        expression.for_each_identifier(&mut |name| {
            if unknown.is_none() && !self.names_in_scope(scopes).contains(&name) {
                unknown = Some(name.to_owned());
            }
        });
        match unknown {
            None => Ok(()),
            Some(name) => Err(with_suggestion(
                Diagnostic::new(span, format!("unknown reference `{name}`")),
                &name,
                &self.names_in_scope(scopes),
            )),
        }
    }

    fn resolve_parts(&self, parts: &[AstPart], scopes: &[Vec<String>]) -> Result<(), Diagnostic> {
        for part in parts {
            if let AstPart::Expression { expression, span } = part {
                self.resolve_expression(expression, *span, scopes)?;
            }
        }
        Ok(())
    }

    fn resolve_nodes(
        &self,
        nodes: &[ast::Node],
        scopes: &mut Vec<Vec<String>>,
    ) -> Result<(), Diagnostic> {
        for node in nodes {
            match node {
                ast::Node::Text(parts) => self.resolve_parts(parts, scopes)?,
                ast::Node::Element(element) => {
                    for attribute in &element.attributes {
                        match &attribute.value {
                            AttributeValue::None => {}
                            AttributeValue::Text(parts) => self.resolve_parts(parts, scopes)?,
                            AttributeValue::Expression(expression, span) => {
                                self.resolve_expression(expression, *span, scopes)?;
                            }
                        }
                        check_attribute_statically(attribute)?;
                    }
                    self.resolve_nodes(&element.children, scopes)?;
                }
                ast::Node::If {
                    test,
                    test_span,
                    consequent,
                    alternate,
                    ..
                } => {
                    self.resolve_expression(test, *test_span, scopes)?;
                    self.resolve_nodes(consequent, scopes)?;
                    self.resolve_nodes(alternate, scopes)?;
                }
                ast::Node::Each {
                    items,
                    items_span,
                    item,
                    index,
                    children,
                    ..
                } => {
                    self.resolve_expression(items, *items_span, scopes)?;
                    scopes.push(std::iter::once(item.clone()).chain(index.clone()).collect());
                    let result = self.resolve_nodes(children, scopes);
                    scopes.pop();
                    result?;
                }
                ast::Node::Slot { fallback, .. } => self.resolve_nodes(fallback, scopes)?,
                ast::Node::Else { span, .. } => {
                    return Err(Diagnostic::new(
                        *span,
                        "mnx-else is only valid as a direct child of mnx-if",
                    ));
                }
            }
        }
        Ok(())
    }

    fn binding<'s>(&'s self, name: &str, state: &'s LowerState) -> Option<Binding<'s>> {
        for scope in state.scopes.iter().rev() {
            if let Some((_, value)) = scope.iter().rev().find(|(local, _)| local == name) {
                return Some(Binding::Value(value));
            }
        }
        if let Some(prop) = self.props.iter().find(|prop| prop.name == name) {
            return Some(Binding::Value(&prop.value));
        }
        find_local(self.locals, name).map(|local| match local {
            Local::Value(value) => Binding::Value(value),
            Local::Runtime => Binding::Runtime,
        })
    }

    fn evaluate(
        &self,
        expression: &Expression,
        span: Span,
        state: &LowerState,
    ) -> Result<Value, Diagnostic> {
        let mut runtime = None;
        expression.for_each_identifier(&mut |name| {
            if runtime.is_none() && matches!(self.binding(name, state), Some(Binding::Runtime)) {
                runtime = Some(name.to_owned());
            }
        });
        if let Some(name) = runtime {
            return Err(Diagnostic::new(
                span,
                format!("`{name}` only exists at runtime, so it can't be rendered into static HTML"),
            )
            .with_help("render this component with the JavaScript output (v0.4+), or compute the value as a build-time const"));
        }
        let lookup = |name: &str| match self.binding(name, state) {
            Some(Binding::Value(value)) => Some(value.clone()),
            _ => None,
        };
        expression
            .evaluate(&lookup)
            .map_err(|message| Diagnostic::new(span, message))
    }

    fn lower_parts(&self, parts: &[AstPart], state: &LowerState) -> Result<Vec<Part>, Diagnostic> {
        parts
            .iter()
            .map(|part| match part {
                AstPart::Literal(text) => Ok(Part::Literal(text.clone())),
                AstPart::Expression { expression, span } => {
                    let value = self.evaluate(expression, *span, state)?;
                    expression::to_display_string(&value)
                        .map(Part::Escaped)
                        .map_err(|message| Diagnostic::new(*span, message))
                }
            })
            .collect()
    }

    fn lower_nodes(
        &self,
        nodes: &[ast::Node],
        state: &mut LowerState,
    ) -> Result<Vec<Node>, Diagnostic> {
        let mut output = Vec::new();
        for node in nodes {
            output.extend(self.lower_node(node, state)?);
        }
        Ok(output)
    }

    fn lower_node(
        &self,
        node: &ast::Node,
        state: &mut LowerState,
    ) -> Result<Vec<Node>, Diagnostic> {
        match node {
            ast::Node::Text(parts) => Ok(vec![Node::Text(self.lower_parts(parts, state)?)]),
            ast::Node::Element(element) => {
                let mut attributes = Vec::with_capacity(element.attributes.len());
                for attribute in &element.attributes {
                    if let Some(lowered) = self.lower_attribute(attribute, state)? {
                        attributes.push(lowered);
                    }
                }
                Ok(vec![Node::Element(ir::Element {
                    name: element.name.clone(),
                    attributes,
                    children: self.lower_nodes(&element.children, state)?,
                })])
            }
            ast::Node::If {
                test,
                test_span,
                consequent,
                alternate,
                ..
            } => {
                let value = self.evaluate(test, *test_span, state)?;
                self.lower_nodes(
                    if expression::is_truthy(&value) {
                        consequent
                    } else {
                        alternate
                    },
                    state,
                )
            }
            ast::Node::Each {
                items,
                items_span,
                item,
                index,
                children,
                ..
            } => {
                let value = self.evaluate(items, *items_span, state)?;
                let Value::Array(list) = value else {
                    return Err(Diagnostic::new(
                        *items_span,
                        format!(
                            "mnx-each items must be an array, found {}",
                            expression::type_name(&value)
                        ),
                    ));
                };
                let mut output = Vec::new();
                for (position, entry) in list.into_iter().enumerate() {
                    let mut scope = vec![(item.clone(), entry)];
                    if let Some(index) = index {
                        scope.push((index.clone(), Value::from(position)));
                    }
                    state.scopes.push(scope);
                    let lowered = self.lower_nodes(children, state);
                    state.scopes.pop();
                    output.extend(lowered?);
                }
                Ok(output)
            }
            ast::Node::Slot {
                name,
                fallback,
                span,
            } => {
                if !state.active_slots.insert(name.clone()) {
                    return Err(Diagnostic::new(
                        *span,
                        format!("recursive slot expansion for `{name}`"),
                    ));
                }
                let output = match self.slot_values.get(name) {
                    Some(nodes) => self.lower_nodes(nodes, state),
                    None => self.lower_nodes(fallback, state),
                };
                state.active_slots.remove(name);
                output
            }
            ast::Node::Else { span, .. } => Err(Diagnostic::new(
                *span,
                "mnx-else is only valid as a direct child of mnx-if",
            )),
        }
    }

    fn lower_attribute(
        &self,
        attribute: &ast::Attribute,
        state: &LowerState,
    ) -> Result<Option<ir::Attribute>, Diagnostic> {
        let lower = attribute.name.to_ascii_lowercase();
        let is_boolean = BOOLEAN_ATTRIBUTES.contains(&lower.as_str());
        let is_url = URL_ATTRIBUTES.contains(&lower.as_str());
        let value = match &attribute.value {
            AttributeValue::None => None,
            AttributeValue::Text(parts) => {
                let lowered = self.lower_parts(parts, state)?;
                let dynamic = parts
                    .iter()
                    .any(|part| matches!(part, AstPart::Expression { .. }));
                if is_url && dynamic {
                    check_url(attribute, &joined(&lowered))?;
                }
                Some(lowered)
            }
            AttributeValue::Expression(expression, span) => {
                let value = self.evaluate(expression, *span, state)?;
                if is_boolean {
                    return match value {
                        Value::Bool(true) => Ok(Some(ir::Attribute { name: attribute.name.clone(), value: None })),
                        Value::Bool(false) => Ok(None),
                        other => Err(Diagnostic::new(
                            *span,
                            format!(
                                "`{}` is a boolean attribute, so {{…}} must be true or false (found {})",
                                attribute.name,
                                expression::type_name(&other)
                            ),
                        )),
                    };
                }
                if value.is_null() {
                    return Ok(None);
                }
                let text = expression::to_display_string(&value)
                    .map_err(|message| Diagnostic::new(*span, message))?;
                if is_url {
                    check_url(attribute, &text)?;
                }
                Some(vec![Part::Escaped(text)])
            }
        };
        Ok(Some(ir::Attribute {
            name: attribute.name.clone(),
            value,
        }))
    }
}

fn joined(parts: &[Part]) -> String {
    parts
        .iter()
        .map(|part| match part {
            Part::Literal(text) => html_escape::decode_html_entities(text).into_owned(),
            Part::Escaped(text) => text.clone(),
        })
        .collect()
}

/// Checks that don't depend on values, applied to every branch.
fn check_attribute_statically(attribute: &ast::Attribute) -> Result<(), Diagnostic> {
    let lower = attribute.name.to_ascii_lowercase();
    let dynamic_text = matches!(&attribute.value, AttributeValue::Text(parts)
        if parts.iter().any(|part| matches!(part, AstPart::Expression { .. })));
    let dynamic = dynamic_text || matches!(attribute.value, AttributeValue::Expression(..));
    if lower == "srcdoc" && dynamic {
        return Err(Diagnostic::new(
            attribute.span,
            "interpolation in srcdoc is not supported",
        ));
    }
    if lower == "srcset" {
        if dynamic {
            return Err(Diagnostic::new(
                attribute.span,
                "dynamic srcset is not supported yet",
            ));
        }
        return validate_srcset(attribute);
    }
    if BOOLEAN_ATTRIBUTES.contains(&lower.as_str()) && dynamic_text {
        return Err(Diagnostic::new(
            attribute.span,
            format!(
                "`{}` is a boolean attribute; bind it with {}={{…}} instead of quoted text",
                attribute.name, attribute.name
            ),
        ));
    }
    if URL_ATTRIBUTES.contains(&lower.as_str()) {
        match &attribute.value {
            AttributeValue::None => {
                return Err(Diagnostic::new(
                    attribute.span,
                    format!("URL attribute `{}` requires a value", attribute.name),
                ));
            }
            AttributeValue::Text(parts) if !dynamic_text => {
                let text: String = parts
                    .iter()
                    .map(|part| match part {
                        AstPart::Literal(text) => text.as_str(),
                        AstPart::Expression { .. } => "",
                    })
                    .collect();
                if !is_safe_url(&text) {
                    return Err(Diagnostic::new(
                        attribute.span,
                        format!("unsafe URL in `{}` attribute", attribute.name),
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn check_url(attribute: &ast::Attribute, value: &str) -> Result<(), Diagnostic> {
    if is_safe_url(value) {
        Ok(())
    } else {
        Err(Diagnostic::new(
            attribute.span,
            format!("unsafe URL in `{}` attribute", attribute.name),
        )
        .with_help("allowed: relative URLs, http:, https:, mailto: and tel:"))
    }
}

fn validate_srcset(attribute: &ast::Attribute) -> Result<(), Diagnostic> {
    let AttributeValue::Text(parts) = &attribute.value else {
        return Err(Diagnostic::new(
            attribute.span,
            "srcset requires a list of safe URL candidates",
        ));
    };
    let source: String = parts
        .iter()
        .map(|part| match part {
            AstPart::Literal(text) => text.as_str(),
            AstPart::Expression { .. } => "",
        })
        .collect();
    let candidates = source.split(',').collect::<Vec<_>>();
    if candidates.iter().any(|candidate| {
        candidate
            .split_whitespace()
            .next()
            .is_none_or(|url| !is_safe_url(url))
    }) {
        return Err(Diagnostic::new(
            attribute.span,
            "srcset contains an unsafe or empty URL candidate",
        ));
    }
    Ok(())
}

fn collect_slots(nodes: &[ast::Node], slots: &mut HashSet<String>) {
    for node in nodes {
        match node {
            ast::Node::Element(element) => collect_slots(&element.children, slots),
            ast::Node::If {
                consequent,
                alternate,
                ..
            } => {
                collect_slots(consequent, slots);
                collect_slots(alternate, slots);
            }
            ast::Node::Each { children, .. } | ast::Node::Else { children, .. } => {
                collect_slots(children, slots)
            }
            ast::Node::Slot { name, fallback, .. } => {
                slots.insert(name.clone());
                collect_slots(fallback, slots);
            }
            ast::Node::Text(_) => {}
        }
    }
}

fn check_single_root(nodes: &[Node]) -> Result<(), Diagnostic> {
    let element_roots = nodes
        .iter()
        .filter(|node| matches!(node, Node::Element(_)))
        .count();
    let has_text = nodes.iter().any(|node| match node {
        Node::Text(parts) => parts.iter().any(|part| match part {
            Part::Literal(text) | Part::Escaped(text) => !text.trim().is_empty(),
        }),
        Node::Element(_) => false,
    });
    if element_roots != 1 || has_text {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            "a component's template must have exactly one root element",
        ));
    }
    Ok(())
}

fn validate_custom_element(tag: &str, span: Span) -> Result<(), Diagnostic> {
    let valid = tag.contains('-')
        && !tag.starts_with("xml")
        && tag
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && tag.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
        });
    if !valid || RESERVED_CUSTOM_ELEMENTS.contains(&tag) {
        let mut diagnostic =
            Diagnostic::new(span, format!("`{tag}` is not a valid custom-element name"));
        if !tag.contains('-') {
            diagnostic = diagnostic.with_help(format!(
                "custom element names need a hyphen, e.g. `{}-element`",
                tag.to_ascii_lowercase()
            ));
        }
        return Err(diagnostic);
    }
    Ok(())
}

pub fn is_safe_url(value: &str) -> bool {
    let value = html_escape::decode_html_entities(value);
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) || value.starts_with("//") {
        return false;
    }
    let before_path = value.split(['/', '?', '#']).next().unwrap_or_default();
    if let Some((scheme, _)) = before_path.split_once(':') {
        return matches!(
            scheme.to_ascii_lowercase().as_str(),
            "http" | "https" | "mailto" | "tel"
        );
    }
    true
}

// ---- suggestions ---------------------------------------------------------------------------

fn with_suggestion(diagnostic: Diagnostic, name: &str, candidates: &[&str]) -> Diagnostic {
    let best = candidates
        .iter()
        .filter(|candidate| **candidate != name)
        .map(|candidate| (edit_distance(name, candidate), *candidate))
        .filter(|(distance, candidate)| *distance <= (candidate.len().max(name.len()) / 3).max(1))
        .min();
    match best {
        Some((_, candidate)) => diagnostic.with_help(format!("did you mean `{candidate}`?")),
        None => diagnostic,
    }
}

/// Edit distance counting an adjacent swap as one edit (`nmae` → `name`), the commonest typo.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut table = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in table.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in table[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (table[i - 1][j] + 1)
                .min(table[i][j - 1] + 1)
                .min(table[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(table[i - 2][j - 2] + 1);
            }
            table[i][j] = best;
        }
    }
    table[a.len()][b.len()]
}
