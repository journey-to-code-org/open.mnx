use std::collections::HashSet;

use crate::{
    ast::{Attribute, ComponentAst, Element, Node, Part, PropDecl, PropKind},
    diagnostic::{Diagnostic, Span},
    expression,
};

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

struct Header {
    name: String,
    tag: Option<String>,
    tag_span: Option<Span>,
    props: Vec<PropDecl>,
}

pub fn parse(source: &str) -> Result<ComponentAst, Diagnostic> {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let (header, template, template_line) = split_source(&normalized)?;
    let header = parse_header(header)?;
    let mut parser = TemplateParser::new(template, template_line);
    let nodes = parser.parse_nodes(None)?;
    if parser.position != template.len() {
        return Err(parser.error("unexpected content after template"));
    }
    Ok(ComponentAst {
        name: header.name,
        tag: header.tag,
        tag_span: header.tag_span,
        props: header.props,
        nodes,
    })
}

pub(crate) fn parse_fragment(source: &str) -> Result<Vec<Node>, Diagnostic> {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut parser = TemplateParser::new(&normalized, 1);
    let nodes = parser.parse_nodes(None)?;
    if parser.position != normalized.len() {
        return Err(parser.error("unexpected content after slot template"));
    }
    Ok(nodes)
}

fn split_source(source: &str) -> Result<(&str, &str, usize), Diagnostic> {
    let Some(separator) = source.find("\n---\n") else {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            "expected a metadata header followed by a line containing ---",
        ));
    };
    let header = &source[..separator];
    let template_start = separator + "\n---\n".len();
    let template_line = source[..template_start].lines().count() + 1;
    Ok((header, &source[template_start..], template_line))
}

fn parse_header(header: &str) -> Result<Header, Diagnostic> {
    let mut name = None;
    let mut tag = None;
    let mut tag_span = None;
    let mut props = Vec::new();

    for (line_index, raw_line) in header.lines().enumerate() {
        let line_number = line_index + 1;
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let span = Span::new(
            line_number,
            raw_line.len() - raw_line.trim_start().len() + 1,
        );
        if let Some(value) = line.strip_prefix("component:") {
            if name.is_some() {
                return Err(Diagnostic::new(
                    span,
                    "component name is declared more than once",
                ));
            }
            let value = value.trim();
            if !is_identifier(value) {
                return Err(Diagnostic::new(
                    span,
                    "component name must start with a letter and contain only letters, digits, or underscores",
                ));
            }
            name = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("tag:") {
            if tag.is_some() {
                return Err(Diagnostic::new(
                    span,
                    "custom-element tag is declared more than once",
                ));
            }
            tag = Some(value.trim().to_owned());
            tag_span = Some(span);
        } else if let Some(value) = line.strip_prefix("prop ") {
            let Some((prop_name, prop_kind)) = value.split_once(':') else {
                return Err(Diagnostic::new(span, "expected prop name: type"));
            };
            let prop_name = prop_name.trim();
            let prop_kind = prop_kind.trim();
            if !is_identifier(prop_name) {
                return Err(Diagnostic::new(span, "invalid prop name"));
            }
            let kind = match prop_kind {
                "string" => PropKind::String,
                "number" => PropKind::Number,
                "boolean" => PropKind::Boolean,
                "url" => PropKind::Url,
                "strings" => PropKind::Strings,
                _ => {
                    return Err(Diagnostic::new(
                        span,
                        format!("unsupported prop type `{prop_kind}`"),
                    ));
                }
            };
            props.push(PropDecl {
                name: prop_name.to_owned(),
                kind,
                span,
            });
        } else {
            return Err(Diagnostic::new(
                span,
                "expected component:, tag:, or prop name: type",
            ));
        }
    }

    let Some(name) = name else {
        return Err(Diagnostic::new(Span::new(1, 1), "missing component: Name"));
    };
    let mut seen = HashSet::new();
    for prop in &props {
        if !seen.insert(&prop.name) {
            return Err(Diagnostic::new(
                prop.span,
                format!("duplicate prop `{}`", prop.name),
            ));
        }
    }
    Ok(Header {
        name,
        tag,
        tag_span,
        props,
    })
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

struct TemplateParser<'a> {
    source: &'a str,
    position: usize,
    line: usize,
    column: usize,
}

impl<'a> TemplateParser<'a> {
    fn new(source: &'a str, line: usize) -> Self {
        Self {
            source,
            position: 0,
            line,
            column: 1,
        }
    }

    fn parse_nodes(&mut self, closing: Option<&str>) -> Result<Vec<Node>, Diagnostic> {
        let mut nodes = Vec::new();
        while self.position < self.source.len() {
            if self.starts_with("</") {
                let span = self.current_span();
                self.advance(2);
                let name = self.parse_name()?;
                self.skip_whitespace();
                if !self.starts_with(">") {
                    return Err(self.error("expected > after closing tag"));
                }
                self.advance(1);
                let Some(expected) = closing else {
                    return Err(Diagnostic::new(span, "unexpected closing tag"));
                };
                if !name.eq_ignore_ascii_case(expected) {
                    return Err(Diagnostic::new(
                        span,
                        format!("closing tag </{name}> does not match <{expected}>"),
                    ));
                }
                return Ok(nodes);
            }
            if self.starts_with("<!--") {
                return Err(self.error("HTML comments are not supported in MNIX v0.1"));
            }
            if self.starts_with("<!") || self.starts_with("<?") {
                return Err(self
                    .error("doctype and processing instructions are not supported in templates"));
            }
            if self.starts_with("<") {
                nodes.push(self.parse_element()?);
            } else {
                nodes.push(Node::Text(self.parse_parts(None)?));
            }
        }
        if let Some(name) = closing {
            return Err(self.error(&format!("missing closing tag </{name}>")));
        }
        Ok(nodes)
    }

    fn parse_element(&mut self) -> Result<Node, Diagnostic> {
        let span = self.current_span();
        self.advance(1);
        let name = self.parse_name()?;
        let mut attributes = Vec::new();
        let mut seen = HashSet::new();

        loop {
            self.skip_whitespace();
            if self.starts_with(">") {
                self.advance(1);
                break;
            }
            if self.starts_with("/>") {
                self.advance(2);
                let element = Element {
                    name,
                    attributes,
                    children: Vec::new(),
                    span,
                };
                return self.lower_directive(element);
            }
            if self.position >= self.source.len() {
                return Err(self.error("unterminated start tag"));
            }
            let attribute_span = self.current_span();
            let attribute_name = self.parse_name()?;
            if !seen.insert(attribute_name.to_ascii_lowercase()) {
                return Err(Diagnostic::new(
                    attribute_span,
                    format!("duplicate attribute `{attribute_name}`"),
                ));
            }
            if attribute_name.eq_ignore_ascii_case("style") {
                return Err(Diagnostic::new(
                    attribute_span,
                    "inline style attributes are not supported; use component styles in a later MNIX release",
                ));
            }
            if is_inline_event_attribute(&attribute_name) {
                return Err(Diagnostic::new(
                    attribute_span,
                    "inline event-handler attributes are not allowed",
                ));
            }
            self.skip_whitespace();
            let value = if self.starts_with("=") {
                self.advance(1);
                self.skip_whitespace();
                if !self.starts_with("\"") && !self.starts_with("'") {
                    return Err(self.error("attribute values must be quoted"));
                }
                let quote = self.source.as_bytes()[self.position] as char;
                self.advance(1);
                let parts = self.parse_parts(Some(quote))?;
                if self.position >= self.source.len() {
                    return Err(self.error("unterminated attribute value"));
                }
                self.advance(1);
                Some(parts)
            } else {
                None
            };
            attributes.push(Attribute {
                name: attribute_name,
                value,
                span: attribute_span,
            });
        }

        if name.eq_ignore_ascii_case("script") || name.eq_ignore_ascii_case("style") {
            return Err(Diagnostic::new(
                span,
                format!("<{name}> elements are not supported in MNIX templates"),
            ));
        }
        let children = if VOID_ELEMENTS.contains(&name.to_ascii_lowercase().as_str()) {
            Vec::new()
        } else {
            self.parse_nodes(Some(&name))?
        };
        self.lower_directive(Element {
            name,
            attributes,
            children,
            span,
        })
    }

    fn lower_directive(&self, element: Element) -> Result<Node, Diagnostic> {
        if element.name.eq_ignore_ascii_case("mnix-if") {
            validate_directive_attributes(&element, &["test"])?;
            let test = required_literal_attribute(&element, "test")?;
            let test = expression::parse(&test).map_err(|message| {
                Diagnostic::new(element.span, format!("invalid mnix-if test: {message}"))
            })?;
            let mut consequent = Vec::new();
            let mut alternate = None;
            for child in element.children {
                match child {
                    Node::Else { children, span } => {
                        if alternate.is_some() {
                            return Err(Diagnostic::new(span, "mnix-if may contain only one mnix-else"));
                        }
                        alternate = Some(children);
                    }
                    Node::Text(parts)
                        if alternate.is_some()
                            && parts.iter().all(
                                |part| matches!(part, Part::Literal(value) if value.trim().is_empty()),
                            ) => {}
                    child => {
                        if alternate.is_some() {
                            return Err(Diagnostic::new(element.span, "mnix-else must be the final child of mnix-if"));
                        }
                        consequent.push(child);
                    }
                }
            }
            return Ok(Node::If {
                test,
                consequent,
                alternate: alternate.unwrap_or_default(),
                span: element.span,
            });
        }
        if element.name.eq_ignore_ascii_case("mnix-each") {
            validate_directive_attributes(&element, &["items", "as"])?;
            let collection = required_literal_attribute(&element, "items")?;
            let item = required_literal_attribute(&element, "as")?;
            if !is_identifier(&collection) {
                return Err(Diagnostic::new(
                    element.span,
                    "mnix-each items must name a declared strings prop",
                ));
            }
            if !is_identifier(&item) {
                return Err(Diagnostic::new(
                    element.span,
                    "mnix-each as must be a valid local identifier",
                ));
            }
            return Ok(Node::Each {
                item,
                collection,
                children: element.children,
                span: element.span,
            });
        }
        if element.name.eq_ignore_ascii_case("mnix-slot") {
            validate_directive_attributes(&element, &["name"])?;
            let name = match optional_literal_attribute(&element, "name")? {
                Some(name) if is_identifier(&name) => name,
                Some(name) if name == "default" => "default".to_owned(),
                None => "default".to_owned(),
                Some(_) => {
                    return Err(Diagnostic::new(
                        element.span,
                        "mnix-slot name must be `default` or a valid identifier",
                    ));
                }
            };
            return Ok(Node::Slot {
                name,
                fallback: element.children,
                span: element.span,
            });
        }
        if element.name.eq_ignore_ascii_case("mnix-else") {
            if !element.attributes.is_empty() {
                return Err(Diagnostic::new(
                    element.span,
                    "mnix-else does not accept attributes",
                ));
            }
            return Ok(Node::Else {
                children: element.children,
                span: element.span,
            });
        }
        Ok(Node::Element(element))
    }

    fn parse_name(&mut self) -> Result<String, Diagnostic> {
        let start = self.position;
        while let Some(byte) = self.source.as_bytes().get(self.position) {
            if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b':' | b'.') {
                self.advance(1);
            } else {
                break;
            }
        }
        if start == self.position {
            return Err(self.error("expected an HTML tag or attribute name"));
        }
        Ok(self.source[start..self.position].to_owned())
    }

    fn parse_parts(&mut self, quote: Option<char>) -> Result<Vec<Part>, Diagnostic> {
        let mut parts = Vec::new();
        let mut literal_start = self.position;
        while self.position < self.source.len() {
            let byte = self.source.as_bytes()[self.position];
            if quote.is_some_and(|quote| byte == quote as u8) || quote.is_none() && byte == b'<' {
                break;
            }
            if self.starts_with("{{") {
                if literal_start < self.position {
                    parts.push(Part::Literal(
                        self.source[literal_start..self.position].to_owned(),
                    ));
                }
                let span = self.current_span();
                self.advance(2);
                let expression_start = self.position;
                let Some(relative_end) = self.source[self.position..].find("}}") else {
                    return Err(Diagnostic::new(
                        span,
                        "unterminated interpolation; expected }}",
                    ));
                };
                let expression_end = self.position + relative_end;
                let name = self.source[expression_start..expression_end].trim();
                if !is_identifier(name) {
                    return Err(Diagnostic::new(
                        span,
                        "MNIX v0.1 interpolation must be a prop identifier",
                    ));
                }
                self.advance(expression_end - self.position + 2);
                parts.push(Part::Interpolation {
                    name: name.to_owned(),
                    span,
                });
                literal_start = self.position;
                continue;
            }
            let character_length = self.source[self.position..]
                .chars()
                .next()
                .expect("position is before the end of the source")
                .len_utf8();
            self.advance(character_length);
        }
        if literal_start < self.position {
            parts.push(Part::Literal(
                self.source[literal_start..self.position].to_owned(),
            ));
        } else if parts.is_empty() {
            parts.push(Part::Literal(String::new()));
        }
        Ok(parts)
    }

    fn skip_whitespace(&mut self) {
        while self
            .source
            .as_bytes()
            .get(self.position)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.advance(1);
        }
    }

    fn starts_with(&self, value: &str) -> bool {
        self.source[self.position..].starts_with(value)
    }

    fn current_span(&self) -> Span {
        Span::new(self.line, self.column)
    }

    fn error(&self, message: &str) -> Diagnostic {
        Diagnostic::new(self.current_span(), message)
    }

    fn advance(&mut self, byte_count: usize) {
        let end = self.position + byte_count;
        for character in self.source[self.position..end].chars() {
            if character == '\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += 1;
            }
        }
        self.position = end;
    }
}

fn is_inline_event_attribute(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("on")
        && name.len() > 2
        && name[2..].bytes().all(|byte| byte.is_ascii_alphabetic())
}

fn validate_directive_attributes(element: &Element, allowed: &[&str]) -> Result<(), Diagnostic> {
    for attribute in &element.attributes {
        if !allowed
            .iter()
            .any(|name| attribute.name.eq_ignore_ascii_case(name))
        {
            return Err(Diagnostic::new(
                attribute.span,
                format!(
                    "unexpected attribute `{}` on <{}>",
                    attribute.name, element.name
                ),
            ));
        }
    }
    Ok(())
}

fn required_literal_attribute(element: &Element, name: &str) -> Result<String, Diagnostic> {
    optional_literal_attribute(element, name)?.ok_or_else(|| {
        Diagnostic::new(
            element.span,
            format!("<{}> requires a `{name}` attribute", element.name),
        )
    })
}

fn optional_literal_attribute(element: &Element, name: &str) -> Result<Option<String>, Diagnostic> {
    let attribute = element
        .attributes
        .iter()
        .find(|attribute| attribute.name.eq_ignore_ascii_case(name));
    let Some(attribute) = attribute else {
        return Ok(None);
    };
    let Some(parts) = attribute.value.as_deref() else {
        return Err(Diagnostic::new(
            attribute.span,
            format!("attribute `{name}` requires a quoted value"),
        ));
    };
    if parts.iter().any(|part| !matches!(part, Part::Literal(_))) {
        return Err(Diagnostic::new(
            attribute.span,
            format!("attribute `{name}` must be static text"),
        ));
    }
    let value = parts
        .iter()
        .filter_map(|part| match part {
            Part::Literal(text) => Some(text.as_str()),
            Part::Interpolation { .. } => None,
        })
        .collect::<String>();
    Ok(Some(value))
}
