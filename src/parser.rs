//! Parsing a `.zb` single-file component into a [`ComponentAst`].
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
        Attribute, AttributeValue, ComponentAst, Element, Node, Part, PropDecl, PropDefault,
        Script, Style,
    },
    diagnostic::{Diagnostic, Span},
    expression::{self, Expression},
    scanner::{span_after, Cursor},
    script,
};

pub(crate) const VOID_ELEMENTS: &[&str] = &[
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

    // One <script> and one <style>, in either order, before the host element.
    let mut script = None;
    let mut style = None;
    let mut host_comment = None;
    loop {
        if parser.cursor.starts_with_ignore_ascii_case("<script") {
            if script.is_some() {
                return Err(parser.error("a component has one <script>"));
            }
            script = Some(parser.parse_script_block()?);
        } else if parser.cursor.starts_with_ignore_ascii_case("<style") {
            if style.is_some() {
                return Err(parser.error("a component has one <style>"));
            }
            style = Some(parser.parse_style_block()?);
        } else {
            break;
        }
        host_comment = parser.skip_whitespace_and_comments()?;
    }
    let mut script = script.unwrap_or_default();

    if !parser.starts_with("<") || parser.starts_with("</") {
        return Err(
            parser.error("expected the component's host element, e.g. <my-element>…</my-element>")
        );
    }
    let host = parser.parse_raw_element()?;
    parser.skip_whitespace_and_comments()?;
    if !parser.cursor.is_at_end() {
        return Err(parser.error(
            "unexpected content after the host element; a component file has a <script>, a <style> and then its host element",
        ));
    }

    let mut props = Vec::new();
    let mut shadow = false;
    let mut form_associated = false;
    let mut host_reset = None;
    for attribute in host.attributes {
        if attribute.name.to_ascii_lowercase().starts_with("zb-") {
            return Err(Diagnostic::new(
                attribute.span,
                if CONDITIONS
                    .iter()
                    .any(|name| attribute.name.eq_ignore_ascii_case(name))
                {
                    format!("`{}` can't go on the host: the host is always rendered; put the condition on an element inside it", attribute.name)
                } else {
                    format!("`{}`: the zb- prefix is reserved for the format, so a prop can't start with it", attribute.name)
                },
            ));
        }
        if attribute.name == "shadow" && attribute.value == AttributeValue::None {
            shadow = true;
            continue;
        }
        if attribute.name == "form-associated" && attribute.value == AttributeValue::None {
            form_associated = true;
            continue;
        }
        if attribute.name == "host-reset" && attribute.value == AttributeValue::None {
            host_reset = Some(attribute.span);
            continue;
        }
        // `value:model={…}`: a two-way prop.
        let model = attribute.name.ends_with(":model");
        let attribute = if model {
            Attribute {
                name: attribute.name.trim_end_matches(":model").to_owned(),
                ..attribute
            }
        } else {
            attribute
        };
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
            model,
            span: attribute.span,
        });
    }

    // A prop's name is the prop in the script too (2.0), so the script can't declare it.
    for prop in props.iter() {
        let declared = script
            .bindings
            .iter()
            .find(|binding| binding.name == prop.name)
            .map(|binding| binding.span)
            .or_else(|| {
                script
                    .runtime_names
                    .contains(&prop.name)
                    .then_some(prop.span)
            });
        if let Some(span) = declared {
            return Err(Diagnostic::new(
                span,
                format!(
                    "the script declares `{}`, which is also a prop: a prop's name is the prop in the script too",
                    prop.name
                ),
            )
            .with_help(format!(
                "rename the script's `{}` (e.g. `{}Default`, and `{}={{{}Default}}` on the host)",
                prop.name, prop.name, kebab_attribute(&prop.name), prop.name
            )));
        }
    }

    // A collection's documents are keyed by props, so they must be props.
    if let Some(collection) = &script.collection {
        for key in &collection.keys {
            if !props.iter().any(|prop| &prop.name == key) {
                return Err(Diagnostic::new(
                    collection.span,
                    format!("'use collection {}' keys documents by the prop `{key}`, which the host doesn't declare", collection.name),
                )
                .with_help(format!("add it to the host tag: `{}=\"\"`", kebab_attribute(key))));
            }
        }
    }

    // Events emitted from the template's runtime expressions count too.
    if let Some(emit) = script.emit.clone() {
        let mut found = Ok(Vec::new());
        crate::ast::for_each_expression(&host.children, &mut |expression, span| {
            if let (Expression::Runtime { source, .. }, Ok(emits)) = (expression, &mut found) {
                match crate::script::template_emits(source, &emit, span) {
                    Ok(more) => emits.extend(more),
                    Err(error) => found = Err(error),
                }
            }
        });
        script.emits.extend(found?);
    }

    // A comment right above the host tag (or above the script) documents the component.
    let description = host_comment
        .or(leading_comment)
        .map(|text| dedent(&text))
        .filter(|text| !text.is_empty());
    if let (Some(span), false) = (host_reset, shadow) {
        return Err(Diagnostic::new(span, "`host-reset` protects a shadow-DOM component's host from the page's styles; add `shadow` too")
            .with_help("in light DOM there's no boundary to protect: the page's styles apply by design"));
    }
    let mut nodes = host.children;
    resolve_server_exports(&mut script, &host.name, &mut nodes);
    Ok(ComponentAst {
        tag: host.name,
        tag_span: host.span,
        description,
        shadow,
        form_associated,
        host_reset: host_reset.is_some(),
        style,
        props,
        script,
        nodes,
        children: Vec::new(),
    })
}

/// Parse a template fragment (slot content supplied at build time).
/// Slot content: a zubra template, or (`html`) markup a server already rendered, kept as written.
pub(crate) fn parse_slot(source: &str, html: bool) -> Result<Vec<Node>, Diagnostic> {
    let normalized = normalize(source);
    let mut parser = TemplateParser::new(Cursor::new(&normalized));
    parser.html = html;
    let nodes = parser.parse_nodes(None)?;
    if !parser.cursor.is_at_end() {
        return Err(parser.error("unexpected content after slot template"));
    }
    Ok(nodes)
}

/// Where the `{…}` at byte `open` of a template ends (just past its `}`), read the way the
/// template parser reads it: markup in braces included. For the formatter, which keeps braces
/// as written and only needs to step over them.
pub(crate) fn braces_end(source: &str, open: usize) -> Result<usize, Diagnostic> {
    let mut cursor = Cursor::new(source);
    cursor.advance(open);
    if markup_in_braces(source, open).is_some() {
        let mut parser = TemplateParser::new(cursor);
        parser.parse_markup_braces()?;
        Ok(parser.cursor.position())
    } else {
        cursor.scan_braced()?;
        Ok(cursor.position())
    }
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
    if name == SPREAD {
        return Err(Diagnostic::new(
            attribute.span,
            "the host tag declares the component's props, so it can't take a {...} spread",
        )
        .with_help("spread onto an element inside the component"));
    }
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
    /// Already-rendered HTML (a server's slot content): braces are text, comments are kept,
    /// and `<script>`, `<style>`, unquoted and inline-handler attributes are allowed as written.
    html: bool,
    /// How many elements deep the parser is (see [`MAX_DEPTH`]).
    depth: usize,
}

/// How deep elements may nest, in a template or in slot content. The parser and every pass
/// after it recurse once per level, so without a limit a deep enough input (slot HTML is the
/// page's, not the author's) overflows the stack: a crash natively, and in WebAssembly a trap
/// that leaves the compiler unusable. Browsers stop nesting at 512; hand-written markup rarely
/// passes 30.
pub const MAX_DEPTH: usize = 256;

impl<'a> TemplateParser<'a> {
    fn new(cursor: Cursor<'a>) -> Self {
        Self {
            cursor,
            html: false,
            depth: 0,
        }
    }

    /// `<style>`, with optional `layer="…"` (the cascade layer; `none` for no layer) and
    /// `lang="…"` (a preprocessor for the bundler to run, e.g. `scss`).
    fn parse_style_block(&mut self) -> Result<Style, Diagnostic> {
        let span = self.current_span();
        self.advance("<style".len());
        self.skip_whitespace();
        let mut layer = Some("components".to_owned());
        let mut lang = None;
        while !self.starts_with(">") {
            let at = self.current_span();
            let rest = self.cursor.rest();
            let name_end = rest
                .find('=')
                .filter(|end| rest[..*end].chars().all(|c| c.is_ascii_alphabetic()));
            let Some(name_end) = name_end else {
                return Err(Diagnostic::new(
                    at,
                    "<style> takes `layer=\"…\"` and `lang=\"…\"` attributes",
                ));
            };
            let name = rest[..name_end].to_ascii_lowercase();
            let quote = rest[name_end + 1..]
                .chars()
                .next()
                .filter(|quote| *quote == '"' || *quote == '\'');
            let Some(quote) = quote else {
                return Err(Diagnostic::new(
                    at,
                    format!("`{name}` on <style> needs a quoted value"),
                ));
            };
            let value_start = name_end + 2;
            let Some(length) = rest[value_start..].find(quote) else {
                return Err(Diagnostic::new(at, "unterminated attribute value"));
            };
            let value = rest[value_start..value_start + length].trim().to_owned();
            match name.as_str() {
                "layer" if value == "none" => layer = None,
                "layer"
                    if !value.is_empty()
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) =>
                {
                    layer = Some(value)
                }
                "layer" => {
                    return Err(Diagnostic::new(
                        at,
                        format!("`{value}` isn't a cascade layer name"),
                    ))
                }
                "lang" if !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric()) => {
                    lang = (value != "css").then_some(value);
                }
                "lang" => {
                    return Err(Diagnostic::new(
                        at,
                        format!("`{value}` isn't a stylesheet language"),
                    ))
                }
                other => {
                    return Err(Diagnostic::new(
                        at,
                        format!("<style> takes `layer` and `lang`, not `{other}`"),
                    ))
                }
            }
            self.advance(value_start + length + 1);
            self.skip_whitespace();
        }
        self.advance(1);
        let css_span = self.current_span();
        let rest = self.cursor.rest();
        let Some(end) = rest.to_ascii_lowercase().find("</style") else {
            return Err(Diagnostic::new(span, "missing </style>"));
        };
        let css = rest[..end].to_owned();
        self.advance(end + "</style".len());
        self.skip_whitespace();
        if !self.starts_with(">") {
            return Err(self.error("expected > after </style"));
        }
        self.advance(1);
        Ok(Style {
            css,
            layer,
            lang,
            span: css_span,
        })
    }

    fn parse_script_block(&mut self) -> Result<Script, Diagnostic> {
        let span = self.current_span();
        self.advance("<script".len());
        self.skip_whitespace();
        // `lang="ts"` is the one attribute: the script is TypeScript (erasable syntax only).
        let mut typescript = false;
        for quote in ['"', '\''] {
            let attribute = format!("lang={quote}ts{quote}");
            if self.starts_with(&attribute) {
                typescript = true;
                self.advance(attribute.len());
                self.skip_whitespace();
            }
        }
        if !self.starts_with(">") {
            return Err(Diagnostic::new(
                span,
                "<script> in a component takes no attributes except lang=\"ts\" (it is always a module)",
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
        script::parse(body, body_span, typescript)
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
        // An open `zb-if` attribute chain: the index of its node, and whether a `zb-else` ended it.
        let mut chain: Option<(usize, bool)> = None;
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
                let start = self.cursor.position();
                // Comments are authoring notes; they are not emitted (a server's are kept: they
                // may be its hydration markers).
                self.skip_comment()?;
                if self.html {
                    let comment = self.cursor.source()[start..self.cursor.position()].to_owned();
                    nodes.push(Node::Text(vec![Part::Literal(comment)]));
                }
                continue;
            }
            if self.html && self.cursor.starts_with_ignore_ascii_case("<!doctype") {
                return Err(self.error("a doctype can't be slot content"));
            }
            if self.starts_with("<!") || self.starts_with("<?") {
                return Err(self
                    .error("doctype and processing instructions are not supported in templates"));
            }
            if self.starts_with("<") {
                let mut element = self.parse_raw_element()?;
                if self.html {
                    nodes.push(Node::Element(element));
                    chain = None;
                    continue;
                }
                let condition = take_condition(&mut element)?;
                let animate = take_animate(&mut element, condition.as_ref())?;
                reserved_attributes(&element)?;
                let node = lower_directive(element)?;
                match condition {
                    None => {
                        nodes.push(node);
                        chain = None;
                    }
                    Some(Condition::If(test, test_span, span)) => {
                        nodes.push(Node::If {
                            test,
                            test_span,
                            consequent: vec![node],
                            alternate: Vec::new(),
                            animate,
                            span,
                        });
                        chain = Some((nodes.len() - 1, false));
                    }
                    Some(condition) => {
                        attach_branch(&mut nodes, &mut chain, condition, node)?;
                    }
                }
            } else if !self.html
                && self.starts_with("{")
                && markup_in_braces(self.cursor.source(), self.cursor.position()).is_some()
            {
                let node = self.parse_markup_braces()?;
                nodes.push(node);
                chain = None;
            } else {
                let parts = self.parse_parts(None)?;
                // A comment between two runs of text was stripped, so in the DOM they are one
                // text node; keep them as one here too.
                if let Some(Node::Text(previous)) = nodes.last_mut() {
                    previous.extend(parts);
                } else {
                    nodes.push(Node::Text(parts));
                }
                // Text between two branches of an attribute chain ends it, unless it's only
                // whitespace.
                if let Some(Node::Text(text)) = nodes.last() {
                    if !is_blank(text) {
                        chain = None;
                    }
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
            if !self.html
                && self.starts_with("{")
                && name.eq_ignore_ascii_case("zb-await")
                && !self.cursor.rest()[1..].trim_start().starts_with("...")
            {
                // `<zb-await {user}>` is `<zb-await value={user}>` (4.2).
                let (expression, span) = self.parse_braced_expression()?;
                if !seen.insert("value".to_owned()) {
                    return Err(Diagnostic::new(
                        attribute_span,
                        "duplicate attribute `value`",
                    ));
                }
                attributes.push(Attribute {
                    name: "value".to_owned(),
                    value: AttributeValue::Expression(expression, span),
                    span: attribute_span,
                });
                continue;
            }
            if !self.html && self.starts_with("{") {
                let (expression, span) = self.parse_spread()?;
                attributes.push(Attribute {
                    name: SPREAD.to_owned(),
                    value: AttributeValue::Expression(expression, span),
                    span: attribute_span,
                });
                continue;
            }
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
                if self.starts_with("{") && !self.html {
                    let (expression, expression_span) = self.parse_braced_expression()?;
                    AttributeValue::Expression(expression, expression_span)
                } else if self.html && !(self.starts_with("\"") || self.starts_with("'")) {
                    let value = self
                        .cursor
                        .take_while(|byte| !byte.is_ascii_whitespace() && byte != b'>');
                    AttributeValue::Text(vec![Part::Literal(value.to_owned())])
                } else if (self.starts_with("\"") || self.starts_with("'"))
                    && !self.html
                    && attribute_name.eq_ignore_ascii_case("as")
                    && ["zb-each", "zb-then", "zb-catch"]
                        .iter()
                        .any(|directive| name.eq_ignore_ascii_case(directive))
                {
                    // `as="{ name, email }"`: braces in `as` are a pattern, not an interpolation.
                    let quote = self.cursor.peek_byte().unwrap_or(b'"');
                    self.advance(1);
                    let raw = self.cursor.take_while(|byte| byte != quote);
                    if self.cursor.is_at_end() {
                        return Err(self.error("unterminated attribute value"));
                    }
                    self.advance(1);
                    AttributeValue::Text(vec![Part::Literal(raw.to_owned())])
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
            // `onchange.submit` needs no handler: the modifier is what it does.
            let value = match value {
                AttributeValue::None
                    if !self.html
                        && is_event_attribute(&attribute_name.to_ascii_lowercase())
                        && event_parts(&attribute_name.to_ascii_lowercase())
                            .is_ok_and(|(_, modifiers)| modifiers.submit) =>
                {
                    AttributeValue::Expression(Expression::Null, attribute_span)
                }
                value => value,
            };
            if !self.html {
                check_attribute(&attribute_name, &value, attribute_span)?;
            }
            attributes.push(Attribute {
                name: attribute_name,
                value,
                span: attribute_span,
            });
        };

        let attributes = if self.html {
            attributes
        } else {
            expand_directives(attributes, &name)?
        };
        let raw_text = ["script", "style", "textarea", "title"]
            .iter()
            .any(|raw| name.eq_ignore_ascii_case(raw));
        if self.html && raw_text && !self_closing {
            // Raw text: everything up to the closing tag, as written.
            let lower = self.cursor.rest().to_ascii_lowercase();
            let Some(end) = lower.find(&format!("</{}", name.to_ascii_lowercase())) else {
                return Err(Diagnostic::new(
                    span,
                    format!("missing closing tag </{name}>"),
                ));
            };
            let text = self.cursor.rest()[..end].to_owned();
            self.advance(end + 2 + name.len());
            self.skip_whitespace();
            if !self.starts_with(">") {
                return Err(self.error("expected > after closing tag"));
            }
            self.advance(1);
            return Ok(Element {
                name,
                attributes,
                children: vec![Node::Text(vec![Part::Literal(text)])],
                span,
            });
        }
        if name.eq_ignore_ascii_case("script") || name.eq_ignore_ascii_case("style") {
            return Err(Diagnostic::new(
                span,
                format!("<{name}> elements are not supported inside a template"),
            ));
        }
        let children = if self_closing
            || VOID_ELEMENTS.contains(&name.to_ascii_lowercase().as_str())
        {
            Vec::new()
        } else {
            if self.depth >= MAX_DEPTH {
                return Err(Diagnostic::new(
                        span,
                        format!("markup is nested more than {MAX_DEPTH} elements deep"),
                    )
                    .with_help(if self.html {
                        "slot content this deep can't be rendered on the server; leave it to the browser, or flatten it"
                    } else {
                        "split the template into components: each one starts again at its own host"
                    }));
            }
            self.depth += 1;
            let children = self.parse_nodes(Some(&name))?;
            self.depth -= 1;
            children
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
        if let Some(at) = markup_in_braces(self.cursor.source(), self.cursor.position()) {
            let mut cursor = self.cursor.clone();
            cursor.advance(at - self.cursor.position());
            return Err(Diagnostic::new(
                cursor.span(),
                "markup can't go in an attribute's {…}; it works in text, as {cond && <p>…</p>}",
            )
            .with_help("pass the data instead, and let the element render it, or use a slot"));
        }
        let braced = self.cursor.scan_braced()?;
        if braced.inner.trim().is_empty() {
            return Err(Diagnostic::new(braced.open_span, "empty {} expression"));
        }
        expression_text(braced.inner, braced.open_span, braced.inner_span)
    }

    /// `{...expression}` in a start tag: an object whose entries become the element's attributes
    /// and listeners.
    fn parse_spread(&mut self) -> Result<(Expression, Span), Diagnostic> {
        let braced = self.cursor.scan_braced()?;
        let lead = braced.inner.len() - braced.inner.trim_start().len();
        let Some(rest) = braced.inner.trim_start().strip_prefix("...") else {
            return Err(Diagnostic::new(
                braced.open_span,
                "a {…} in a start tag must spread an object: {...attributes}",
            )
            .with_help("give an attribute a name to bind one value: name={…}"));
        };
        if rest.trim().is_empty() {
            return Err(Diagnostic::new(braced.open_span, "empty {...} spread"));
        }
        let rest_span = span_after(braced.inner_span, braced.inner, lead + 3);
        let (expression, _) = expression_text(rest, braced.open_span, rest_span)?;
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
            if byte == b'{' && !self.html {
                if quote.is_none() && markup_in_braces(source, self.cursor.position()).is_some() {
                    break; // the caller parses it as nodes
                }
                if literal_start < self.cursor.position() {
                    parts.push(Part::Literal(
                        source[literal_start..self.cursor.position()].to_owned(),
                    ));
                }
                let (expression, span) = self.parse_braced_expression()?;
                // `{{ name }}` is a shorthand object to JavaScript, but in text it's almost
                // certainly v0.2's interpolation.
                if let Expression::Object(entries) = &expression {
                    if let [(key, Expression::Identifier(value))] = entries.as_slice() {
                        if key == value {
                            return Err(Diagnostic::new(
                                span,
                                "`{{ … }}` is v0.2 syntax; v0.3 uses single braces",
                            )
                            .with_help(format!("write {{{key}}} instead of {{{{ {key} }}}}")));
                        }
                    }
                }
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

    /// Markup in a text `{…}` (`.zb` grammar inside), in the three forms that are directives:
    /// `{a && <p>…</p>}` is a zb-if, `{a ? <b>…</b> : <i>…</i>}` a zb-if with a zb-else (either
    /// side may be text, an expression or `null`), and `{list.map((item, i) => <li key={…}>…</li>)}`
    /// a zb-each.
    fn parse_markup_braces(&mut self) -> Result<Node, Diagnostic> {
        let source = self.cursor.source();
        let open = self.cursor.position();
        let start = self.cursor.clone();
        let span = self.current_span();
        let at = markup_in_braces(source, open).expect("checked by the caller");
        let span_of = |offset: usize| {
            let mut cursor = start.clone();
            cursor.advance(offset - open);
            cursor.span()
        };
        let expression = |from: usize, to: usize| -> Result<(Expression, Span), Diagnostic> {
            let inner = &source[from..to];
            if inner.trim().is_empty() {
                return Err(Diagnostic::new(
                    span_of(from),
                    "expected an expression here",
                ));
            }
            let lead = inner.len() - inner.trim_start().len();
            let (expression, _) = expression_text(inner, span_of(from + lead), span_of(from))?;
            Ok((expression, span_of(from + lead)))
        };
        let tops = TopLevel::scan(source, open + 1, at);
        let forms = "markup in braces takes three forms: {cond && <p>…</p>}, {cond ? <a>…</a> : <b>…</b>} and {list.map((item) => <li key={item.id}>…</li>)}";

        // `a ? x : y`
        if let Some(question) = tops.question {
            let (test, test_span) = expression(open + 1, question)?;
            self.cursor = start.clone();
            self.cursor.advance(question + 1 - open);
            let consequent = self.braced_branch(b':')?;
            if !self.starts_with(":") {
                return Err(self.error("expected : and the other branch of the ? :"));
            }
            self.advance(1);
            let alternate = self.braced_branch(b'}')?;
            self.close_brace()?;
            return Ok(Node::If {
                test,
                test_span,
                consequent,
                alternate,
                animate: false,
                span,
            });
        }
        let before = source[open + 1..at].trim_end();
        let (before, parenthesized) = match before.strip_suffix('(') {
            Some(rest) => (rest.trim_end(), true),
            None => (before, false),
        };
        // `a && <x/>`
        if before.ends_with("&&") {
            let and = open + 1 + before.len() - 2;
            if tops.ands.last() != Some(&and) {
                return Err(Diagnostic::new(span_of(at), forms));
            }
            let (test, test_span) = expression(open + 1, and)?;
            self.cursor = start.clone();
            self.cursor.advance(at - open);
            let node = self.braced_element(None)?;
            self.close_parenthesis(parenthesized)?;
            self.close_brace()?;
            return Ok(Node::If {
                test,
                test_span,
                consequent: vec![node],
                alternate: Vec::new(),
                animate: false,
                span,
            });
        }
        // `list.map((item, i) => <x/>)`
        if before.ends_with("=>") {
            if let Some(&map) = tops.maps.last() {
                let call = map + ".map(".len();
                let arrow = open + 1 + before.len() - 2;
                let parameters = source[call..arrow].trim();
                let parameters = parameters
                    .strip_prefix('(')
                    .and_then(|rest| rest.strip_suffix(')'))
                    .unwrap_or(parameters);
                let names = split_top_level(parameters);
                let bindable = |item: &str| {
                    is_identifier(item)
                        || crate::ast::is_pattern(item) && crate::ast::bindings(item).is_ok()
                };
                let (item, index) = match names.as_slice() {
                    [item] if bindable(item) => (item.to_string(), None),
                    [item, index] if bindable(item) && is_identifier(index) && item != index => {
                        (item.to_string(), Some(index.to_string()))
                    }
                    _ => {
                        return Err(Diagnostic::new(
                            span_of(call),
                            "the .map() callback takes the item (a name or a { … } / [ … ] pattern), and optionally its index: (item) or (item, i); for anything else use <zb-each>",
                        ))
                    }
                };
                let (items, items_span) = expression(open + 1, map)?;
                self.cursor = start.clone();
                self.cursor.advance(at - open);
                let mut key = None;
                let node = self.braced_element(Some(&mut key))?;
                self.close_parenthesis(parenthesized)?;
                self.skip_whitespace();
                if !self.starts_with(")") {
                    return Err(
                        self.error("expected ) to close .map(…); the callback returns one element")
                    );
                }
                self.advance(1);
                self.close_brace()?;
                return Ok(Node::Each {
                    items,
                    items_span,
                    item,
                    index,
                    key,
                    lets: Vec::new(),
                    children: vec![node],
                    animate: false,
                    span,
                });
            }
        }
        Err(Diagnostic::new(span_of(at), forms)
            .with_help("for anything else, use <zb-if test={…}> or <zb-each items={…} as=\"…\"> around the markup"))
    }

    /// One element of markup inside braces, lowered (its `key`, for a list, taken out).
    fn braced_element(
        &mut self,
        key: Option<&mut Option<(Expression, Span)>>,
    ) -> Result<Node, Diagnostic> {
        let mut element = self.parse_raw_element()?;
        if take_condition(&mut element)?.is_some() {
            return Err(Diagnostic::new(
                element.span,
                "the braces already decide whether this element renders; drop its zb-if/zb-else",
            ));
        }
        if let Some(key) = key {
            if let Some(at) = element
                .attributes
                .iter()
                .position(|attribute| attribute.name == "key")
            {
                let attribute = element.attributes.remove(at);
                match attribute.value {
                    AttributeValue::Expression(expression, span) => *key = Some((expression, span)),
                    _ => {
                        return Err(Diagnostic::new(
                            attribute.span,
                            "key is an expression: key={item.id}",
                        ))
                    }
                }
            }
        }
        reserved_attributes(&element)?;
        lower_directive(element)
    }

    /// One side of `? :` inside braces: an element, `null`, or an expression (as text).
    fn braced_branch(&mut self, stop: u8) -> Result<Vec<Node>, Diagnostic> {
        self.skip_whitespace();
        if self.starts_with("<") {
            let node = self.braced_element(None)?;
            self.skip_whitespace();
            return Ok(vec![node]);
        }
        if self.starts_with("(") && self.cursor.rest()[1..].trim_start().starts_with('<') {
            self.advance(1);
            self.skip_whitespace();
            let node = self.braced_element(None)?;
            self.close_parenthesis(true)?;
            self.skip_whitespace();
            return Ok(vec![node]);
        }
        let source = self.cursor.source();
        let from = self.cursor.position();
        let Some(to) = TopLevel::find(source, from, stop) else {
            return Err(self.error(if stop == b':' {
                "expected : in the ? :"
            } else {
                "expected } to close the expression"
            }));
        };
        let inner = source[from..to].trim_end();
        let span = self.current_span();
        self.advance(to - from);
        if inner == "null" || inner == "undefined" || inner == "false" {
            return Ok(Vec::new());
        }
        let (expression, span) = expression_text(inner, span, span)?;
        Ok(vec![Node::Text(vec![Part::Expression {
            expression,
            span,
        }])])
    }

    fn close_parenthesis(&mut self, open: bool) -> Result<(), Diagnostic> {
        if open {
            self.skip_whitespace();
            if !self.starts_with(")") {
                return Err(self.error("expected ) after the markup"));
            }
            self.advance(1);
        }
        Ok(())
    }

    fn close_brace(&mut self) -> Result<(), Diagnostic> {
        self.skip_whitespace();
        if !self.starts_with("}") {
            return Err(self.error("expected } after the markup: the braces hold one element"));
        }
        self.advance(1);
        Ok(())
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
        match value {
            AttributeValue::Text(parts)
                if parts
                    .iter()
                    .any(|part| matches!(part, Part::Expression { .. })) =>
            {
                return Err(Diagnostic::new(span, "a style attribute can't interpolate values")
                    .with_help("set each property with style:name={…} (e.g. style:width={`${percent}%`}), or pass an object: style={{ … }}"));
            }
            AttributeValue::Expression(Expression::Object(_), _)
            | AttributeValue::Text(_)
            | AttributeValue::None => {}
            AttributeValue::Expression(..) => {
                return Err(Diagnostic::new(
                    span,
                    "style={…} takes an object literal of properties",
                )
                .with_help("style={{ color: tone, \"--size\": size }}, or style:color={tone}"));
            }
        }
    }
    if let Some(rest) = lower.strip_prefix("on") {
        if rest.contains('.') || is_event_attribute(&lower) {
            if !matches!(value, AttributeValue::Expression(..)) {
                return Err(Diagnostic::new(
                    span,
                    "inline event-handler attributes are not allowed",
                )
                .with_help(format!("pass a function from <script>: {name}={{handler}}")));
            }
            event_parts(&lower).map_err(|message| Diagnostic::new(span, message))?;
        }
    }
    Ok(())
}

/// An event attribute (`onclick`, `onsubmit.prevent`, `onkeydown.shift.enter`).
pub(crate) fn is_event_attribute(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name);
    base.starts_with("on")
        && base.len() > 2
        && base[2..].bytes().all(|byte| byte.is_ascii_alphabetic())
        && name[base.len()..].split('.').skip(1).all(|modifier| {
            !modifier.is_empty() && modifier.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

/// What an event attribute's modifiers ask for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub prevent: bool,
    pub stop: bool,
    pub once: bool,
    pub self_only: bool,
    pub capture: bool,
    pub passive: bool,
    /// `event.key` values, any of which matches (`enter` → "Enter"); a single letter or digit
    /// matches case-insensitively.
    pub keys: Vec<String>,
    /// Shift, Ctrl, Alt and Meta: those named must be held, the others not (with a key filter).
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
    /// `.mod`: ⌘ on Apple platforms, Ctrl elsewhere (decided in the browser).
    pub primary: bool,
    /// `.submit`: after the handler, submit the element's form (`requestSubmit()`, so validation
    /// and `submit` listeners run).
    pub submit: bool,
}

pub const MODIFIERS: &[&str] = &[
    "prevent",
    "stop",
    "once",
    "self",
    "capture",
    "passive",
    "shift",
    "ctrl",
    "alt",
    "meta",
    "mod",
    "submit",
    "enter",
    "tab",
    "space",
    "esc",
    "escape",
    "up",
    "down",
    "left",
    "right",
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "delete",
    "backspace",
    "home",
    "end",
    "pageup",
    "pagedown",
];

/// `onkeydown.shift.enter` → `("keydown", modifiers)`; an error for an unknown modifier.
pub fn event_parts(lower: &str) -> Result<(String, Modifiers), String> {
    let mut pieces = lower.split('.');
    let base = pieces.next().unwrap_or_default();
    let event = base.strip_prefix("on").unwrap_or(base).to_owned();
    let mut modifiers = Modifiers::default();
    let key_event = matches!(event.as_str(), "keydown" | "keyup" | "keypress");
    for modifier in pieces {
        let key = |name: &str| name.to_owned();
        match modifier {
            "prevent" => modifiers.prevent = true,
            "stop" => modifiers.stop = true,
            "once" => modifiers.once = true,
            "self" => modifiers.self_only = true,
            "capture" => modifiers.capture = true,
            "passive" => modifiers.passive = true,
            "shift" => modifiers.shift = true,
            "ctrl" => modifiers.ctrl = true,
            "alt" => modifiers.alt = true,
            "meta" => modifiers.meta = true,
            "mod" => modifiers.primary = true,
            "submit" => modifiers.submit = true,
            _ if !key_event => {
                return Err(if MODIFIERS.contains(&modifier) || modifier.len() == 1 {
                    format!(
                        "`.{modifier}` filters keys, so it only goes on keydown, keyup or keypress"
                    )
                } else {
                    unknown_modifier(modifier)
                });
            }
            "enter" => modifiers.keys.push(key("Enter")),
            "tab" => modifiers.keys.push(key("Tab")),
            "space" => modifiers.keys.push(key(" ")),
            "esc" | "escape" => modifiers.keys.push(key("Escape")),
            "up" | "arrowup" => modifiers.keys.push(key("ArrowUp")),
            "down" | "arrowdown" => modifiers.keys.push(key("ArrowDown")),
            "left" | "arrowleft" => modifiers.keys.push(key("ArrowLeft")),
            "right" | "arrowright" => modifiers.keys.push(key("ArrowRight")),
            "delete" => modifiers.keys.push(key("Delete")),
            "backspace" => modifiers.keys.push(key("Backspace")),
            "home" => modifiers.keys.push(key("Home")),
            "end" => modifiers.keys.push(key("End")),
            "pageup" => modifiers.keys.push(key("PageUp")),
            "pagedown" => modifiers.keys.push(key("PageDown")),
            single if single.len() == 1 => modifiers.keys.push(single.to_owned()),
            other => return Err(unknown_modifier(other)),
        }
    }
    if modifiers.primary && (modifiers.ctrl || modifiers.meta) {
        return Err("`.mod` already means Ctrl, or ⌘ on Apple platforms: use it instead of `.ctrl` or `.meta`, not with them".to_owned());
    }
    if modifiers.passive && modifiers.prevent {
        return Err("`.passive` and `.prevent` contradict each other: a passive listener can't prevent the default".to_owned());
    }
    Ok((event, modifiers))
}

fn unknown_modifier(modifier: &str) -> String {
    let close = MODIFIERS
        .iter()
        .min_by_key(|candidate| crate::validate::edit_distance(modifier, candidate))
        .filter(|candidate| crate::validate::edit_distance(modifier, candidate) <= 2);
    match close {
        Some(close) => format!("unknown event modifier `.{modifier}`; did you mean `.{close}`?"),
        None => format!(
            "unknown event modifier `.{modifier}` (modifiers: {}, or a single letter or digit key)",
            MODIFIERS.join(", ")
        ),
    }
}

/// `class={{ … }}` and `style={{ … }}` become one `class:name`/`style:name` attribute per entry;
/// bare `class:active` means `class:active={active}`. Checks that `class:` and `style:` are well
/// formed.
fn expand_directives(
    attributes: Vec<Attribute>,
    element: &str,
) -> Result<Vec<Attribute>, Diagnostic> {
    let mut out = Vec::with_capacity(attributes.len());
    for attribute in attributes {
        let lower = attribute.name.to_ascii_lowercase();
        if let Some(prop) = attribute.name.strip_suffix(":bind") {
            // `value:bind={color}` on a custom element with a two-way `value`: the prop, and its
            // `valuechange` event assigning back.
            if !element.contains('-') {
                return Err(Diagnostic::new(
                    attribute.span,
                    format!(
                        "`{}` binds a custom element's two-way prop; a native <{element}> has none",
                        attribute.name
                    ),
                )
                .with_help(format!(
                    "write the pair: {prop}={{…}} oninput={{(event) => (… = event.target.{prop})}}"
                )));
            }
            let AttributeValue::Expression(Expression::Identifier(target), span) = &attribute.value
            else {
                return Err(Diagnostic::new(
                    attribute.span,
                    format!(
                        "`{}` takes a `let` or a prop to keep in step: {}={{color}}",
                        attribute.name, attribute.name
                    ),
                ));
            };
            let source = format!("(event) => ({target} = event.detail)");
            let names = crate::runtime_expression::parse(&source)
                .map_err(|(_, message)| Diagnostic::new(*span, message))?;
            out.push(Attribute {
                name: prop.to_owned(),
                value: AttributeValue::Expression(Expression::Identifier(target.clone()), *span),
                span: attribute.span,
            });
            out.push(Attribute {
                name: format!("on{}change", prop.to_ascii_lowercase()),
                value: AttributeValue::Expression(Expression::Runtime { source, names }, *span),
                span: attribute.span,
            });
            continue;
        }
        if lower == "class" || lower == "style" {
            if let AttributeValue::Expression(Expression::Object(entries), span) = &attribute.value
            {
                for (key, value) in entries {
                    let name = if lower == "style" && !key.starts_with("--") {
                        kebab_attribute(key)
                    } else {
                        key.clone()
                    };
                    out.push(Attribute {
                        name: format!("{lower}:{name}"),
                        value: AttributeValue::Expression(value.clone(), *span),
                        span: attribute.span,
                    });
                }
                continue;
            }
        }
        if lower == "ref" {
            // `ref={dialog}`: assign the element to `dialog`; or a function that takes it.
            let value = match &attribute.value {
                AttributeValue::Expression(Expression::Identifier(name), span) => {
                    let source = format!("($el) => ({name} = $el)");
                    let names = crate::runtime_expression::parse(&source)
                        .map_err(|(_, message)| Diagnostic::new(*span, message))?;
                    AttributeValue::Expression(Expression::Runtime { source, names }, *span)
                }
                AttributeValue::Expression(expression @ Expression::Runtime { .. }, span) => {
                    AttributeValue::Expression(expression.clone(), *span)
                }
                _ => {
                    return Err(Diagnostic::new(
                        attribute.span,
                        "ref takes a `let` to assign the element to (ref={dialog}), or a function that receives it",
                    ));
                }
            };
            out.push(Attribute {
                name: "ref".to_owned(),
                value,
                span: attribute.span,
            });
            continue;
        }
        if let Some((kind, name)) = lower
            .split_once(':')
            .filter(|(kind, _)| *kind == "class" || *kind == "style")
        {
            let original = attribute.name[kind.len() + 1..].to_owned();
            let valid = if kind == "class" {
                !original.is_empty() && !original.contains(char::is_whitespace)
            } else {
                (name.starts_with("--")
                    && name.len() > 2
                    && original[2..]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
                    || (!original.is_empty()
                        && original
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b == b'-'))
            };
            if !valid {
                return Err(Diagnostic::new(
                    attribute.span,
                    format!(
                        "`{}` doesn't name a {}",
                        attribute.name,
                        if kind == "class" {
                            "class"
                        } else {
                            "CSS property (lowercase, or a --custom-property)"
                        }
                    ),
                ));
            }
            let value = match attribute.value {
                AttributeValue::Expression(..) => attribute.value,
                AttributeValue::None => {
                    let variable = if kind == "class" {
                        original.clone()
                    } else if name.starts_with("--") {
                        String::new()
                    } else {
                        crate::validate::camel(name)
                    };
                    if !is_identifier(&variable) {
                        return Err(Diagnostic::new(
                            attribute.span,
                            format!("bare `{}` reads a variable named `{variable}`, which isn't a valid name: give it a value, {}={{…}}", attribute.name, attribute.name),
                        ));
                    }
                    AttributeValue::Expression(Expression::Identifier(variable), attribute.span)
                }
                AttributeValue::Text(_) => {
                    return Err(Diagnostic::new(
                        attribute.span,
                        format!(
                            "`{}` takes an expression: {}={{…}}",
                            attribute.name, attribute.name
                        ),
                    ));
                }
            };
            out.push(Attribute {
                name: format!("{kind}:{original}"),
                value,
                span: attribute.span,
            });
            continue;
        }
        out.push(attribute);
    }
    Ok(out)
}

// ---- directives ----------------------------------------------------------------------------

/// One branch of an `zb-if` chain: its test (none for `zb-else`), content and position.
type Branch = (Option<(Expression, Span)>, Vec<Node>, Span);

/// Where markup starts inside the `{…}` at `open`, if it does: a `<` and a letter, right after
/// an operator that can be followed by an operand (`&&`, `?`, `:`, `(`, `=>`, …). Strings and
/// template literals are skipped, and the scan stops at the closing brace.
fn markup_in_braces(source: &str, open: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut i = open + 1;
    let mut depth = 0i32;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_quoted(bytes, i)?;
                continue;
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' => depth -= 1,
            b'}' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
            }
            b'<' if bytes.get(i + 1).is_some_and(u8::is_ascii_alphabetic) => {
                let before = source[open + 1..i].trim_end();
                if ["&&", "||", "??", "?", ":", "(", "=>", ",", "["]
                    .iter()
                    .any(|operator| before.ends_with(operator))
                    || before.is_empty()
                {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Past a quoted string or template literal starting at `at` (escapes honoured).
fn skip_quoted(bytes: &[u8], at: usize) -> Option<usize> {
    let quote = bytes[at];
    let mut i = at + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            byte if byte == quote => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// The operators at the top level of `source[from..to]` (outside brackets and strings).
struct TopLevel {
    question: Option<usize>,
    ands: Vec<usize>,
    /// Where each `.map(` starts (its `.`).
    maps: Vec<usize>,
}

impl TopLevel {
    fn scan(source: &str, from: usize, to: usize) -> TopLevel {
        let bytes = source.as_bytes();
        let mut tops = TopLevel {
            question: None,
            ands: Vec::new(),
            maps: Vec::new(),
        };
        let mut depth = 0i32;
        let mut i = from;
        while i < to {
            match bytes[i] {
                b'\'' | b'"' | b'`' => {
                    i = skip_quoted(bytes, i).unwrap_or(to);
                    continue;
                }
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                b'?' if depth == 0 => {
                    let next = bytes.get(i + 1).copied();
                    let previous = i.checked_sub(1).map(|j| bytes[j]);
                    if next != Some(b'.')
                        && next != Some(b'?')
                        && previous != Some(b'?')
                        && tops.question.is_none()
                    {
                        tops.question = Some(i);
                    }
                }
                b'&' if depth == 0 && bytes.get(i + 1) == Some(&b'&') => {
                    tops.ands.push(i);
                    i += 2;
                    continue;
                }
                b'.' if depth == 0 && source[i..to].starts_with(".map(") => tops.maps.push(i),
                _ => {}
            }
            i += 1;
        }
        tops
    }

    /// The first `stop` byte at the top level from `from` (a `}` ends the scan when `stop` is `:`).
    fn find(source: &str, from: usize, stop: u8) -> Option<usize> {
        let bytes = source.as_bytes();
        let mut depth = 0i32;
        let mut i = from;
        while i < bytes.len() {
            match bytes[i] {
                b'\'' | b'"' | b'`' => {
                    i = skip_quoted(bytes, i)?;
                    continue;
                }
                byte if depth == 0 && byte == stop => return Some(i),
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' => depth -= 1,
                b'}' => {
                    if depth == 0 {
                        return None;
                    }
                    depth -= 1;
                }
                _ => {}
            }
            i += 1;
        }
        None
    }
}

/// `a, { b, c }, d` split at its top-level commas, each part trimmed.
fn split_top_level(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    for (i, byte) in text.bytes().enumerate() {
        match byte {
            b'{' | b'[' | b'(' => depth += 1,
            b'}' | b']' | b')' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(text[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(text[start..].trim());
    parts
}

/// An `as`: a name, or a destructuring pattern (4.2).
fn check_binding(text: &str, span: Span, what: &str) -> Result<(), Diagnostic> {
    if crate::ast::is_pattern(text) {
        return crate::ast::bindings(text)
            .map(|_| ())
            .map_err(|message| Diagnostic::new(span, format!("{what}: {message}")));
    }
    if is_identifier(text.trim()) {
        Ok(())
    } else {
        Err(Diagnostic::new(
            span,
            format!("{what} must be a valid identifier, or a {{ … }} or [ … ] pattern"),
        ))
    }
}

const CONDITIONS: [&str; 3] = ["zb-if", "zb-else-if", "zb-else"];

/// A condition written as an attribute: `<p zb-if={…}>`, `<p zb-else-if={…}>`, `<p zb-else>`.
enum Condition {
    If(Expression, Span, Span),
    ElseIf(Expression, Span, Span),
    Else(Span),
}

fn is_blank(parts: &[Part]) -> bool {
    parts
        .iter()
        .all(|part| matches!(part, Part::Literal(text) if text.trim().is_empty()))
}

/// Takes `zb-if`, `zb-else-if` or `zb-else` off an element, checking where it may go.
fn take_condition(element: &mut Element) -> Result<Option<Condition>, Diagnostic> {
    let mut found = element.attributes.iter().filter(|attribute| {
        CONDITIONS
            .iter()
            .any(|name| attribute.name.eq_ignore_ascii_case(name))
    });
    let Some(first) = found.next() else {
        return Ok(None);
    };
    if let Some(second) = found.next() {
        return Err(Diagnostic::new(
            second.span,
            format!(
                "an element takes one of zb-if, zb-else-if and zb-else, not both `{}` and `{}`",
                first.name, second.name
            ),
        ));
    }
    let name = first.name.to_ascii_lowercase();
    if element.name.to_ascii_lowercase().starts_with("zb-") {
        let wrap = if name == "zb-if" {
            format!(
                "wrap it: <zb-if test={{…}}><{}>…</{}></zb-if>",
                element.name, element.name
            )
        } else {
            format!("use the element form, <{name}>, around it")
        };
        return Err(Diagnostic::new(
            first.span,
            format!(
                "`{name}` can't go on <{}>, which is a directive; {wrap}",
                element.name
            ),
        ));
    }
    let at = element
        .attributes
        .iter()
        .position(|attribute| attribute.name.eq_ignore_ascii_case(&name))
        .expect("found above");
    let attribute = element.attributes.remove(at);
    let span = element.span;
    match (name.as_str(), attribute.value) {
        ("zb-else", AttributeValue::None) => Ok(Some(Condition::Else(span))),
        ("zb-else", _) => Err(Diagnostic::new(
            attribute.span,
            "`zb-else` takes no value; the condition is the branches before it",
        )),
        (_, AttributeValue::Expression(test, test_span)) => Ok(Some(if name == "zb-if" {
            Condition::If(test, test_span, span)
        } else {
            Condition::ElseIf(test, test_span, span)
        })),
        (_, AttributeValue::Text(_)) => Err(Diagnostic::new(
            attribute.span,
            format!("`{name}` is an expression: write {name}={{…}}"),
        )),
        (_, AttributeValue::None) => Err(Diagnostic::new(
            attribute.span,
            format!("`{name}` needs a condition: {name}={{…}}"),
        )),
    }
}

/// A directive's attribute that takes no value, like `animate`: whether it's there.
fn flag(element: &Element, name: &str, example: &str) -> Result<bool, Diagnostic> {
    match find(element, name) {
        None => Ok(false),
        Some(Attribute {
            value: AttributeValue::None,
            ..
        }) => Ok(true),
        Some(attribute) => Err(Diagnostic::new(
            attribute.span,
            format!("`{name}` takes no value: {example}"),
        )),
    }
}

/// `zb-animate` beside an element's `zb-if`: the chain it starts animates (`animate` on <zb-if>).
fn take_animate(element: &mut Element, condition: Option<&Condition>) -> Result<bool, Diagnostic> {
    let Some(at) = element
        .attributes
        .iter()
        .position(|attribute| attribute.name.eq_ignore_ascii_case("zb-animate"))
    else {
        return Ok(false);
    };
    let attribute = element.attributes.remove(at);
    if !matches!(attribute.value, AttributeValue::None) {
        return Err(Diagnostic::new(
            attribute.span,
            "`zb-animate` takes no value: <p zb-if={…} zb-animate>",
        ));
    }
    match condition {
        Some(Condition::If(..)) => Ok(true),
        Some(_) => Err(Diagnostic::new(
            attribute.span,
            "`zb-animate` goes on the element with `zb-if`; the whole chain animates",
        )),
        None => Err(Diagnostic::new(
            attribute.span,
            "`zb-animate` goes beside `zb-if`: <p zb-if={…} zb-animate>; for a list, write <zb-each … key={…} animate>",
        )),
    }
}

/// Attaches a `zb-else-if` or `zb-else` element to the chain its previous sibling started.
fn attach_branch(
    nodes: &mut Vec<Node>,
    chain: &mut Option<(usize, bool)>,
    condition: Condition,
    node: Node,
) -> Result<(), Diagnostic> {
    let (name, span) = match &condition {
        Condition::ElseIf(_, _, span) => ("zb-else-if", *span),
        Condition::Else(span) => ("zb-else", *span),
        Condition::If(..) => unreachable!("an zb-if starts a chain"),
    };
    let Some((at, closed)) = *chain else {
        return Err(Diagnostic::new(
            span,
            format!("`{name}` needs an element with `zb-if` or `zb-else-if` just before it (whitespace may come between); inside a <zb-if>, write <{name}> instead"),
        ));
    };
    if closed {
        return Err(Diagnostic::new(
            span,
            if name == "zb-else" {
                "a zb-if chain takes only one `zb-else`, and it comes last"
            } else {
                "`zb-else-if` must come before the chain's `zb-else`"
            },
        ));
    }
    // Whitespace between the branches isn't content.
    nodes.truncate(at + 1);
    // A chain animates as its `zb-if` says.
    let animate = matches!(nodes[at], Node::If { animate: true, .. });
    let alternate = last_alternate(&mut nodes[at]);
    match condition {
        Condition::ElseIf(test, test_span, span) => {
            *alternate = vec![Node::If {
                test,
                test_span,
                consequent: vec![node],
                alternate: Vec::new(),
                animate,
                span,
            }];
        }
        Condition::Else(_) => {
            *alternate = vec![node];
            *chain = Some((at, true));
        }
        Condition::If(..) => unreachable!(),
    }
    Ok(())
}

/// The `alternate` of the last `If` in a chain (each `zb-else-if` is an `If` in the previous
/// one's alternate).
fn last_alternate(node: &mut Node) -> &mut Vec<Node> {
    let Node::If { alternate, .. } = node else {
        unreachable!("a chain is built of If nodes")
    };
    if alternate.len() == 1 && matches!(alternate[0], Node::If { .. }) {
        return last_alternate(&mut alternate[0]);
    }
    alternate
}

/// The `zb-` attribute prefix belongs to the format: an unknown one is a mistake, not an
/// attribute to pass through (`data-zb-*` is fine: `data-` attributes are yours).
fn reserved_attributes(element: &Element) -> Result<(), Diagnostic> {
    if element.name.to_ascii_lowercase().starts_with("zb-") {
        return Ok(()); // directives check their own attributes
    }
    for attribute in &element.attributes {
        let lower = attribute.name.to_ascii_lowercase();
        if lower.starts_with("zb-") {
            let error = Diagnostic::new(
                attribute.span,
                format!(
                    "unknown attribute `{}`: the zb- prefix is reserved for the format",
                    attribute.name
                ),
            );
            return Err(crate::validate::with_suggestion(error, &lower, &CONDITIONS));
        }
    }
    Ok(())
}

/// `let:name={…}` attributes, taken off a zb-each or zb-then (4.3); anywhere else they're an
/// error.
fn take_lets(element: &mut Element, allowed: bool) -> Result<Vec<crate::ast::Let>, Diagnostic> {
    let mut lets = Vec::new();
    let mut kept = Vec::new();
    for attribute in std::mem::take(&mut element.attributes) {
        let Some(name) = attribute.name.strip_prefix("let:") else {
            kept.push(attribute);
            continue;
        };
        if !allowed {
            return Err(Diagnostic::new(
                attribute.span,
                format!("`let:` goes on <zb-each> or <zb-then>, where it names a value per row or result; not on <{}>", element.name),
            ));
        }
        if !is_identifier(name) {
            return Err(Diagnostic::new(
                attribute.span,
                format!("`let:{name}`: the name must be a valid identifier"),
            ));
        }
        let AttributeValue::Expression(value, span) = attribute.value else {
            return Err(Diagnostic::new(
                attribute.span,
                format!("`let:{name}` is an expression: write let:{name}={{…}}"),
            ));
        };
        if lets
            .iter()
            .any(|binding: &crate::ast::Let| binding.name == name)
        {
            return Err(Diagnostic::new(
                attribute.span,
                format!("`let:{name}` is given twice"),
            ));
        }
        lets.push(crate::ast::Let {
            name: name.to_owned(),
            value,
            span,
        });
    }
    element.attributes = kept;
    Ok(lets)
}

/// `<zb-case is={…}>` against `value`: `value === is`, or one `===` per item of an array `is`,
/// joined by `||`, so a switch over known values renders on the server.
fn case_test(value: &Expression, is: &Expression, span: Span) -> Result<Expression, Diagnostic> {
    use crate::expression::{BinaryOperator, LogicalOperator};
    if let Expression::Array(items) = is {
        let mut tests = items.iter().map(|item| case_test(value, item, span));
        let first = tests.next().ok_or_else(|| {
            Diagnostic::new(span, "`is={[]}` never matches; give it at least one value")
        })??;
        return tests.try_fold(first, |left, right| {
            Ok(Expression::Logical {
                operator: LogicalOperator::Or,
                left: Box::new(left),
                right: Box::new(right?),
            })
        });
    }
    if !value.is_runtime() && !is.is_runtime() {
        return Ok(Expression::Binary {
            operator: BinaryOperator::Equal,
            left: Box::new(value.clone()),
            right: Box::new(is.clone()),
        });
    }
    let plain = |expression: &Expression| expression.to_js_with(&|name| name.to_owned());
    let source = format!("({}) === ({})", plain(value), plain(is));
    expression_text(&source, span, span).map(|(expression, _)| expression)
}

fn lower_directive(mut element: Element) -> Result<Node, Diagnostic> {
    let lower = element.name.to_ascii_lowercase();
    let lets = take_lets(&mut element, lower == "zb-each" || lower == "zb-then")?;
    if let Some(rest) = lower.strip_prefix("mnix-") {
        if matches!(
            rest,
            "if" | "else" | "each" | "slot" | "await" | "then" | "catch"
        ) {
            return Err(Diagnostic::new(
                element.span,
                format!("<{}> was renamed to <zb-{rest}> in v0.3", element.name),
            ));
        }
    }
    match lower.as_str() {
        "zb-if" => {
            allow_attributes(&element, &["test", "animate"])?;
            let (test, test_span) = required_expression(&element, "test")?;
            let animate = flag(&element, "animate", "<zb-if test={…} animate>")?;
            // The branches in order: the zb-if's own, then each zb-else-if, then zb-else.
            let mut branches: Vec<Branch> =
                vec![(Some((test, test_span)), Vec::new(), element.span)];
            let mut closed = false;
            for child in element.children {
                match child {
                    Node::Else { test, children, span } => {
                        if closed {
                            return Err(Diagnostic::new(
                                span,
                                if test.is_some() {
                                    "zb-else-if must come before zb-else"
                                } else {
                                    "zb-if may contain only one zb-else"
                                },
                            ));
                        }
                        closed = test.is_none();
                        branches.push((test, children, span));
                    }
                    Node::Text(parts)
                        if branches.len() > 1
                            && parts.iter().all(|part| matches!(part, Part::Literal(text) if text.trim().is_empty())) => {}
                    child => {
                        if branches.len() > 1 {
                            return Err(Diagnostic::new(
                                element.span,
                                "zb-else-if and zb-else must be the final children of zb-if",
                            ));
                        }
                        branches[0].1.push(child);
                    }
                }
            }
            // Fold from the last branch: each else-if is an zb-if in the previous one's else.
            let mut alternate = Vec::new();
            if closed {
                alternate = branches
                    .pop()
                    .map(|(_, children, _)| children)
                    .unwrap_or_default();
            }
            while let Some((test, consequent, span)) = branches.pop() {
                let (test, test_span) = test.expect("only zb-else has no test");
                let node = Node::If {
                    test,
                    test_span,
                    consequent,
                    alternate,
                    animate,
                    span,
                };
                alternate = vec![node];
            }
            Ok(alternate.pop().expect("zb-if has a branch"))
        }
        "zb-each" => {
            allow_attributes(&element, &["items", "as", "index", "key", "animate"])?;
            let animate = flag(
                &element,
                "animate",
                "<zb-each items={…} as=\"item\" key={item.id} animate>",
            )?;
            let (items, items_span) = required_expression(&element, "items")?;
            let item = required_text(&element, "as")?;
            check_binding(&item, element.span, "zb-each as")?;
            let index = optional_text(&element, "index")?;
            if index.as_deref().is_some_and(|index| {
                !is_identifier(index)
                    || crate::ast::bindings(&item)
                        .is_ok_and(|names| names.iter().any(|(name, _)| name == index))
            }) {
                return Err(Diagnostic::new(
                    element.span,
                    "zb-each index must be a valid identifier different from `as` and the names it binds",
                ));
            }
            let key = find(&element, "key")
                .map(|_| required_expression(&element, "key"))
                .transpose()?;
            if animate && key.is_none() {
                return Err(Diagnostic::new(
                    element.span,
                    "`animate` follows rows by their key: give the zb-each a key, <zb-each items={…} as=\"item\" key={item.id} animate>",
                ));
            }
            Ok(Node::Each {
                items,
                items_span,
                item,
                index,
                key,
                lets,
                children: element.children,
                animate,
                span: element.span,
            })
        }
        "zb-slot" => {
            allow_attributes(&element, &["name"])?;
            let name = match optional_text(&element, "name")? {
                None => "default".to_owned(),
                Some(name) if name == "default" || is_identifier(&name) => name,
                Some(_) => {
                    return Err(Diagnostic::new(
                        element.span,
                        "zb-slot name must be `default` or a valid identifier",
                    ));
                }
            };
            Ok(Node::Slot {
                name,
                fallback: element.children,
                span: element.span,
            })
        }
        "zb-switch" => {
            allow_attributes(&element, &["value", "animate"])?;
            let animate = flag(&element, "animate", "<zb-switch value={…} animate>")?;
            let (value, _) = required_expression(&element, "value")?;
            // Each zb-case, in order, then an optional zb-else: an zb-if chain.
            let mut cases: Vec<(Expression, Span, Vec<Node>, Span)> = Vec::new();
            let mut otherwise: Option<Vec<Node>> = None;
            for child in element.children {
                match child {
                    Node::Text(parts) if is_blank(&parts) => {}
                    Node::Element(case) if case.name.eq_ignore_ascii_case("zb-case") => {
                        if otherwise.is_some() {
                            return Err(Diagnostic::new(
                                case.span,
                                "a zb-case can't come after the zb-switch's zb-else",
                            ));
                        }
                        allow_attributes(&case, &["is"])?;
                        // `is="paid"` is the string; `is={…}` any value, or an array of them.
                        let (is, is_span) = match find(&case, "is").map(|attribute| (&attribute.value, attribute.span)) {
                            Some((AttributeValue::Text(parts), span)) => match parts.as_slice() {
                                [Part::Literal(text)] => (Expression::String(html_escape::decode_html_entities(text).into_owned()), span),
                                _ => return Err(Diagnostic::new(span, "`is` is a string (is=\"paid\") or an expression (is={…}), not both")),
                            },
                            _ => required_expression(&case, "is")?,
                        };
                        let test = case_test(&value, &is, is_span)?;
                        cases.push((test, is_span, case.children, case.span));
                    }
                    Node::Else {
                        test: None,
                        children,
                        span,
                    } => {
                        if otherwise.is_some() {
                            return Err(Diagnostic::new(
                                span,
                                "a zb-switch takes only one zb-else",
                            ));
                        }
                        otherwise = Some(children);
                    }
                    Node::Else {
                        test: Some(_),
                        span,
                        ..
                    } => {
                        return Err(Diagnostic::new(
                            span,
                            "inside zb-switch, write <zb-case is={…}> instead of zb-else-if",
                        ));
                    }
                    other => {
                        let span = match &other {
                            Node::Element(e) => e.span,
                            _ => element.span,
                        };
                        return Err(Diagnostic::new(span, "a zb-switch contains <zb-case is={…}> elements and an optional final <zb-else>"));
                    }
                }
            }
            if cases.is_empty() {
                return Err(Diagnostic::new(
                    element.span,
                    "a zb-switch needs at least one <zb-case is={…}>",
                ));
            }
            let mut alternate = otherwise.unwrap_or_default();
            while let Some((test, test_span, consequent, span)) = cases.pop() {
                alternate = vec![Node::If {
                    test,
                    test_span,
                    consequent,
                    alternate,
                    animate,
                    span,
                }];
            }
            Ok(alternate.pop().expect("a case"))
        }
        "zb-await" => {
            allow_attributes(&element, &["value", "delay", "keep"])?;
            let (value, value_span) = required_expression(&element, "value")?;
            let delay = match find(&element, "delay") {
                Some(_) => Some(required_expression(&element, "delay")?),
                None => None,
            };
            let keep = match find(&element, "keep") {
                Some(attribute) if attribute.value == AttributeValue::None => true,
                Some(attribute) => {
                    return Err(Diagnostic::new(
                        attribute.span,
                        "`keep` takes no value: <zb-await value={…} keep>",
                    ))
                }
                None => false,
            };
            let mut pending = Vec::new();
            let mut named_pending = false;
            let mut then = None;
            let mut catch = None;
            for child in element.children {
                match child {
                    // `<zb-pending>`: the pending content, named (4.2).
                    Node::Element(pending_element) if pending_element.name.eq_ignore_ascii_case("zb-pending") => {
                        allow_attributes(&pending_element, &[])?;
                        if named_pending || then.is_some() || catch.is_some() || pending.iter().any(|node| !matches!(node, Node::Text(parts) if is_blank(parts))) {
                            return Err(Diagnostic::new(
                                pending_element.span,
                                "zb-await takes one <zb-pending>, first, instead of pending content written straight inside it",
                            ));
                        }
                        named_pending = true;
                        pending = pending_element.children;
                    }
                    Node::Settled { caught, branch } => {
                        let slot = if caught { &mut catch } else { &mut then };
                        if slot.is_some() {
                            return Err(Diagnostic::new(
                                branch.span,
                                format!("zb-await may contain only one zb-{}", if caught { "catch" } else { "then" }),
                            ));
                        }
                        *slot = Some(branch);
                    }
                    Node::Text(parts)
                        if (then.is_some() || catch.is_some())
                            && parts.iter().all(|part| matches!(part, Part::Literal(text) if text.trim().is_empty())) => {}
                    Node::Text(parts) if named_pending && is_blank(&parts) => {}
                    child => {
                        if then.is_some() || catch.is_some() {
                            return Err(Diagnostic::new(
                                element.span,
                                "zb-await's pending content comes first, then zb-then and zb-catch",
                            ));
                        }
                        if named_pending {
                            return Err(Diagnostic::new(
                                element.span,
                                "with a <zb-pending>, the pending content goes inside it",
                            ));
                        }
                        pending.push(child);
                    }
                }
            }
            Ok(Node::Await {
                value,
                value_span,
                pending,
                then,
                catch,
                delay,
                keep,
                span: element.span,
            })
        }
        "zb-then" | "zb-catch" => {
            allow_attributes(&element, &["as"])?;
            let name = optional_text(&element, "as")?;
            if let Some(name) = &name {
                check_binding(name, element.span, &format!("{lower} as"))?;
            }
            Ok(Node::Settled {
                caught: lower == "zb-catch",
                branch: crate::ast::Branch {
                    name,
                    lets,
                    children: element.children,
                    span: element.span,
                },
            })
        }
        "zb-else" => {
            if !element.attributes.is_empty() {
                return Err(Diagnostic::new(
                    element.span,
                    "zb-else does not accept attributes",
                ));
            }
            Ok(Node::Else {
                test: None,
                children: element.children,
                span: element.span,
            })
        }
        "zb-window" | "zb-document" => {
            for attribute in &element.attributes {
                if !is_event_attribute(&attribute.name.to_ascii_lowercase()) {
                    return Err(Diagnostic::new(
                        attribute.span,
                        format!(
                            "<{}> takes event listeners only (on<event>={{…}})",
                            element.name
                        ),
                    ));
                }
            }
            if element.children.iter().any(|child| !matches!(child, Node::Text(parts) if parts.iter().all(|part| matches!(part, Part::Literal(text) if text.trim().is_empty())))) {
                return Err(Diagnostic::new(element.span, format!("<{}> can't have content", element.name)));
            }
            Ok(Node::Element(Element {
                children: Vec::new(),
                ..element
            }))
        }
        "zb-else-if" => {
            allow_attributes(&element, &["test"])?;
            let test = required_expression(&element, "test")?;
            Ok(Node::Else {
                test: Some(test),
                children: element.children,
                span: element.span,
            })
        }
        _ => Ok(Node::Element(element)),
    }
}

fn allow_attributes(element: &Element, allowed: &[&str]) -> Result<(), Diagnostic> {
    for attribute in &element.attributes {
        if attribute.name == SPREAD {
            return Err(Diagnostic::new(
                attribute.span,
                format!(
                    "<{}> is a directive, so it can't take a {{...}} spread",
                    element.name
                ),
            ));
        }
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

/// `maxValue` → `max-value`.
fn kebab_attribute(name: &str) -> String {
    let mut out = String::new();
    for character in name.chars() {
        if character.is_ascii_uppercase() {
            out.push('-');
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

/// The name a `{...expression}` spread takes in the AST (it can't clash: names never start with `.`).
pub const SPREAD: &str = "...";

/// `inner` (the text inside `{…}`) as an expression: the build-time subset where it fits, any
/// JavaScript expression otherwise.
fn expression_text(
    inner: &str,
    open_span: Span,
    inner_span: Span,
) -> Result<(Expression, Span), Diagnostic> {
    let subset = expression::parse(inner);
    let trimmed = inner.trim();
    let v02 = trimmed
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .is_some_and(|name| is_identifier(name.trim()));
    // Beyond the build-time subset, any JavaScript expression is accepted; it runs in the
    // browser only (see `runtime_expression`).
    if subset.is_err() && !v02 {
        if let Ok(names) = crate::runtime_expression::parse(inner) {
            let expression = Expression::Runtime {
                source: inner.to_owned(),
                names,
            };
            return Ok((expression, open_span));
        }
    }
    let expression = subset.map_err(|error| {
        // `{{ name }}` parses as an (invalid) object literal; it's almost certainly v0.2.
        if let Some(name) = trimmed
            .strip_prefix('{')
            .and_then(|rest| rest.strip_suffix('}'))
        {
            let name = name.trim();
            if is_identifier(name) {
                return Diagnostic::new(
                    open_span,
                    "`{{ … }}` is v0.2 syntax; v0.3 uses single braces",
                )
                .with_help(format!("write {{{name}}} instead of {{{{ {name} }}}}"));
            }
        }
        Diagnostic::new(span_after(inner_span, inner, error.offset), error.message)
    })?;
    Ok((expression, open_span))
}

/// `'use server'` functions become their endpoint's URL: a `const` in the browser module (so the
/// script can still `fetch(save)`), and, on a form whose `action` is one, a literal `action`
/// with `method="post"` (so the form submits to it with or without JavaScript).
fn resolve_server_exports(script: &mut crate::ast::Script, tag: &str, nodes: &mut [Node]) {
    if script.server_exports.is_empty() {
        return;
    }
    let urls: Vec<(String, String)> = script
        .server_exports
        .iter()
        .map(|export| {
            (
                export.name.clone(),
                crate::ast::action_url(tag, &export.name),
            )
        })
        .collect();
    let mut exports = script.server_exports.clone();
    exports.sort_by_key(|export| std::cmp::Reverse(export.offset));
    for export in &exports {
        let url = crate::ast::action_url(tag, &export.name);
        let declaration = format!("const {} = {};", export.name, serde_json::json!(url));
        script.body.insert_str(export.offset, &declaration);
        script.bindings.push(crate::ast::Binding {
            name: export.name.clone(),
            init: Some(Expression::String(url.clone())),
            source: Some(serde_json::json!(url).to_string()),
            mutable: false,
            span: export.span,
        });
    }
    point_forms_at(nodes, &urls);
}

fn point_forms_at(nodes: &mut [Node], urls: &[(String, String)]) {
    for node in nodes {
        match node {
            Node::Element(element) => {
                let name = element.name.to_ascii_lowercase();
                // `<form action={save}>`, and `formaction={save}` on a submit button.
                let (target, method) = match name.as_str() {
                    "form" => ("action", "method"),
                    "button" | "input" => ("formaction", "formmethod"),
                    _ => ("", ""),
                };
                let mut pointed = false;
                if !target.is_empty() {
                    for attribute in element.attributes.iter_mut() {
                        if attribute.name != target {
                            continue;
                        }
                        if let AttributeValue::Expression(Expression::Identifier(identifier), _) =
                            &attribute.value
                        {
                            if let Some((_, url)) = urls.iter().find(|(name, _)| name == identifier)
                            {
                                attribute.value =
                                    AttributeValue::Text(vec![Part::Literal(url.clone())]);
                                pointed = true;
                            }
                        }
                    }
                }
                if pointed
                    && !element
                        .attributes
                        .iter()
                        .any(|attribute| attribute.name == method)
                {
                    let span = element.span;
                    element.attributes.push(crate::ast::Attribute {
                        name: method.to_owned(),
                        value: AttributeValue::Text(vec![Part::Literal("post".to_owned())]),
                        span,
                    });
                }
                point_forms_at(&mut element.children, urls);
            }
            Node::If {
                consequent,
                alternate,
                ..
            } => {
                point_forms_at(consequent, urls);
                point_forms_at(alternate, urls);
            }
            Node::Each { children, .. } | Node::Else { children, .. } => {
                point_forms_at(children, urls)
            }
            Node::Slot { fallback, .. } => point_forms_at(fallback, urls),
            Node::Await {
                pending,
                then,
                catch,
                ..
            } => {
                point_forms_at(pending, urls);
                for branch in [then, catch].into_iter().flatten() {
                    point_forms_at(&mut branch.children, urls);
                }
            }
            Node::Settled { branch, .. } => point_forms_at(&mut branch.children, urls),
            Node::Text(_) => {}
        }
    }
}
