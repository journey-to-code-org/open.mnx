use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::{
    ast::{self, Part as AstPart, PropKind as AstPropKind},
    diagnostic::{Diagnostic, Span},
    ir::{self, Node, Part, PropKind},
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

pub fn validate(
    component: ast::ComponentAst,
    values: &Value,
    slot_values: &HashMap<String, Vec<ast::Node>>,
) -> Result<ir::Component, Diagnostic> {
    let object = values
        .as_object()
        .ok_or_else(|| Diagnostic::new(Span::new(1, 1), "component props must be a JSON object"))?;
    validate_component_name(&component.name)?;
    if let Some(tag) = &component.tag {
        validate_custom_element(tag, component.tag_span.unwrap_or(Span::new(1, 1)))?;
    }

    let mut declarations = HashMap::new();
    let mut props = Vec::with_capacity(component.props.len());
    for declaration in &component.props {
        if declarations
            .insert(declaration.name.clone(), (props.len(), declaration.kind))
            .is_some()
        {
            return Err(Diagnostic::new(
                declaration.span,
                format!("duplicate prop `{}`", declaration.name),
            ));
        }
        let Some(value) = object.get(&declaration.name) else {
            return Err(Diagnostic::new(
                declaration.span,
                format!("missing required prop `{}`", declaration.name),
            ));
        };
        validate_prop_value(&declaration.name, declaration.kind, value, declaration.span)?;
        props.push(ir::Prop {
            name: declaration.name.clone(),
            kind: map_prop_kind(declaration.kind),
            value: value.clone(),
        });
    }
    for name in object.keys() {
        if !declarations.contains_key(name.as_str()) {
            return Err(Diagnostic::new(
                Span::new(1, 1),
                format!("unknown prop `{name}`"),
            ));
        }
    }

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
    let mut context = CompileContext {
        declarations,
        prop_values: object.clone(),
        props: props.clone(),
        slot_values,
        locals: Vec::new(),
        active_slots: HashSet::new(),
    };
    let nodes = lower_nodes(&component.nodes, &mut context)?;
    let element_roots = nodes
        .iter()
        .filter(|node| matches!(node, Node::Element(_)))
        .count();
    let has_non_whitespace_text = nodes.iter().any(|node| match node {
        Node::Text(parts) => parts.iter().any(|part| match part {
            Part::Literal(text) => !text.trim().is_empty(),
            Part::Prop(_) => true,
            Part::Escaped(value) => !value.trim().is_empty(),
        }),
        Node::Element(_) => false,
    });
    if element_roots != 1 || has_non_whitespace_text {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            "a compiled component must have exactly one root element",
        ));
    }

    Ok(ir::Component {
        name: component.name,
        tag: component.tag,
        props,
        nodes,
    })
}

struct CompileContext<'a> {
    declarations: HashMap<String, (usize, AstPropKind)>,
    prop_values: serde_json::Map<String, Value>,
    props: Vec<ir::Prop>,
    slot_values: &'a HashMap<String, Vec<ast::Node>>,
    locals: Vec<HashMap<String, Value>>,
    active_slots: HashSet<String>,
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
                collect_slots(children, slots);
            }
            ast::Node::Slot { name, fallback, .. } => {
                slots.insert(name.clone());
                collect_slots(fallback, slots);
            }
            ast::Node::Text(_) => {}
        }
    }
}

fn lower_nodes(
    nodes: &[ast::Node],
    context: &mut CompileContext<'_>,
) -> Result<Vec<ir::Node>, Diagnostic> {
    let mut output = Vec::new();
    for node in nodes {
        output.extend(lower_node(node, context)?);
    }
    Ok(output)
}

fn lower_node(
    node: &ast::Node,
    context: &mut CompileContext<'_>,
) -> Result<Vec<ir::Node>, Diagnostic> {
    match node {
        ast::Node::Text(parts) => Ok(vec![ir::Node::Text(lower_parts(parts, context)?)]),
        ast::Node::Element(element) => {
            let mut names = HashSet::new();
            let mut attributes = Vec::with_capacity(element.attributes.len());
            for attribute in &element.attributes {
                if !names.insert(attribute.name.to_ascii_lowercase()) {
                    return Err(Diagnostic::new(
                        attribute.span,
                        format!("duplicate attribute `{}`", attribute.name),
                    ));
                }
                let value = attribute
                    .value
                    .as_ref()
                    .map(|parts| lower_parts(parts, context))
                    .transpose()?;
                let attribute_name = attribute.name.to_ascii_lowercase();
                if BOOLEAN_ATTRIBUTES.contains(&attribute_name.as_str()) {
                    if let Some(parts) = value.as_deref() {
                        if parts.iter().any(|part| !matches!(part, Part::Literal(_))) {
                            let valid_binding = match parts {
                                [Part::Prop(index)] => {
                                    context.props[*index].kind == PropKind::Boolean
                                }
                                _ => false,
                            };
                            if !valid_binding {
                                return Err(Diagnostic::new(
                                    attribute.span,
                                    format!(
                                        "dynamic boolean attribute `{}` requires one boolean prop",
                                        attribute.name
                                    ),
                                ));
                            }
                        }
                    }
                }
                if attribute.name.eq_ignore_ascii_case("srcdoc")
                    && value.as_deref().is_some_and(|parts| {
                        parts.iter().any(|part| !matches!(part, Part::Literal(_)))
                    })
                {
                    return Err(Diagnostic::new(
                        attribute.span,
                        "interpolation in srcdoc is not supported",
                    ));
                }
                if attribute_name == "srcset" {
                    validate_srcset(attribute, value.as_deref())?;
                } else if URL_ATTRIBUTES.contains(&attribute_name.as_str()) {
                    validate_url_attribute(attribute, value.as_deref(), &context.props)?;
                }
                attributes.push(ir::Attribute {
                    name: attribute.name.clone(),
                    value,
                });
            }
            Ok(vec![ir::Node::Element(ir::Element {
                name: element.name.clone(),
                attributes,
                children: lower_nodes(&element.children, context)?,
                span: element.span,
            })])
        }
        ast::Node::If {
            test,
            consequent,
            alternate,
            span,
        } => {
            let value = test
                .evaluate(&|name| lookup(name, context))
                .map_err(|message| {
                    Diagnostic::new(*span, format!("invalid mnix-if test: {message}"))
                })?;
            let condition = value
                .as_bool()
                .ok_or_else(|| Diagnostic::new(*span, "mnix-if test must evaluate to a boolean"))?;
            let consequent = lower_nodes(consequent, context)?;
            let alternate = lower_nodes(alternate, context)?;
            Ok(if condition { consequent } else { alternate })
        }
        ast::Node::Each {
            item,
            collection,
            children,
            span,
        } => {
            let Some((_, kind)) = context.declarations.get(collection) else {
                return Err(Diagnostic::new(
                    *span,
                    format!("mnix-each references unknown prop `{collection}`"),
                ));
            };
            if *kind != AstPropKind::Strings {
                return Err(Diagnostic::new(
                    *span,
                    format!("mnix-each prop `{collection}` must have type strings"),
                ));
            }
            let values = context
                .prop_values
                .get(collection)
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| Diagnostic::new(*span, "strings prop must be an array"))?;
            context.locals.push(HashMap::from([(
                item.clone(),
                Value::String("mnix-validation".to_owned()),
            )]));
            let checked_body = lower_nodes(children, context);
            context.locals.pop();
            checked_body?;
            let mut output = Vec::new();
            for value in &values {
                if !value.is_string() {
                    return Err(Diagnostic::new(
                        *span,
                        format!("mnix-each prop `{collection}` contains a non-string value"),
                    ));
                }
                context
                    .locals
                    .push(HashMap::from([(item.clone(), value.clone())]));
                let lowered = lower_nodes(children, context);
                context.locals.pop();
                output.extend(lowered?);
            }
            Ok(output)
        }
        ast::Node::Slot {
            name,
            fallback,
            span,
        } => {
            if !context.active_slots.insert(name.clone()) {
                return Err(Diagnostic::new(
                    *span,
                    format!("recursive slot expansion for `{name}`"),
                ));
            }
            let fallback_output = lower_nodes(fallback, context)?;
            let output = if let Some(nodes) = context.slot_values.get(name) {
                lower_nodes(nodes, context)?
            } else {
                fallback_output
            };
            context.active_slots.remove(name);
            Ok(output)
        }
        ast::Node::Else { span, .. } => Err(Diagnostic::new(
            *span,
            "mnix-else is only valid as a direct child of mnix-if",
        )),
    }
}

fn lookup(name: &str, context: &CompileContext<'_>) -> Option<Value> {
    context
        .locals
        .iter()
        .rev()
        .find_map(|scope| scope.get(name).cloned())
        .or_else(|| context.prop_values.get(name).cloned())
}

fn lower_parts(parts: &[AstPart], context: &CompileContext<'_>) -> Result<Vec<Part>, Diagnostic> {
    parts
        .iter()
        .map(|part| match part {
            AstPart::Literal(value) => Ok(Part::Literal(value.clone())),
            AstPart::Interpolation { name, span } => {
                if let Some(value) = context
                    .locals
                    .iter()
                    .rev()
                    .find_map(|scope| scope.get(name))
                {
                    return Ok(Part::Escaped(value.as_str().unwrap_or_default().to_owned()));
                }
                let Some((index, kind)) = context.declarations.get(name) else {
                    return Err(Diagnostic::new(
                        *span,
                        format!("unknown prop reference `{name}`"),
                    ));
                };
                if *kind == AstPropKind::Strings {
                    return Err(Diagnostic::new(
                        *span,
                        format!("strings prop `{name}` must be iterated with mnix-each"),
                    ));
                }
                Ok(Part::Prop(*index))
            }
        })
        .collect()
}

fn validate_component_name(name: &str) -> Result<(), Diagnostic> {
    if name.is_empty()
        || !name.chars().next().is_some_and(char::is_alphabetic)
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err(Diagnostic::new(Span::new(1, 1), "invalid component name"));
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
        return Err(Diagnostic::new(
            span,
            format!("`{tag}` is not a valid custom-element name"),
        ));
    }
    Ok(())
}

fn validate_prop_value(
    name: &str,
    kind: AstPropKind,
    value: &Value,
    span: Span,
) -> Result<(), Diagnostic> {
    let valid = match kind {
        AstPropKind::String => value.is_string(),
        AstPropKind::Number => value.as_f64().is_some_and(f64::is_finite),
        AstPropKind::Boolean => value.is_boolean(),
        AstPropKind::Url => value.as_str().is_some_and(is_safe_url),
        AstPropKind::Strings => value
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string)),
    };
    if !valid {
        let expected = match kind {
            AstPropKind::String => "a string",
            AstPropKind::Number => "a finite number",
            AstPropKind::Boolean => "a boolean",
            AstPropKind::Url => "a safe URL string",
            AstPropKind::Strings => "an array of strings",
        };
        return Err(Diagnostic::new(
            span,
            format!("prop `{name}` must be {expected}"),
        ));
    }
    Ok(())
}

fn validate_url_attribute(
    attribute: &ast::Attribute,
    value: Option<&[Part]>,
    props: &[ir::Prop],
) -> Result<(), Diagnostic> {
    let Some(parts) = value else {
        return Err(Diagnostic::new(
            attribute.span,
            format!("URL attribute `{}` requires a value", attribute.name),
        ));
    };
    if parts.len() == 1 {
        match &parts[0] {
            Part::Literal(url) if !is_safe_url(url) => {
                return Err(Diagnostic::new(
                    attribute.span,
                    format!("unsafe URL in `{}` attribute", attribute.name),
                ));
            }
            Part::Prop(index) => {
                let prop = &props[*index];
                if prop.kind != PropKind::Url {
                    return Err(Diagnostic::new(
                        attribute.span,
                        format!(
                            "interpolated URL attribute `{}` requires a prop declared as url",
                            attribute.name
                        ),
                    ));
                }
            }
            Part::Escaped(url) if !is_safe_url(url) => {
                return Err(Diagnostic::new(
                    attribute.span,
                    format!("unsafe URL in `{}` attribute", attribute.name),
                ));
            }
            _ => {}
        }
        return Ok(());
    }
    if parts.iter().any(|part| matches!(part, Part::Prop(_))) {
        return Err(Diagnostic::new(
            attribute.span,
            format!(
                "URL attribute `{}` must be one literal URL or one url prop",
                attribute.name
            ),
        ));
    }
    let value = parts
        .iter()
        .filter_map(|part| match part {
            Part::Literal(text) => Some(text.as_str()),
            Part::Prop(_) => None,
            Part::Escaped(text) => Some(text.as_str()),
        })
        .collect::<String>();
    if !is_safe_url(&value) {
        return Err(Diagnostic::new(
            attribute.span,
            format!("unsafe URL in `{}` attribute", attribute.name),
        ));
    }
    Ok(())
}

fn validate_srcset(attribute: &ast::Attribute, value: Option<&[Part]>) -> Result<(), Diagnostic> {
    let Some(parts) = value else {
        return Err(Diagnostic::new(
            attribute.span,
            "srcset requires a list of safe URL candidates",
        ));
    };
    if parts.iter().any(|part| matches!(part, Part::Prop(_))) {
        return Err(Diagnostic::new(
            attribute.span,
            "srcset interpolation is not supported in MNIX v0.1",
        ));
    }
    let source = parts
        .iter()
        .filter_map(|part| match part {
            Part::Literal(text) => Some(text.as_str()),
            Part::Prop(_) => None,
            Part::Escaped(text) => Some(text.as_str()),
        })
        .collect::<String>();
    let candidates = source.split(',').collect::<Vec<_>>();
    if candidates.is_empty()
        || candidates.iter().any(|candidate| {
            candidate
                .split_whitespace()
                .next()
                .is_none_or(|url| !is_safe_url(url))
        })
    {
        return Err(Diagnostic::new(
            attribute.span,
            "srcset contains an unsafe or empty URL candidate",
        ));
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

fn map_prop_kind(kind: AstPropKind) -> PropKind {
    match kind {
        AstPropKind::String => PropKind::String,
        AstPropKind::Number => PropKind::Number,
        AstPropKind::Boolean => PropKind::Boolean,
        AstPropKind::Url => PropKind::Url,
        AstPropKind::Strings => PropKind::Strings,
    }
}
