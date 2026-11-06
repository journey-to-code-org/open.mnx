//! Parsing a `.mnx` single-file component into a [`ComponentAst`].
//!
//! ```text
//! component  → whitespace ( script whitespace )? host whitespace
//! script     → "<script>" javascript "</script>"
//! host       → "<" custom-element-name attribute* ">" template "</" same-name ">"
//! template   → ( text | element | directive | comment )*
//! text       → ( characters | "{" expression "}" )*
//! attribute  → name ( "=" ( quoted-text | "{" expression "}" ) )?
//! ```
//!
//! Markup is scanned with [`Cursor`]; on `{` it switches to the expression language
//! ([`Cursor::scan_braced`] finds the matching `}`), and the `<script>` body is handed to oxc.

use std::collections::HashSet;

use crate::{
    ast::{
        Attribute, AttributeValue, ComponentAst, Element, Node, Part, PropDecl, PropDefault, Script,
    },
    diagnostic::{Diagnostic, Span},
    expression::{self, Expression},
    scanner::{span_after, Cursor},
    script,
};

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

pub fn parse(source: &str) -> Result<ComponentAst, Diagnostic> {
    let normalized = normalize(source);
    let mut parser = TemplateParser::new(Cursor::new(&normalized));
    let leading_comment = parser.skip_whitespace_and_comments()?;
    if normalized.trim_start().starts_with("component:") {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            "the `component:`/`prop`/`---` header is v0.2 syntax; declare the component with its host tag instead",
        )
        .with_help("<script>const name = \"…\"</script>\n<my-element name={name}>…</my-element>"));
    }

    let script = if parser.cursor.starts_with_ignore_ascii_case("<script") {
        parser.parse_script_block()?
    } else {
        Script::default()
    };
    let host_comment = parser.skip_whitespace_and_comments()?;

    if !parser.starts_with("<") || parser.starts_with("</") {
        return Err(
            parser.error("expected the component's host element, e.g. <my-element>…</my-element>")
        );
    }
    let host = parser.parse_raw_element()?;
    parser.skip_whitespace_and_comments()?;
    if !parser.cursor.is_at_end() {
        return Err(parser.error(
            "unexpected content after the host element; a component file has one <script> and one host element",
        ));
    }

    let mut props = Vec::new();
    let mut shadow = false;
    let mut form_associated = false;
    for attribute in host.attributes {
        if attribute.name == "shadow" && attribute.value == AttributeValue::None {
            shadow = true;
            continue;
        }
        if attribute.name == "form-associated" && attribute.value == AttributeValue::None {
            form_associated = true;
            continue;
        }
        let name = prop_name(&attribute)?;
        let default = match attribute.value {
            AttributeValue::None => PropDefault::Required,
            AttributeValue::Expression(expression, span) => {
                PropDefault::Expression(expression, span)
            }
            AttributeValue::Text(parts) => match parts.as_slice() {
                [Part::Literal(text)] => PropDefault::Text(text.clone()),
                _ => {
                    return Err(Diagnostic::new(
                        attribute.span,
                        "a prop default can't interpolate; write the whole default as {…}",
                    ));
                }
            },
        };
        props.push(PropDecl {
            name,
            default,
            span: attribute.span,
        });
    }

    // A comment right above the host tag (or above the script) documents the component.
    let description = host_comment
        .or(leading_comment)
        .map(|text| dedent(&text))
        .filter(|text| !text.is_empty());
    Ok(ComponentAst {
        tag: host.name,
        tag_span: host.span,
        description,
        shadow,
        form_associated,
        props,
        script,
        nodes: host.children,
        children: Vec::new(),
    })
}

/// Parse a template fragment (slot content supplied at build time).
pub(crate) fn parse_fragment(source: &str) -> Result<Vec<Node>, Diagnostic> {
    let normalized = normalize(source);
    let mut parser = TemplateParser::new(Cursor::new(&normalized));
    let nodes = parser.parse_nodes(None)?;
    if !parser.cursor.is_at_end() {
        return Err(parser.error("unexpected content after slot template"));
    }
    Ok(nodes)
}

/// Trim a comment's text and remove the indentation its lines share.
fn dedent(text: &str) -> String {
    let lines: Vec<&str> = text.trim_matches('\n').lines().collect();
    let indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| line.get(indent..).unwrap_or("").trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn normalize(source: &str) -> String {
    source.replace("\r\n", "\n").replace('\r', "\n")
}

/// `max-value` → `maxValue`. Attribute names are lowercase in HTML, so camelCase props are
/// written kebab-case on the host tag (the same rule custom elements use for attributes).
fn prop_name(attribute: &Attribute) -> Result<String, Diagnostic> {
    let name = &attribute.name;
    if name.bytes().any(|byte| byte.is_ascii_uppercase()) {
        let kebab: String = name
            .chars()
            .flat_map(|character| {
                if character.is_ascii_uppercase() {
                    vec!['-', character.to_ascii_lowercase()]
                } else {
                    vec![character]
                }
            })
            .collect();
        return Err(Diagnostic::new(
            attribute.span,
            format!("HTML lowercases attribute names, so `{name}` can't be a prop name"),
        )
        .with_help(format!(
            "write `{kebab}`; the prop will be `{name}` in code"
        )));
    }
    let valid = name.starts_with(|character: char| character.is_ascii_lowercase())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !name.ends_with('-')
        && !name.contains("--");
    if !valid {
        return Err(Diagnostic::new(
            attribute.span,
            format!("`{name}` is not a valid prop name; use lowercase letters, digits and single hyphens"),
        ));
    }
    let mut prop = String::new();
    let mut upper = false;
    for character in name.chars() {
        if character == '-' {
            upper = true;
        } else if upper {
            prop.push(character.to_ascii_uppercase());
            upper = false;
        } else {
            prop.push(character);
        }
    }
    Ok(prop)
}

pub(crate) fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '$'
        })
}

struct TemplateParser<'a> {
    cursor: Cursor<'a>,
}

impl<'a> TemplateParser<'a> {
    fn new(cursor: Cursor<'a>) -> Self {
        Self { cursor }
    }

    fn parse_script_block(&mut self) -> Result<Script, Diagnostic> {
        let span = self.current_span();
        self.advance("<script".len());
        self.skip_whitespace();
        if !self.starts_with(">") {
            return Err(Diagnostic::new(
                span,
                "<script> in a component takes no attributes (it is always a module)",
            ));
        }
        self.advance(1);
        let body_span = self.current_span();
        let rest = self.cursor.rest();
        let Some(end) = rest.to_ascii_lowercase().find("</script") else {
            return Err(Diagnostic::new(span, "missing </script>"));
        };
        let body = &rest[..end];
        self.advance(end + "</script".len());
        self.skip_whitespace();
        if !self.starts_with(">") {
            return Err(self.error("expected > after </script"));
        }
        self.advance(1);
        script::parse(body, body_span)
    }

    /// Skip whitespace and comments; returns the text of the last comment skipped.
    fn skip_whitespace_and_comments(&mut self) -> Result<Option<String>, Diagnostic> {
        let mut last = None;
        loop {
            self.skip_whitespace();
            if self.starts_with("<!--") {
                last = Some(self.skip_comment()?);
            } else {
                return Ok(last);
            }
        }
    }

    /// Skip a comment, returning its text.
    fn skip_comment(&mut self) -> Result<String, Diagnostic> {
        let span = self.current_span();
        let Some(end) = self.cursor.rest().find("-->") else {
            return Err(Diagnostic::new(
                span,
                "unterminated HTML comment; expected -->",
            ));
        };
        let text = self.cursor.rest()[4..end].to_owned();
        self.advance(end + 3);
        Ok(text)
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
                // Comments are authoring notes; they are not emitted.
                self.skip_comment()?;
                continue;
            }
            if self.starts_with("<!") || self.starts_with("<?") {
                return Err(self
                    .error("doctype and processing instructions are not supported in templates"));
            }
            if self.starts_with("<") {
                let element = self.parse_raw_element()?;
                nodes.push(lower_directive(element)?);
            } else {
                let parts = self.parse_parts(None)?;
                // A comment between two runs of text was stripped, so in the DOM they are one
                // text node; keep them as one here too.
                if let Some(Node::Text(previous)) = nodes.last_mut() {
                    previous.extend(parts);
                } else {
                    nodes.push(Node::Text(parts));
                }
            }
        }
        if let Some(name) = closing {
            return Err(self.error(&format!("missing closing tag </{name}>")));
        }
        Ok(nodes)
    }

    /// An element with its attributes and (directive-lowered) children, before the element
    /// itself is checked for being a directive.
    fn parse_raw_element(&mut self) -> Result<Element, Diagnostic> {
        let span = self.current_span();
        self.advance(1);
        let name = self.parse_name()?;
        let mut attributes = Vec::new();
        let mut seen = HashSet::new();

        let self_closing = loop {
            self.skip_whitespace();
            if self.starts_with(">") {
                self.advance(1);
                break false;
            }
            if self.starts_with("/>") {
                self.advance(2);
                break true;
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
            self.skip_whitespace();
            let value = if self.starts_with("=") {
                self.advance(1);
                self.skip_whitespace();
                if self.starts_with("{") {
                    let (expression, expression_span) = self.parse_braced_expression()?;
                    AttributeValue::Expression(expression, expression_span)
                } else if self.starts_with("\"") || self.starts_with("'") {
                    let quote = self.cursor.peek_byte().unwrap_or(b'"') as char;
                    self.advance(1);
                    let parts = self.parse_parts(Some(quote))?;
                    if self.cursor.is_at_end() {
                        return Err(self.error("unterminated attribute value"));
                    }
                    self.advance(1);
                    AttributeValue::Text(parts)
                } else {
                    return Err(
                        self.error("attribute values must be quoted text or a {…} expression")
                    );
                }
            } else {
                AttributeValue::None
            };
            check_attribute(&attribute_name, &value, attribute_span)?;
            attributes.push(Attribute {
                name: attribute_name,
                value,
                span: attribute_span,
            });
        };

        if name.eq_ignore_ascii_case("script") || name.eq_ignore_ascii_case("style") {
            return Err(Diagnostic::new(
                span,
                format!("<{name}> elements are not supported inside a template"),
            ));
        }
        let children =
            if self_closing || VOID_ELEMENTS.contains(&name.to_ascii_lowercase().as_str()) {
                Vec::new()
            } else {
                self.parse_nodes(Some(&name))?
            };
        Ok(Element {
            name,
            attributes,
            children,
            span,
        })
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

    /// `{ expression }` at the cursor, parsed, with errors placed at their file position.
    fn parse_braced_expression(&mut self) -> Result<(Expression, Span), Diagnostic> {
        let braced = self.cursor.scan_braced()?;
        if braced.inner.trim().is_empty() {
            return Err(Diagnostic::new(braced.open_span, "empty {} expression"));
        }
        let expression = expression::parse(braced.inner).map_err(|error| {
            // `{{ name }}` parses as an (invalid) object literal; it's almost certainly v0.2.
            let inner = braced.inner.trim();
            if let Some(name) = inner
                .strip_prefix('{')
                .and_then(|rest| rest.strip_suffix('}'))
            {
                let name = name.trim();
                if is_identifier(name) {
                    return Diagnostic::new(
                        braced.open_span,
                        "`{{ … }}` is v0.2 syntax; v0.3 uses single braces",
                    )
                    .with_help(format!("write {{{name}}} instead of {{{{ {name} }}}}"));
                }
            }
            Diagnostic::new(
                span_after(braced.inner_span, braced.inner, error.offset),
                error.message,
            )
        })?;
        Ok((expression, braced.open_span))
    }

    /// Text up to `<` (or the closing quote), splitting out `{expression}` parts.
    fn parse_parts(&mut self, quote: Option<char>) -> Result<Vec<Part>, Diagnostic> {
        let mut parts = Vec::new();
        let source = self.cursor.source();
        let mut literal_start = self.cursor.position();
        while let Some(byte) = self.cursor.peek_byte() {
            if quote.is_some_and(|quote| byte == quote as u8) || quote.is_none() && byte == b'<' {
                break;
            }
            if byte == b'{' {
                if literal_start < self.cursor.position() {
                    parts.push(Part::Literal(
                        source[literal_start..self.cursor.position()].to_owned(),
                    ));
                }
                let (expression, span) = self.parse_braced_expression()?;
                parts.push(Part::Expression { expression, span });
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

fn check_attribute(name: &str, value: &AttributeValue, span: Span) -> Result<(), Diagnostic> {
    let lower = name.to_ascii_lowercase();
    if lower == "style" {
        return Err(Diagnostic::new(
            span,
            "inline style attributes are not supported; use component styles in a later release",
        ));
    }
    if is_event_attribute(&lower) && !matches!(value, AttributeValue::Expression(..)) {
        return Err(
            Diagnostic::new(span, "inline event-handler attributes are not allowed")
                .with_help(format!("pass a function from <script>: {name}={{handler}}")),
        );
    }
    Ok(())
}

pub(crate) fn is_event_attribute(name: &str) -> bool {
    name.starts_with("on")
        && name.len() > 2
        && name[2..].bytes().all(|byte| byte.is_ascii_alphabetic())
}

// ---- directives ----------------------------------------------------------------------------

fn lower_directive(element: Element) -> Result<Node, Diagnostic> {
    let lower = element.name.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("mnix-") {
        if matches!(rest, "if" | "else" | "each" | "slot") {
            return Err(Diagnostic::new(
                element.span,
                format!("<{}> was renamed to <mnx-{rest}> in v0.3", element.name),
            ));
        }
    }
    match lower.as_str() {
        "mnx-if" => {
            allow_attributes(&element, &["test"])?;
            let (test, test_span) = required_expression(&element, "test")?;
            let mut consequent = Vec::new();
            let mut alternate = None;
            for child in element.children {
                match child {
                    Node::Else { children, span } => {
                        if alternate.is_some() {
                            return Err(Diagnostic::new(span, "mnx-if may contain only one mnx-else"));
                        }
                        alternate = Some(children);
                    }
                    Node::Text(parts)
                        if alternate.is_some()
                            && parts.iter().all(|part| matches!(part, Part::Literal(text) if text.trim().is_empty())) => {}
                    child => {
                        if alternate.is_some() {
                            return Err(Diagnostic::new(element.span, "mnx-else must be the final child of mnx-if"));
                        }
                        consequent.push(child);
                    }
                }
            }
            Ok(Node::If {
                test,
                test_span,
                consequent,
                alternate: alternate.unwrap_or_default(),
                span: element.span,
            })
        }
        "mnx-each" => {
            allow_attributes(&element, &["items", "as", "index", "key"])?;
            let (items, items_span) = required_expression(&element, "items")?;
            let item = required_text(&element, "as")?;
            if !is_identifier(&item) {
                return Err(Diagnostic::new(
                    element.span,
                    "mnx-each as must be a valid identifier",
                ));
            }
            let index = optional_text(&element, "index")?;
            if index
                .as_deref()
                .is_some_and(|index| !is_identifier(index) || index == item)
            {
                return Err(Diagnostic::new(
                    element.span,
                    "mnx-each index must be a valid identifier different from `as`",
                ));
            }
            let key = find(&element, "key")
                .map(|_| required_expression(&element, "key"))
                .transpose()?;
            Ok(Node::Each {
                items,
                items_span,
                item,
                index,
                key,
                children: element.children,
                span: element.span,
            })
        }
        "mnx-slot" => {
            allow_attributes(&element, &["name"])?;
            let name = match optional_text(&element, "name")? {
                None => "default".to_owned(),
                Some(name) if name == "default" || is_identifier(&name) => name,
                Some(_) => {
                    return Err(Diagnostic::new(
                        element.span,
                        "mnx-slot name must be `default` or a valid identifier",
                    ));
                }
            };
            Ok(Node::Slot {
                name,
                fallback: element.children,
                span: element.span,
            })
        }
        "mnx-else" => {
            if !element.attributes.is_empty() {
                return Err(Diagnostic::new(
                    element.span,
                    "mnx-else does not accept attributes",
                ));
            }
            Ok(Node::Else {
                children: element.children,
                span: element.span,
            })
        }
        _ => Ok(Node::Element(element)),
    }
}

fn allow_attributes(element: &Element, allowed: &[&str]) -> Result<(), Diagnostic> {
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

fn find<'e>(element: &'e Element, name: &str) -> Option<&'e Attribute> {
    element
        .attributes
        .iter()
        .find(|attribute| attribute.name.eq_ignore_ascii_case(name))
}

fn required_expression(element: &Element, name: &str) -> Result<(Expression, Span), Diagnostic> {
    match find(element, name).map(|attribute| (&attribute.value, attribute.span)) {
        Some((AttributeValue::Expression(expression, span), _)) => Ok((expression.clone(), *span)),
        Some((AttributeValue::Text(_), span)) => Err(Diagnostic::new(
            span,
            format!(
                "`{name}` on <{}> is an expression: write {name}={{…}}",
                element.name
            ),
        )),
        Some((AttributeValue::None, span)) => Err(Diagnostic::new(
            span,
            format!("`{name}` on <{}> needs a value: {name}={{…}}", element.name),
        )),
        None => Err(Diagnostic::new(
            element.span,
            format!("<{}> requires a `{name}={{…}}` attribute", element.name),
        )),
    }
}

fn required_text(element: &Element, name: &str) -> Result<String, Diagnostic> {
    optional_text(element, name)?.ok_or_else(|| {
        Diagnostic::new(
            element.span,
            format!("<{}> requires a `{name}` attribute", element.name),
        )
    })
}

fn optional_text(element: &Element, name: &str) -> Result<Option<String>, Diagnostic> {
    let Some(attribute) = find(element, name) else {
        return Ok(None);
    };
    match &attribute.value {
        AttributeValue::Text(parts) => match parts.as_slice() {
            [Part::Literal(text)] => Ok(Some(text.clone())),
            _ => Err(Diagnostic::new(
                attribute.span,
                format!("attribute `{name}` must be static text"),
            )),
        },
        _ => Err(Diagnostic::new(
            attribute.span,
            format!("attribute `{name}` must be quoted text, e.g. {name}=\"item\""),
        )),
    }
}
