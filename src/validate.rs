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

pub(crate) const URL_ATTRIBUTES: &[&str] = &[
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
pub(crate) const BOOLEAN_ATTRIBUTES: &[&str] = &[
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
    /// Partial rendering: the value is computed in the browser.
    unknown: bool,
}

thread_local! {
    /// Partial rendering: what only the browser can compute is left for it (see
    /// [`validate_partial`]).
    static PARTIAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn partial() -> bool {
    PARTIAL.with(std::cell::Cell::get)
}

/// Like [`validate`], but what only the browser can compute (runtime-only values, JavaScript
/// expressions, defaults computed in the browser) is left for the element instead of being an
/// error: text renders empty, attributes are left out, and conditionals and lists render as
/// empty regions marked `<!--[?-->`, which the element fills when it starts.
pub fn validate_partial(
    component: ast::ComponentAst,
    values: &Value,
    slot_values: &HashMap<String, Vec<ast::Node>>,
) -> Result<ir::Component, Diagnostic> {
    let previous = PARTIAL.with(|flag| flag.replace(true));
    let result = validate(component, values, slot_values);
    PARTIAL.with(|flag| flag.set(previous));
    result
}

pub fn validate(
    component: ast::ComponentAst,
    values: &Value,
    slot_values: &HashMap<String, Vec<ast::Node>>,
) -> Result<ir::Component, Diagnostic> {
    let overrides = values
        .as_object()
        .ok_or_else(|| Diagnostic::new(Span::new(1, 1), "component props must be a JSON object"))?;
    lower_component(&component, overrides, &Supply::Templates(slot_values))
}

/// Content supplied to a component's slots: template fragments (`--slots`), lowered in the
/// component's own scope, or nodes a parent component already lowered in *its* scope.
enum Supply<'a> {
    Templates(&'a HashMap<String, Vec<ast::Node>>),
    Lowered(HashMap<String, Vec<Node>>),
}

impl Supply<'_> {
    fn names(&self) -> Vec<&String> {
        match self {
            Supply::Templates(map) => map.keys().collect(),
            Supply::Lowered(map) => map.keys().collect(),
        }
    }
}

fn lower_component(
    component: &ast::ComponentAst,
    overrides: &serde_json::Map<String, Value>,
    supply: &Supply<'_>,
) -> Result<ir::Component, Diagnostic> {
    validate_custom_element(&component.tag, component.tag_span)?;

    let locals = evaluate_script(&component.script)?;
    let props = evaluate_props(component, &locals, overrides)?;

    let context = Context {
        component,
        locals: &locals,
        props: &props,
        supply,
        shadow: component.shadow,
    };

    // 2. Resolve everything, including branches and slots this build won't render.
    let mut declared_slots = HashSet::new();
    collect_slots(&component.nodes, &mut declared_slots);
    for name in supply.names() {
        if !declared_slots.contains(name) {
            return Err(Diagnostic::new(
                Span::new(1, 1),
                format!("slot `{name}` is not declared by this component"),
            ));
        }
    }
    let mut scopes = Vec::new();
    context.resolve_nodes(&component.nodes, &mut scopes)?;
    if let Supply::Templates(templates) = supply {
        for nodes in templates.values() {
            context.resolve_nodes(nodes, &mut scopes)?;
        }
    }

    // 3. Lower the branches that are taken.
    let mut state = LowerState::default();
    let mut nodes = context.lower_nodes(&component.nodes, &mut state)?;
    // A shadow component's styles go in its declarative shadow root (nothing else can style it
    // before its JavaScript runs); a light-DOM component's go in the page (`--emit css`).
    if let Some(style) = &component.style {
        if let Some(lang) = &style.lang {
            return Err(Diagnostic::new(
                style.span,
                format!("`<style lang=\"{lang}\">` needs a bundler to compile it: use @mnx/unplugin (Vite)"),
            ));
        }
        if component.shadow {
            let css = crate::styles::stylesheet(component).unwrap_or_default();
            nodes.insert(
                0,
                Node::Element(ir::Element {
                    name: "style".to_owned(),
                    attributes: vec![ir::Attribute {
                        name: "data-mnx".to_owned(),
                        value: None,
                    }],
                    children: vec![Node::Text(vec![Part::Literal(css)])],
                }),
            );
        }
    }
    let light_children = std::mem::take(&mut state.light);

    let host_attributes = props
        .iter()
        .filter(|prop| !prop.unknown && prop.default.as_ref() != Some(&prop.value))
        .filter_map(|prop| host_attribute(prop).map(|value| (prop.attribute.clone(), value)))
        .collect();

    Ok(ir::Component {
        tag: component.tag.clone(),
        shadow: component.shadow,
        host_attributes,
        nodes,
        light_children,
    })
}

/// What the JavaScript backend needs: the prop interface and the script's names, after the
/// same script evaluation and resolver checks the HTML backend runs.
pub struct Interface {
    pub props: Vec<PropInterface>,
    /// The events the component fires (see [`crate::events`]).
    pub events: Vec<crate::events::EventInterface>,
    /// The description comment without its `@fires` lines.
    pub description: Option<String>,
    /// Every name the script declares (build-time and runtime-only).
    pub script_names: Vec<String>,
}

pub struct PropInterface {
    pub name: String,
    /// The TypeScript type, when the default is an annotated binding (`<script lang="ts">`).
    pub declared: Option<String>,
    pub attribute: String,
    /// `None` for a required prop, or one whose default is only known at runtime.
    pub default: Option<Value>,
    /// A default computed in the browser (it uses script names that only exist there).
    pub runtime_default: Option<expression::Expression>,
}

impl PropInterface {
    pub fn required(&self) -> bool {
        self.default.is_none() && self.runtime_default.is_none()
    }
}

pub fn analyze(component: &ast::ComponentAst) -> Result<Interface, Diagnostic> {
    validate_custom_element(&component.tag, component.tag_span)?;
    let locals = evaluate_script(&component.script)?;
    let mut props = Vec::new();
    let mut runtime_defaults = HashSet::new();
    for declaration in &component.props {
        if props
            .iter()
            .any(|prop: &Prop| prop.name == declaration.name)
        {
            return Err(Diagnostic::new(
                declaration.span,
                format!("duplicate prop `{}`", declaration.name),
            ));
        }
        let default = match prop_default(declaration, &locals)? {
            None => None,
            Some(Ok(value)) => Some(value),
            // Computed in the browser, per element, after the script runs.
            Some(Err(_)) => {
                runtime_defaults.insert(declaration.name.clone());
                None
            }
        };
        props.push(Prop {
            name: declaration.name.clone(),
            attribute: kebab(&declaration.name),
            value: default.clone().unwrap_or(Value::Null),
            default,
            unknown: false,
        });
    }
    let templates = HashMap::new();
    let supply = Supply::Templates(&templates);
    let context = Context {
        component,
        locals: &locals,
        props: &props,
        supply: &supply,
        shadow: component.shadow,
    };
    context.resolve_nodes(&component.nodes, &mut Vec::new())?;
    let (events, description) = crate::events::events(component)?;
    Ok(Interface {
        events,
        description,
        props: props
            .into_iter()
            .map(|prop| {
                // `value={initial}` where `const initial: Value = …`: the prop has that type.
                let declared = component
                    .props
                    .iter()
                    .find(|declaration| declaration.name == prop.name)
                    .and_then(|declaration| match &declaration.default {
                        PropDefault::Expression(expression::Expression::Identifier(name), _) => {
                            component.script.declared_types.get(name).cloned()
                        }
                        _ => None,
                    });
                let runtime_default = runtime_defaults
                    .contains(&prop.name)
                    .then(|| {
                        component
                            .props
                            .iter()
                            .find(|declaration| declaration.name == prop.name)
                            .and_then(|declaration| match &declaration.default {
                                PropDefault::Expression(expression, _) => Some(expression.clone()),
                                _ => None,
                            })
                    })
                    .flatten();
                PropInterface {
                    name: prop.name,
                    declared,
                    attribute: prop.attribute,
                    default: prop.default,
                    runtime_default,
                }
            })
            .collect(),
        script_names: locals.into_iter().map(|(name, _)| name).collect(),
    })
}

/// Dynamic text that shares its parent with other nodes, or sits directly inside an `mnx-if`
/// branch or `mnx-each` row (which has no element of its own), gets an empty-comment anchor
/// before it in both backends, so the JavaScript side can find it in server-rendered markup.
/// Text that is an element's only child is bound through the element and needs no anchor.
pub(crate) fn needs_text_anchor(siblings: &[ast::Node], node: &ast::Node, block_top: bool) -> bool {
    (block_top || siblings.len() > 1)
        && matches!(node, ast::Node::Text(parts) if parts.iter().any(|part| matches!(part, AstPart::Expression { .. })))
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
                    // The browser's globals exist only at runtime.
                    None if RUNTIME_GLOBALS.contains(&name) => runtime = true,
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
        let default = prop_default(declaration, locals)?;
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
            (None, Some(Err(_))) if partial() => Value::Null,
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
        let unknown = !overrides.contains_key(&declaration.name) && matches!(default, Some(Err(_)));
        props.push(Prop {
            name: declaration.name.clone(),
            attribute: kebab(&declaration.name),
            default: default.and_then(Result::ok),
            value,
            unknown,
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

/// A prop's default: `None` if required, `Some(Err(name))` if it depends on a runtime-only
/// script name, `Some(Ok(value))` otherwise.
fn prop_default(
    declaration: &ast::PropDecl,
    locals: &[(String, Local)],
) -> Result<Option<Result<Value, String>>, Diagnostic> {
    Ok(match &declaration.default {
        PropDefault::Required => None,
        PropDefault::Text(text) => Some(Ok(Value::String(text.clone()))),
        PropDefault::Expression(expression, span) => {
            let names: Vec<&str> = locals.iter().map(|(name, _)| name.as_str()).collect();
            let mut problem = None;
            let runtime = expression.is_runtime();
            expression.for_each_identifier(&mut |name| {
                if problem.is_some() {
                    return;
                }
                match find_local(locals, name) {
                    Some(Local::Value(_)) => {}
                    Some(Local::Runtime) => problem = Some(Err(name.to_owned())),
                    None if runtime && RUNTIME_GLOBALS.contains(&name) => {}
                    None => problem = Some(Ok(name.to_owned())),
                }
            });
            // A runtime expression (`{Date.now()}`) is computed in the browser, like a default
            // that uses a runtime-only script value.
            if runtime && problem.is_none() {
                let text = expression.to_js_with(&|name| name.to_owned());
                problem = Some(Err(text[1..text.len() - 1].to_owned()));
            }
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
    })
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
    component: &'a ast::ComponentAst,
    locals: &'a [(String, Local)],
    props: &'a [Prop],
    supply: &'a Supply<'a>,
    /// Shadow-DOM components use native `<slot>` elements.
    shadow: bool,
}

#[derive(Default)]
struct LowerState {
    /// Shadow-DOM components: supplied slot content, rendered as the host's light-DOM children.
    light: Vec<Node>,
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
        let runtime = expression.is_runtime();
        expression.for_each_identifier(&mut |name| {
            // A runtime expression may use the browser's globals, as a script may.
            let global = runtime && (RUNTIME_GLOBALS.contains(&name) || name == "undefined");
            if unknown.is_none() && !global && !self.names_in_scope(scopes).contains(&name) {
                unknown = Some(name.to_owned());
            }
        });
        for name in expression.written_names() {
            let prop = self.props.iter().any(|prop| prop.name == name);
            let looped = scopes.iter().flatten().any(|scope| scope == name);
            if looped || !prop {
                return Err(Diagnostic::new(
                    span,
                    format!("`{name}` can't be assigned here: a template can assign to props only"),
                )
                .with_help(if looped {
                    "a list item is read-only; change the list instead".to_owned()
                } else {
                    format!("call a function from <script> that updates `{name}` (e.g. `{name}.set(…)` on a state())")
                }));
            }
        }
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
                    key,
                    children,
                    ..
                } => {
                    self.resolve_expression(items, *items_span, scopes)?;
                    scopes.push(std::iter::once(item.clone()).chain(index.clone()).collect());
                    let result = match key {
                        Some((key, key_span)) => self.resolve_expression(key, *key_span, scopes),
                        None => Ok(()),
                    }
                    .and_then(|()| self.resolve_nodes(children, scopes));
                    scopes.pop();
                    result?;
                }
                ast::Node::Slot { fallback, span, .. } => {
                    if !scopes.is_empty() {
                        return Err(Diagnostic::new(
                            *span,
                            "mnx-slot can't be inside mnx-each: slotted content can only be in one place",
                        ));
                    }
                    self.resolve_nodes(fallback, scopes)?;
                }
                ast::Node::Else { span, .. } => {
                    return Err(Diagnostic::new(
                        *span,
                        "mnx-else is only valid as a direct child of mnx-if",
                    ));
                }
                ast::Node::Await {
                    value,
                    value_span,
                    pending,
                    then,
                    catch,
                    ..
                } => {
                    self.resolve_expression(value, *value_span, scopes)?;
                    self.resolve_nodes(pending, scopes)?;
                    for branch in then.iter().chain(catch) {
                        scopes.push(branch.name.iter().cloned().collect());
                        let result = self.resolve_nodes(&branch.children, scopes);
                        scopes.pop();
                        result?;
                    }
                }
                ast::Node::Settled { caught, branch } => {
                    return Err(Diagnostic::new(
                        branch.span,
                        format!(
                            "mnx-{} is only valid as a direct child of mnx-await",
                            if *caught { "catch" } else { "then" }
                        ),
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
            if prop.unknown {
                return Some(Binding::Runtime);
            }
            return Some(Binding::Value(&prop.value));
        }
        find_local(self.locals, name).map(|local| match local {
            Local::Value(value) => Binding::Value(value),
            Local::Runtime => Binding::Runtime,
        })
    }

    /// [`Self::evaluate`], or `None` when rendering partially and only the browser can compute
    /// the value.
    fn evaluate_known(
        &self,
        expression: &Expression,
        span: Span,
        state: &LowerState,
    ) -> Result<Option<Value>, Diagnostic> {
        if partial() {
            let mut runtime = expression.is_runtime();
            expression.for_each_identifier(&mut |name| {
                runtime |= matches!(self.binding(name, state), Some(Binding::Runtime));
            });
            if runtime {
                return Ok(None);
            }
        }
        self.evaluate(expression, span, state).map(Some)
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

    /// Text with its values; partially rendered text the browser fills in is empty.
    fn lower_parts(&self, parts: &[AstPart], state: &LowerState) -> Result<Vec<Part>, Diagnostic> {
        Ok(self
            .lower_known_parts(parts, state)?
            .unwrap_or_else(|| vec![Part::Escaped(String::new())]))
    }

    /// Text with its values, or `None` when one is computed in the browser.
    fn lower_known_parts(
        &self,
        parts: &[AstPart],
        state: &LowerState,
    ) -> Result<Option<Vec<Part>>, Diagnostic> {
        let mut lowered = Vec::new();
        for part in parts {
            match part {
                AstPart::Literal(text) => lowered.push(Part::Literal(text.clone())),
                AstPart::Expression { expression, span } => {
                    let Some(value) = self.evaluate_known(expression, *span, state)? else {
                        return Ok(None);
                    };
                    lowered.push(
                        expression::to_display_string(&value)
                            .map(Part::Escaped)
                            .map_err(|message| Diagnostic::new(*span, message))?,
                    );
                }
            }
        }
        Ok(Some(lowered))
    }

    fn lower_nodes(
        &self,
        nodes: &[ast::Node],
        state: &mut LowerState,
    ) -> Result<Vec<Node>, Diagnostic> {
        self.lower_block(nodes, state, false)
    }

    /// `block_top`: these nodes are the top level of an `mnx-if` branch or `mnx-each` row.
    fn lower_block(
        &self,
        nodes: &[ast::Node],
        state: &mut LowerState,
        block_top: bool,
    ) -> Result<Vec<Node>, Diagnostic> {
        let mut output = Vec::new();
        for node in nodes {
            if needs_text_anchor(nodes, node, block_top) {
                output.push(Node::Anchor);
            }
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
                if let Some(child) = self.component.child(&element.name) {
                    return Ok(vec![self.lower_child(element, child, state)?]);
                }
                let custom = element.name.contains('-');
                let mut attributes = Vec::with_capacity(element.attributes.len());
                for attribute in &element.attributes {
                    if let Some(lowered) = self.lower_attribute(attribute, state, custom)? {
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
                let Some(value) = self.evaluate_known(test, *test_span, state)? else {
                    return Ok(vec![Node::OpenClient, Node::Close]);
                };
                let branch = if expression::is_truthy(&value) {
                    consequent
                } else {
                    alternate
                };
                // Region markers let the JavaScript side find (and later replace) the branch.
                let mut output = vec![Node::Open];
                output.extend(self.lower_block(branch, state, true)?);
                output.push(Node::Close);
                Ok(output)
            }
            ast::Node::Each {
                items,
                items_span,
                item,
                index,
                key,
                children,
                ..
            } => {
                let Some(value) = self.evaluate_known(items, *items_span, state)? else {
                    return Ok(vec![Node::OpenClient, Node::Close]);
                };
                let Value::Array(list) = value else {
                    return Err(Diagnostic::new(
                        *items_span,
                        format!(
                            "mnx-each items must be an array, found {}",
                            expression::type_name(&value)
                        ),
                    ));
                };
                // A region for the list, and one per row.
                let mut output = vec![Node::Open];
                let mut keys = HashSet::new();
                for (position, entry) in list.into_iter().enumerate() {
                    let mut scope = vec![(item.clone(), entry)];
                    if let Some(index) = index {
                        scope.push((index.clone(), Value::from(position)));
                    }
                    state.scopes.push(scope);
                    if let Some((key, key_span)) = key {
                        let checked = self.evaluate_known(key, *key_span, state).and_then(
                            |value| match value {
                                // Computed in the browser, which checks it there.
                                None => Ok(()),
                                Some(value @ (Value::String(_) | Value::Number(_))) => {
                                    if keys.insert(value.to_string()) {
                                        Ok(())
                                    } else {
                                        Err(Diagnostic::new(
                                            *key_span,
                                            format!(
                                                "duplicate mnx-each key {value} (row {})",
                                                position + 1
                                            ),
                                        ))
                                    }
                                }
                                Some(other) => Err(Diagnostic::new(
                                    *key_span,
                                    format!(
                                        "mnx-each key must be a string or number, found {}",
                                        expression::type_name(&other)
                                    ),
                                )),
                            },
                        );
                        if let Err(error) = checked {
                            state.scopes.pop();
                            return Err(error);
                        }
                    }
                    let lowered = self.lower_block(children, state, true);
                    state.scopes.pop();
                    output.push(Node::Open);
                    output.extend(lowered?);
                    output.push(Node::Close);
                }
                output.push(Node::Close);
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
                // Supplied content, lowered: templates in this component's scope (as a block),
                // or nodes the parent already lowered in its own.
                let supplied = match self.supply {
                    Supply::Templates(templates) => templates
                        .get(name)
                        .map(|nodes| self.lower_block(nodes, state, !self.shadow))
                        .transpose()?,
                    Supply::Lowered(lowered) => lowered.get(name).cloned(),
                };
                let output = if self.shadow {
                    // A native <slot>; supplied content goes in the host's light DOM.
                    let fallback = self.lower_nodes(fallback, state)?;
                    if let Some(lowered) = supplied {
                        state.light.extend(assign_to_slot(name, lowered, *span)?);
                    }
                    let attributes = if name == "default" {
                        Vec::new()
                    } else {
                        vec![ir::Attribute {
                            name: "name".to_owned(),
                            value: Some(vec![Part::Literal(name.clone())]),
                        }]
                    };
                    Ok(vec![Node::Element(ir::Element {
                        name: "slot".to_owned(),
                        attributes,
                        children: fallback,
                    })])
                } else {
                    // A region; `<!--[!-->` marks supplied content, which stays static, as
                    // opposed to fallback content, which the JavaScript side binds.
                    let mut output = Vec::new();
                    match supplied {
                        Some(lowered) => {
                            output.push(Node::OpenProjected);
                            // A styled component's styles stop at what callers put in its slots.
                            let styled = self.component.style.is_some();
                            output.extend(lowered.into_iter().map(|node| match node {
                                Node::Element(mut element) if styled => {
                                    element.attributes.retain(|attribute| {
                                        attribute.name != crate::styles::SLOTTED
                                    });
                                    element.attributes.push(ir::Attribute {
                                        name: crate::styles::SLOTTED.to_owned(),
                                        value: Some(vec![Part::Literal(
                                            self.component.tag.clone(),
                                        )]),
                                    });
                                    Node::Element(element)
                                }
                                node => node,
                            }));
                        }
                        None => {
                            output.push(Node::Open);
                            output.extend(self.lower_block(fallback, state, true)?);
                        }
                    }
                    output.push(Node::Close);
                    Ok(output)
                };
                state.active_slots.remove(name);
                output
            }
            ast::Node::Else { span, .. } => Err(Diagnostic::new(
                *span,
                "mnx-else is only valid as a direct child of mnx-if",
            )),
            // The server can't wait for the value: it renders the pending content, which the
            // element replaces when the value settles.
            ast::Node::Await { pending, .. } => {
                let mut output = vec![Node::Open];
                output.extend(self.lower_block(pending, state, true)?);
                output.push(Node::Close);
                Ok(output)
            }
            ast::Node::Settled { caught, branch } => Err(Diagnostic::new(
                branch.span,
                format!(
                    "mnx-{} is only valid as a direct child of mnx-await",
                    if *caught { "catch" } else { "then" }
                ),
            )),
        }
    }

    /// A child component used in this template: rendered inline from its own definition, with
    /// props passed as values (type-checked against the child's defaults) and the element's
    /// content — lowered here, in this component's scope — as the child's slot content.
    fn lower_child(
        &self,
        element: &ast::Element,
        child: &ast::ChildComponent,
        state: &mut LowerState,
    ) -> Result<Node, Diagnostic> {
        let interface =
            analyze(&child.ast).map_err(|error| error.in_file(&child.path, &child.source))?;
        let mut overrides = serde_json::Map::new();
        let mut attributes = Vec::new();
        for attribute in &element.attributes {
            let prop_name = camel(&attribute.name);
            let lower = attribute.name.to_ascii_lowercase();
            check_child_event(&child.ast.tag, &interface, attribute)?;
            if let Some(prop) = interface.props.iter().find(|prop| prop.name == prop_name) {
                let (value, span) = match &attribute.value {
                    AttributeValue::None => (Value::Bool(true), attribute.span),
                    AttributeValue::Text(parts) => match self.lower_known_parts(parts, state)? {
                        Some(lowered) => (Value::String(joined(&lowered)), attribute.span),
                        None => continue, // the child renders its default; the parent sets it
                    },
                    AttributeValue::Expression(expression, span) => {
                        match self.evaluate_known(expression, *span, state)? {
                            Some(value) => (value, *span),
                            None => continue,
                        }
                    }
                };
                check_child_prop_type(&child.ast.tag, prop, &value, span)?;
                overrides.insert(prop.name.clone(), value);
            } else if matches!(attribute.value, AttributeValue::Expression(..))
                && !crate::parser::is_event_attribute(&lower)
                && !is_global_attribute(&lower)
            {
                return Err(unknown_child_prop(&child.ast.tag, &interface, attribute));
            } else if let Some(lowered) = self.lower_attribute(attribute, state, true)? {
                attributes.push(lowered);
            }
        }
        check_child_required(&child.ast.tag, &interface, element)?;
        for prop in &interface.props {
            if prop.runtime_default.is_some() && !overrides.contains_key(&prop.name) && !partial() {
                return Err(Diagnostic::new(
                    element.span,
                    format!(
                        "<{}> computes the default for `{}` in the browser; pass `{}` here to render it as HTML",
                        child.ast.tag, prop.attribute, prop.attribute
                    ),
                ));
            }
        }

        // The element's content becomes the child's slot content, grouped by `slot="…"`.
        let content = self.lower_block(&element.children, state, !child.ast.shadow)?;
        let mut declared = HashSet::new();
        collect_slots(&child.ast.nodes, &mut declared);
        let mut groups: HashMap<String, Vec<Node>> = HashMap::new();
        let mut depth = 0usize;
        let mut current = "default".to_owned();
        for node in content {
            if depth == 0 {
                current = match &node {
                    Node::Element(element) => element
                        .attributes
                        .iter()
                        .find(|attribute| attribute.name == "slot")
                        .and_then(|attribute| attribute.value.as_deref())
                        .map_or_else(|| "default".to_owned(), joined),
                    _ => "default".to_owned(),
                };
                if matches!(&node, Node::Text(parts) if parts.iter().all(|part| match part {
                    Part::Literal(text) | Part::Escaped(text) => text.trim().is_empty(),
                })) {
                    continue;
                }
            }
            match node {
                Node::Open | Node::OpenProjected => depth += 1,
                Node::Close => depth = depth.saturating_sub(1),
                _ => {}
            }
            if !declared.contains(&current) {
                return Err(Diagnostic::new(
                    element.span,
                    format!("<{}> has no slot named `{current}`", child.ast.tag),
                ));
            }
            groups.entry(current.clone()).or_default().push(node);
        }

        let rendered = lower_component(&child.ast, &overrides, &Supply::Lowered(groups))
            .map_err(|error| error.in_file(&child.path, &child.source))?;
        for (name, value) in rendered.host_attributes {
            attributes.push(ir::Attribute {
                name,
                value: (!value.is_empty()).then(|| vec![Part::Escaped(value)]),
            });
        }
        let children = if rendered.shadow {
            let mut children = vec![Node::Element(ir::Element {
                name: "template".to_owned(),
                attributes: vec![ir::Attribute {
                    name: "shadowrootmode".to_owned(),
                    value: Some(vec![Part::Literal("open".to_owned())]),
                }],
                children: rendered.nodes,
            })];
            children.extend(rendered.light_children);
            children
        } else {
            rendered.nodes
        };
        Ok(Node::Element(ir::Element {
            name: element.name.clone(),
            attributes,
            children,
        }))
    }

    fn lower_attribute(
        &self,
        attribute: &ast::Attribute,
        state: &LowerState,
        custom_element: bool,
    ) -> Result<Option<ir::Attribute>, Diagnostic> {
        let lower = attribute.name.to_ascii_lowercase();
        if crate::parser::is_event_attribute(&lower)
            && matches!(attribute.value, AttributeValue::Expression(..))
        {
            // Handlers are functions: they exist only in the JavaScript output. (A handler
            // written as text can only be in server-rendered slot HTML, which is kept.)
            return Ok(None);
        }
        let is_boolean = BOOLEAN_ATTRIBUTES.contains(&lower.as_str());
        let is_url = URL_ATTRIBUTES.contains(&lower.as_str());
        let value = match &attribute.value {
            AttributeValue::None => None,
            AttributeValue::Text(parts) => {
                let Some(lowered) = self.lower_known_parts(parts, state)? else {
                    return Ok(None); // set by the element
                };
                let dynamic = parts
                    .iter()
                    .any(|part| matches!(part, AstPart::Expression { .. }));
                if is_url && dynamic {
                    check_url(attribute, &joined(&lowered))?;
                }
                Some(lowered)
            }
            AttributeValue::Expression(expression, span) => {
                let Some(value) = self.evaluate_known(expression, *span, state)? else {
                    return Ok(None); // set by the element
                };
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
                // Custom elements take arrays and objects as JSON attributes.
                let text = match &value {
                    Value::Array(_) | Value::Object(_) if custom_element => {
                        serde_json::to_string(&value).expect("JSON serializes")
                    }
                    _ => expression::to_display_string(&value)
                        .map_err(|message| Diagnostic::new(*span, message))?,
                };
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

pub(crate) fn collect_slots(nodes: &[ast::Node], slots: &mut HashSet<String>) {
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
            ast::Node::Await {
                pending,
                then,
                catch,
                ..
            } => {
                collect_slots(pending, slots);
                for branch in then.iter().chain(catch) {
                    collect_slots(&branch.children, slots);
                }
            }
            ast::Node::Settled { branch, .. } => collect_slots(&branch.children, slots),
            ast::Node::Slot { name, fallback, .. } => {
                slots.insert(name.clone());
                collect_slots(fallback, slots);
            }
            ast::Node::Text(_) => {}
        }
    }
}

/// `max-value` → `maxValue`.
pub(crate) fn camel(name: &str) -> String {
    let mut output = String::new();
    let mut upper = false;
    for character in name.chars() {
        if character == '-' {
            upper = true;
        } else if upper {
            output.push(character.to_ascii_uppercase());
            upper = false;
        } else {
            output.push(character);
        }
    }
    output
}

/// Attributes any element may carry, which aren't component props.
pub(crate) fn is_global_attribute(name: &str) -> bool {
    matches!(
        name,
        "id" | "class"
            | "slot"
            | "part"
            | "exportparts"
            | "title"
            | "hidden"
            | "lang"
            | "dir"
            | "tabindex"
            | "role"
            | "inert"
            | "autofocus"
            | "nonce"
            | "draggable"
            | "translate"
            | "is"
            | "name"
    ) || name.starts_with("data-")
        || name.starts_with("aria-")
}

/// Content for a named slot of a shadow-DOM component: each top-level element gets
/// `slot="name"` so the browser projects it; top-level text can't be assigned to a named slot.
fn assign_to_slot(name: &str, nodes: Vec<Node>, span: Span) -> Result<Vec<Node>, Diagnostic> {
    if name == "default" {
        return Ok(nodes);
    }
    nodes
        .into_iter()
        .map(|node| match node {
            Node::Element(mut element) => {
                element
                    .attributes
                    .retain(|attribute| attribute.name != "slot");
                element.attributes.push(ir::Attribute {
                    name: "slot".to_owned(),
                    value: Some(vec![Part::Literal(name.to_owned())]),
                });
                Ok(Node::Element(element))
            }
            Node::Text(parts)
                if parts.iter().all(|part| match part {
                    Part::Literal(text) | Part::Escaped(text) => text.trim().is_empty(),
                }) =>
            {
                Ok(Node::Text(parts))
            }
            _ => Err(Diagnostic::new(
                span,
                format!(
                    "content for the named slot `{name}` of a shadow component must be elements"
                ),
            )),
        })
        .collect()
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

// ---- using a child component ---------------------------------------------------------------
//
// The checks both backends run on `<mnx-child …>`, from the child's interface alone.

/// A listener for a near miss of one of the child's events is a typo: it would never run.
/// Other names may be native events, or bubble up from further inside.
pub(crate) fn check_child_event(
    tag: &str,
    interface: &Interface,
    attribute: &ast::Attribute,
) -> Result<(), Diagnostic> {
    let lower = attribute.name.to_ascii_lowercase();
    if !crate::parser::is_event_attribute(&lower) {
        return Ok(());
    }
    let event = &lower[2..];
    if NATIVE_EVENTS.contains(&event)
        || interface
            .events
            .iter()
            .any(|declared| declared.name == event)
    {
        return Ok(());
    }
    let names: Vec<&str> = interface
        .events
        .iter()
        .map(|declared| declared.name.as_str())
        .collect();
    let error = with_suggestion(
        Diagnostic::new(attribute.span, format!("<{tag}> never fires `{event}`")),
        event,
        &names,
    );
    if error.help.is_some() {
        Err(error)
    } else {
        Ok(())
    }
}

/// A value for a child's prop must have the type of the prop's default.
pub(crate) fn check_child_prop_type(
    tag: &str,
    prop: &PropInterface,
    value: &Value,
    span: Span,
) -> Result<(), Diagnostic> {
    match &prop.default {
        Some(default) if !same_type(default, value) => Err(Diagnostic::new(
            span,
            format!(
                "<{tag}> prop `{}` must be {} (like its default), found {}",
                prop.name,
                expression::type_name(default),
                expression::type_name(value)
            ),
        )),
        _ => Ok(()),
    }
}

/// An expression attribute that isn't one of the child's props (nor a global, data-/aria- or
/// event attribute).
pub(crate) fn unknown_child_prop(
    tag: &str,
    interface: &Interface,
    attribute: &ast::Attribute,
) -> Diagnostic {
    let prop_name = camel(&attribute.name);
    let names: Vec<&str> = interface
        .props
        .iter()
        .map(|prop| prop.name.as_str())
        .collect();
    with_suggestion(
        Diagnostic::new(attribute.span, format!("<{tag}> has no prop `{prop_name}`")),
        &prop_name,
        &names,
    )
}

pub(crate) fn is_unknown_child_attribute(
    interface: &Interface,
    attribute: &ast::Attribute,
) -> bool {
    let lower = attribute.name.to_ascii_lowercase();
    let prop_name = camel(&attribute.name);
    !interface.props.iter().any(|prop| prop.name == prop_name)
        && matches!(attribute.value, AttributeValue::Expression(..))
        && !crate::parser::is_event_attribute(&lower)
        && !is_global_attribute(&lower)
}

/// Every required prop of the child must be given.
pub(crate) fn check_child_required(
    tag: &str,
    interface: &Interface,
    element: &ast::Element,
) -> Result<(), Diagnostic> {
    for prop in &interface.props {
        let given = element
            .attributes
            .iter()
            .any(|attribute| camel(&attribute.name) == prop.name);
        if prop.required() && !given {
            return Err(Diagnostic::new(
                element.span,
                format!("<{tag}> requires the prop `{}`", prop.attribute),
            ));
        }
    }
    Ok(())
}

/// Globals a component script can read in the browser (a binding that uses one is runtime-only).
pub(crate) const RUNTIME_GLOBALS: &[&str] = &[
    "window",
    "self",
    "globalThis",
    "document",
    "navigator",
    "location",
    "history",
    "screen",
    "localStorage",
    "sessionStorage",
    "performance",
    "crypto",
    "console",
    "matchMedia",
    "Date",
    "Math",
    "JSON",
    "Number",
    "String",
    "Boolean",
    "Array",
    "Object",
    "Symbol",
    "BigInt",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "WeakRef",
    "Promise",
    "Intl",
    "URL",
    "URLSearchParams",
    "Reflect",
    "Proxy",
    "Error",
    "RegExp",
    "Infinity",
    "NaN",
    "Signal",
    "customElements",
    "structuredClone",
    "queueMicrotask",
    "requestAnimationFrame",
    "setTimeout",
    "setInterval",
    "fetch",
    "Event",
    "CustomEvent",
    "AbortController",
];

/// Common DOM events an element can receive, so a listener for one is never taken for a typo.
const NATIVE_EVENTS: &[&str] = &[
    "abort",
    "animationend",
    "animationiteration",
    "animationstart",
    "auxclick",
    "beforeinput",
    "beforetoggle",
    "blur",
    "cancel",
    "change",
    "click",
    "close",
    "contextmenu",
    "copy",
    "cut",
    "dblclick",
    "drag",
    "dragend",
    "dragenter",
    "dragleave",
    "dragover",
    "dragstart",
    "drop",
    "error",
    "focus",
    "focusin",
    "focusout",
    "formdata",
    "input",
    "invalid",
    "keydown",
    "keypress",
    "keyup",
    "load",
    "mousedown",
    "mouseenter",
    "mouseleave",
    "mousemove",
    "mouseout",
    "mouseover",
    "mouseup",
    "paste",
    "pointercancel",
    "pointerdown",
    "pointerenter",
    "pointerleave",
    "pointermove",
    "pointerout",
    "pointerover",
    "pointerup",
    "reset",
    "resize",
    "scroll",
    "scrollend",
    "select",
    "selectionchange",
    "slotchange",
    "submit",
    "toggle",
    "touchcancel",
    "touchend",
    "touchmove",
    "touchstart",
    "transitionend",
    "wheel",
];

// ---- suggestions ---------------------------------------------------------------------------

pub(crate) fn with_suggestion(
    diagnostic: Diagnostic,
    name: &str,
    candidates: &[&str],
) -> Diagnostic {
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
