use crate::ir::{Component, Node, Part};

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

pub fn render(component: &Component) -> String {
    let mut output = format!("<{}", component.tag);
    for (name, value) in &component.host_attributes {
        output.push(' ');
        output.push_str(name);
        if !value.is_empty() {
            output.push_str("=\"");
            escape_html(value, &mut output);
            output.push('"');
        }
    }
    output.push('>');
    if component.shadow {
        output.push_str("<template shadowrootmode=\"open\">");
    }
    for node in &component.nodes {
        render_node(node, &mut output);
    }
    if component.shadow {
        output.push_str("</template>");
    }
    for node in &component.light_children {
        render_node(node, &mut output);
    }
    output.push_str(&format!("</{}>", component.tag));
    output
}

fn render_node(node: &Node, output: &mut String) {
    match node {
        Node::Text(parts) => render_parts(parts, output),
        Node::Anchor => output.push_str("<!---->"),
        Node::Open => output.push_str("<!--[-->"),
        Node::OpenProjected => output.push_str("<!--[!-->"),
        Node::Close => output.push_str("<!--]-->"),
        Node::Element(element) => {
            output.push('<');
            output.push_str(&element.name);
            for attribute in &element.attributes {
                output.push(' ');
                output.push_str(&attribute.name);
                if let Some(parts) = &attribute.value {
                    output.push_str("=\"");
                    render_parts(parts, output);
                    output.push('"');
                }
            }
            output.push('>');
            if !VOID_ELEMENTS.contains(&element.name.to_ascii_lowercase().as_str()) {
                for child in &element.children {
                    render_node(child, output);
                }
                output.push_str("</");
                output.push_str(&element.name);
                output.push('>');
            }
        }
    }
}

fn render_parts(parts: &[Part], output: &mut String) {
    for part in parts {
        match part {
            Part::Literal(text) => output.push_str(text),
            Part::Escaped(text) => escape_html(text, output),
        }
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
