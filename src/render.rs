use crate::{
    diagnostic::Diagnostic,
    ir::{Component, Node, Part},
};

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
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

pub fn render(component: &Component) -> Result<String, Diagnostic> {
    let mut output = String::new();
    for node in &component.nodes {
        render_node(node, component, &mut output)?;
    }
    if let Some(tag) = &component.tag {
        Ok(format!("<{tag}>{output}</{tag}>"))
    } else {
        Ok(output)
    }
}

fn render_node(node: &Node, component: &Component, output: &mut String) -> Result<(), Diagnostic> {
    match node {
        Node::Text(parts) => render_parts(parts, component, output),
        Node::Element(element) => {
            output.push('<');
            output.push_str(&element.name);
            for attribute in &element.attributes {
                let is_boolean =
                    BOOLEAN_ATTRIBUTES.contains(&attribute.name.to_ascii_lowercase().as_str());
                if is_boolean {
                    if let Some([Part::Prop(index)]) = attribute.value.as_deref() {
                        let prop = component.props.get(*index).ok_or_else(|| {
                            Diagnostic::new(
                                crate::diagnostic::Span::new(1, 1),
                                "invalid prop index in IR",
                            )
                        })?;
                        if prop.value == serde_json::Value::Bool(false) {
                            continue;
                        }
                        output.push(' ');
                        output.push_str(&attribute.name);
                        continue;
                    }
                }
                output.push(' ');
                output.push_str(&attribute.name);
                if let Some(parts) = &attribute.value {
                    output.push_str("=\"");
                    render_parts(parts, component, output)?;
                    output.push('"');
                }
            }
            output.push('>');
            if !VOID_ELEMENTS.contains(&element.name.to_ascii_lowercase().as_str()) {
                for child in &element.children {
                    render_node(child, component, output)?;
                }
                output.push_str("</");
                output.push_str(&element.name);
                output.push('>');
            }
            Ok(())
        }
    }
}

fn render_parts(
    parts: &[Part],
    component: &Component,
    output: &mut String,
) -> Result<(), Diagnostic> {
    for part in parts {
        match part {
            Part::Literal(value) => output.push_str(value),
            Part::Escaped(value) => escape_html(value, output),
            Part::Prop(index) => {
                let prop = component.props.get(*index).ok_or_else(|| {
                    Diagnostic::new(
                        crate::diagnostic::Span::new(1, 1),
                        "invalid prop index in IR",
                    )
                })?;
                escape_html(&prop_to_string(prop), output);
            }
        }
    }
    Ok(())
}

fn prop_to_string(prop: &crate::ir::Prop) -> String {
    match &prop.value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

fn escape_html(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(character),
        }
    }
}
