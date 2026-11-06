use std::collections::HashSet;

use crate::{
    ast::{Attribute, ComponentAst, Element, Node, Part, PropDecl, PropKind},
    diagnostic::{Diagnostic, Span},
    expression,
    scanner::Cursor,
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
    let mut parser = TemplateParser::new(Cursor::at(template, Span::new(template_line, 1)));
    let nodes = parser.parse_nodes(None)?;
    if !parser.cursor.is_at_end() {
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
    let mut parser = TemplateParser::new(Cursor::new(&normalized));
    let nodes = parser.parse_nodes(None)?;
    if !parser.cursor.is_at_end() {
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
    cursor: Cursor<'a>,
}

impl<'a> TemplateParser<'a> {
    fn new(cursor: Cursor<'a>) -> Self {
        Self { cursor }
    }

    fn parse_nodes(&mut self, closing: Option<&str>) -> Result<Vec<Node>, Diagnostic> {
        let mut nodes = Vec::new();
        while !self.cursor.is_at_end() {
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
            if self.cursor.is_at_end() {
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
                let quote = self.cursor.peek_byte().unwrap_or(b'"') as char;
                self.advance(1);
                let parts = self.parse_parts(Some(quote))?;
                if self.cursor.is_at_end() {
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
        let name = self.cursor.take_while(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')
        });
        if name.is_empty() {
            return Err(self.error("expected an HTML tag or attribute name"));
        }
        Ok(name.to_owned())
    }

    fn parse_parts(&mut self, quote: Option<char>) -> Result<Vec<Part>, Diagnostic> {
        let mut parts = Vec::new();
        let source = self.cursor.source();
        let mut literal_start = self.cursor.position();
        while let Some(byte) = self.cursor.peek_byte() {
            if quote.is_some_and(|quote| byte == quote as u8) || quote.is_none() && byte == b'<' {
                break;
            }
            if self.starts_with("{{") {
                if literal_start < self.cursor.position() {
                    parts.push(Part::Literal(
                        source[literal_start..self.cursor.position()].to_owned(),
                    ));
                }
                let span = self.current_span();
                self.advance(2);
                let expression_start = self.cursor.position();
                let Some(relative_end) = self.cursor.rest().find("}}") else {
                    return Err(Diagnostic::new(
                        span,
                        "unterminated interpolation; expected }}",
                    ));
                };
                let name = source[expression_start..expression_start + relative_end].trim();
                if !is_identifier(name) {
                    return Err(Diagnostic::new(
                        span,
                        "MNIX v0.1 interpolation must be a prop identifier",
                    ));
                }
                self.advance(relative_end + 2);
                parts.push(Part::Interpolation {
                    name: name.to_owned(),
                    span,
                });
                literal_start = self.cursor.position();
                continue;
            }
            self.cursor.advance_char();
        }
        if literal_start < self.cursor.position() {
            parts.push(Part::Literal(
                source[literal_start..self.cursor.position()].to_owned(),
            ));
        } else if parts.is_empty() {
            parts.push(Part::Literal(String::new()));
        }
        Ok(parts)
    }

    fn skip_whitespace(&mut self) {
        self.cursor.skip_whitespace();
    }

    fn starts_with(&self, value: &str) -> bool {
        self.cursor.starts_with(value)
    }

    fn current_span(&self) -> Span {
        self.cursor.span()
    }

    fn error(&self, message: &str) -> Diagnostic {
        self.cursor.error(message)
    }

    fn advance(&mut self, byte_count: usize) {
        self.cursor.advance(byte_count);
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
