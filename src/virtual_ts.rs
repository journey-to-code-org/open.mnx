//! A component as a TypeScript file `tsc` can check (`zubra check --types`, `--emit tsx`).
//!
//! The compiler never runs a type checker. For checking, it writes what Vue's and Svelte's
//! tooling write: a TypeScript file per component, with a map from every position that came
//! from the component back to it, so the project's own `tsc` checks the script, every template
//! expression, every child prop and every event handler, and its errors land on `.zb` lines.
//!
//! ```text
//! declare const size: number;              the props, as the script sees them
//! <the script, as written>                 mapped one to one
//! export declare class MyBox …             the typings, so importers see the component
//! function __zubraTemplate() {             the template, in its scopes:
//!   (label);                                 {label}
//!   for (const item of (items)) { … }        <zb-each items={items} as="item">
//!   if ((open)) { … } else { … }             <zb-if test={open}>
//!   { const __v: __P0["count"] = (n); }      <my-badge count={n}>: the child's prop type
//!   { const __h: (event: HTMLElementEventMap["click"]) => unknown = (pick); }   onclick={pick}
//! }
//! ```
//!
//! A script name the template reads is unwrapped as the template unwraps it: a signal reads as
//! its value (`{count}` with `const count = state(0)` is a number).

use crate::{
    ast::{AttributeValue, ComponentAst, Node, Part, PropDefault},
    diagnostic::{Diagnostic, Span},
    emit_interface::{self, Framework},
    scanner::Cursor,
    validate,
};

/// A stretch of the generated file that came from the component: `(generated, source,
/// length)`, byte offsets.
pub type Mapping = (u32, u32, u32);

struct Writer<'s> {
    source: &'s str,
    code: String,
    mappings: Vec<Mapping>,
    /// Child components, by tag: the index their types are imported as (`__P0`), and their props.
    children: Vec<(String, usize, Vec<String>)>,
    temp: usize,
}

impl Writer<'_> {
    fn push(&mut self, text: &str) {
        self.code.push_str(text);
    }

    /// Copy `length` bytes of the component at `offset`, mapped.
    fn copy(&mut self, offset: usize, length: usize) {
        let generated = self.code.len();
        self.code.push_str(&self.source[offset..offset + length]);
        self.mappings
            .push((to_u32(generated), to_u32(offset), to_u32(length)));
    }

    /// The `{…}` expression whose `{` is at `span`: its text's offset and length.
    fn braced(&self, span: Span) -> Option<(usize, usize)> {
        let mut offset = offset_of(self.source, span)?;
        // A directive written as an attribute (`<p zb-if={…}>`) is placed at its name: the
        // expression is the next `{` in the tag.
        if !self.source[offset..].starts_with('{') {
            let rest = &self.source[offset..];
            let brace = rest.find('{')?;
            if rest[..brace].contains('>') {
                return None;
            }
            offset += brace;
        }
        let span = Span::new(0, 0);
        let mut cursor = Cursor::at(&self.source[offset..], span);
        let braced = cursor.scan_braced().ok()?;
        let inner = braced.inner;
        let start = offset + 1;
        // `{...spread}`: the object after the dots.
        let lead = inner.len() - inner.trim_start().len();
        let (start, inner) = match inner.trim_start().strip_prefix("...") {
            Some(rest) => (start + lead + 3, rest),
            None => (start, inner),
        };
        Some((start, inner.len()))
    }

    /// `(expression);`, or with `before`/`after` around it.
    fn expression(&mut self, span: Span, before: &str, after: &str) {
        if let Some((offset, length)) = self.braced(span) {
            self.push(before);
            self.push("(");
            self.copy(offset, length);
            self.push(")");
            self.push(after);
            self.push("\n");
        }
    }

    fn fresh(&mut self) -> String {
        self.temp += 1;
        format!("__zubra{}", self.temp)
    }

    fn nodes(&mut self, component: &ComponentAst, nodes: &[Node]) {
        for node in nodes {
            self.node(component, node);
        }
    }

    fn node(&mut self, component: &ComponentAst, node: &Node) {
        match node {
            Node::Text(parts) => self.parts(parts),
            Node::Element(element) => {
                let child = self
                    .children
                    .iter()
                    .find(|(tag, _, _)| tag.eq_ignore_ascii_case(&element.name))
                    .map(|(_, index, props)| (*index, props.clone()));
                let mut previous: Option<Span> = None;
                for attribute in &element.attributes {
                    let base = attribute.name.split('.').next().unwrap_or(&attribute.name);
                    // `open:bind={on}` is the prop and a handler the parser writes, `onopenchange`
                    // assigning `event.detail` back, both at the binding: the handler is checked
                    // as that assignment, not as the user's expression.
                    let written = previous.replace(attribute.span) == Some(attribute.span)
                        && matches!(
                            attribute.value,
                            AttributeValue::Expression(
                                crate::expression::Expression::Runtime { .. },
                                _
                            )
                        );
                    if written {
                        if let (Some((index, _)), AttributeValue::Expression(_, span)) =
                            (child.as_ref(), &attribute.value)
                        {
                            if let Some((offset, length)) = self.braced(*span) {
                                let event = base[2..].to_ascii_lowercase();
                                self.push(&format!(
                                    "__zubraCheck<(event: __M{index}[{}]) => unknown>((event) => (",
                                    json(&event)
                                ));
                                // (A name: the parser takes nothing else.)
                                self.copy(offset, length);
                                self.push(" = event.detail));\n");
                            }
                        }
                        continue;
                    }
                    match &attribute.value {
                        AttributeValue::Expression(_, span) => {
                            let event = crate::parser::is_event_attribute(&attribute.name)
                                .then(|| base[2..].to_ascii_lowercase());
                            match (event, child.as_ref()) {
                                (Some(event), Some((index, _))) => self.expression(
                                    *span,
                                    &format!(
                                        "__zubraCheck<(event: __M{index}[{}]) => unknown>(",
                                        json(&event)
                                    ),
                                    ");",
                                ),
                                (Some(event), None) => {
                                    // `<zb-window>` and `<zb-document>` listen on those.
                                    let map = match element.name.to_ascii_lowercase().as_str() {
                                        "zb-window" => "__WindowEvent",
                                        "zb-document" => "__DocumentEvent",
                                        _ => "__Event",
                                    };
                                    self.expression(
                                        *span,
                                        &format!(
                                            "__zubraCheck<(event: {map}<{}>) => unknown>(",
                                            json(&event)
                                        ),
                                        ");",
                                    );
                                }
                                (None, Some((index, props)))
                                    if props.contains(&camel(
                                        attribute
                                            .name
                                            .strip_suffix(":bind")
                                            .unwrap_or(&attribute.name),
                                    )) =>
                                {
                                    let prop = camel(
                                        attribute
                                            .name
                                            .strip_suffix(":bind")
                                            .unwrap_or(&attribute.name),
                                    );
                                    self.expression(
                                        *span,
                                        &format!("__zubraCheck<__P{index}[{}]>(", json(&prop)),
                                        ");",
                                    );
                                }
                                _ => self.expression(*span, "", ";"),
                            }
                        }
                        AttributeValue::Text(parts) => self.parts(parts),
                        AttributeValue::None => {}
                    }
                }
                self.nodes(component, &element.children);
            }
            Node::If {
                test,
                test_span,
                consequent,
                alternate,
                switch_value,
                ..
            } => {
                // A `<zb-case>`: its switch's value against its `is` (a string, an expression,
                // or an array of either).
                if let Some(value) = switch_value.and_then(|span| self.braced(span)) {
                    let is = self.braced(*test_span);
                    let literal = match test {
                        crate::expression::Expression::Binary { right, .. } => match &**right {
                            crate::expression::Expression::String(text) => Some(json(text)),
                            _ => None,
                        },
                        _ => None,
                    };
                    let array = is.is_some_and(|(offset, length)| {
                        self.source[offset..offset + length]
                            .trim_start()
                            .starts_with('[')
                    });
                    self.push("if ((");
                    self.copy(value.0, value.1);
                    match (is, literal) {
                        (Some((offset, length)), _) if array => {
                            self.push(") && (");
                            self.copy(offset, length);
                            self.push(")) {\n");
                        }
                        (Some((offset, length)), _) => {
                            self.push(") === (");
                            self.copy(offset, length);
                            self.push(")) {\n");
                        }
                        (None, Some(literal)) => self.push(&format!(") === {literal}) {{\n")),
                        (None, None) => self.push(")) {\n"),
                    }
                } else if let Some((offset, length)) = self.braced(*test_span) {
                    self.push("if ((");
                    self.copy(offset, length);
                    self.push(")) {\n");
                } else {
                    self.push("if (Math.random()) {\n");
                }
                self.nodes(component, consequent);
                self.push("} else {\n");
                self.nodes(component, alternate);
                self.push("}\n");
            }
            Node::Else { test, children, .. } => {
                if let Some((_, span)) = test {
                    self.expression(*span, "", ";");
                }
                self.push("{\n");
                self.nodes(component, children);
                self.push("}\n");
            }
            Node::Each {
                items_span,
                item,
                index,
                key,
                lets,
                children,
                ..
            } => {
                let Some((offset, length)) = self.braced(*items_span) else {
                    return;
                };
                self.push(&format!("for (const {item} of __zubraItems(("));
                self.copy(offset, length);
                self.push("))) {\n");
                if let Some(index) = index {
                    self.push(&format!("const {index}: number = 0;\n"));
                }
                if let Some((_, span)) = key {
                    self.expression(*span, "", ";");
                }
                for binding in lets {
                    if let Some((offset, length)) = self.braced(binding.span) {
                        self.push(&format!("const {} = (", binding.name));
                        self.copy(offset, length);
                        self.push(");\n");
                    }
                }
                self.nodes(component, children);
                self.push("}\n");
            }
            Node::Slot { fallback, .. } => self.nodes(component, fallback),
            Node::Await {
                value_span,
                pending,
                then,
                catch,
                delay,
                ..
            } => {
                let Some((offset, length)) = self.braced(*value_span) else {
                    return;
                };
                let value = self.fresh();
                self.push(&format!("{{ const {value} = ("));
                self.copy(offset, length);
                self.push(");\n");
                if let Some((_, span)) = delay {
                    self.expression(*span, "", ";");
                }
                self.nodes(component, pending);
                if let Some(branch) = then {
                    self.push("{\n");
                    if let Some(name) = &branch.name {
                        self.push(&format!(
                            "const {name} = null as unknown as __Settled<typeof {value}>;\n"
                        ));
                    }
                    for binding in &branch.lets {
                        if let Some((offset, length)) = self.braced(binding.span) {
                            self.push(&format!("const {} = (", binding.name));
                            self.copy(offset, length);
                            self.push(");\n");
                        }
                    }
                    self.nodes(component, &branch.children);
                    self.push("}\n");
                }
                if let Some(branch) = catch {
                    self.push("{\nconst retry = (): void => {};\n");
                    if let Some(name) = &branch.name {
                        self.push(&format!("const {name}: unknown = null;\n"));
                    }
                    self.nodes(component, &branch.children);
                    self.push("}\n");
                }
                self.push("}\n");
            }
            Node::Settled { branch, .. } => self.nodes(component, &branch.children),
        }
    }

    fn parts(&mut self, parts: &[Part]) {
        for part in parts {
            if let Part::Expression { span, .. } = part {
                self.expression(*span, "", ";");
            }
        }
    }
}

/// The component (its `.zb` source at `source_name`, parsed and loaded) as a TypeScript file
/// for checking, with its map.
pub fn generate(
    component: &ComponentAst,
    source: &str,
    source_name: &str,
) -> Result<(String, Vec<Mapping>), Diagnostic> {
    let interface = validate::analyze(component)?;
    let mut writer = Writer {
        source,
        // A JavaScript component isn't checked (its script has no types); its file is there for
        // the components that use it, which get its props' and events' types.
        code: format!(
            "{}// Generated by zubra from {source_name} for type checking. Do not edit.\n",
            if component.script.typescript {
                ""
            } else {
                "// @ts-nocheck\n"
            }
        ),
        mappings: Vec::new(),
        children: Vec::new(),
        temp: 0,
    };

    // The child components' types.
    for (index, (import, child)) in component
        .script
        .components
        .iter()
        .zip(&component.children)
        .enumerate()
    {
        let class = emit_interface::class_name(&child.ast.tag);
        // A `.zb.tsx` child is read from its typings (`<file>.types.ts` beside the generated
        // files), not as the JSX it's written in.
        let specifier = if crate::jsx::is_jsx(&import.specifier) {
            format!("{}.types", import.specifier)
        } else {
            import.specifier.clone()
        };
        writer.push(&format!(
            "import type {{ {class}Props as __P{index}, {class}EventMap as __M{index} }} from {};\n",
            json(&specifier)
        ));
        let props = child
            .ast
            .props
            .iter()
            .map(|prop| prop.name.clone())
            .collect();
        writer.children.push((child.ast.tag.clone(), index, props));
    }

    // The props, as the script sees them (unless the script declares one itself).
    // (A prop typed by `interface Props` is declared here, with that type.)
    let interface_span = component
        .script
        .props_interface
        .as_ref()
        .map(|(_, span)| *span);
    for prop in &interface.props {
        if component
            .script
            .prop_types
            .iter()
            .any(|(name, _, span)| name == &prop.name && Some(*span) != interface_span)
        {
            continue;
        }
        // (A prop named like a keyword, `default`, can't be a variable: the script can't read
        // it by name either.)
        if !is_binding_name(&prop.name) {
            continue;
        }
        // `let`: a two-way prop is assigned by the component's handlers.
        writer.push(&format!(
            "declare let {}: {};\n",
            prop.name,
            emit_interface::prop_type(prop)
        ));
    }

    // The script, as written.
    if let Some((offset, length)) = script_range(source, component) {
        writer.copy(offset, length);
        writer.push("\n;\n");
    }

    // The typings, without the script's own types (they're above, as written).
    let mut typings = emit_interface::declarations(component, source_name, Framework::None)?;
    typings = typings
        .split_once('\n')
        .map_or(typings.clone(), |(_, rest)| rest.to_owned());
    for import in &component.script.type_imports {
        typings = typings.replacen(&format!("{import}\n"), "", 1);
    }
    for declaration in &component.script.type_declarations {
        typings = typings.replacen(&format!("{declaration}\n\n"), "", 1);
    }
    // A component that fires nothing has no event map in its typings; its users still name one.
    let class = emit_interface::class_name(&component.tag);
    if !typings.contains(&format!("interface {class}EventMap")) {
        typings.push_str(&format!(
            "\nexport interface {class}EventMap extends HTMLElementEventMap {{}}\n"
        ));
    }
    writer.push(&typings);

    // The template, in its scopes.
    writer.push("\ntype __Event<K extends string> = K extends keyof HTMLElementEventMap ? HTMLElementEventMap[K] : CustomEvent;\n");
    writer.push("type __WindowEvent<K extends string> = K extends keyof WindowEventMap ? WindowEventMap[K] : Event;\n");
    writer.push("type __DocumentEvent<K extends string> = K extends keyof DocumentEventMap ? DocumentEventMap[K] : Event;\n");
    // A signal (`Signal.State` or `Signal.Computed`, whose only members are `get` and `set`) reads
    // as its value, as the runtime's `$r` reads it; any other object with a `get` stays itself.
    writer.push("type __Value<T> = T extends { get(): infer V } ? ([Exclude<keyof T, \"get\" | \"set\">] extends [never] ? V : T) : T;\n");
    writer.push("type __Settled<T> = T extends readonly unknown[] ? { -readonly [K in keyof T]: Awaited<__Value<T[K]>> } : Awaited<__Value<T>>;\n");
    writer.push("declare function __zubraItems<T>(items: T): Iterable<__Value<T> extends Iterable<infer I> ? I : never>;\n");
    writer.push("declare function __zubraValue<T>(value: T): __Value<T>;\n");
    // A value checked against a type (an error lands on the value, a handler's parameter is typed).
    writer.push("declare function __zubraCheck<T>(value: T): void;\n");
    // Script names, as the template reads them (a signal is its value).
    // (A `let` is a plain value, and the template may assign it: it's left as it is.)
    let names: Vec<String> = component
        .script
        .bindings
        .iter()
        .filter(|binding| !binding.mutable)
        .map(|binding| binding.name.clone())
        .chain(component.script.runtime_names.iter().cloned())
        .filter(|name| !name.starts_with("__"))
        // A `const enum` is no value to alias (TS2475): the template reads it as written.
        .filter(|name| {
            !component
                .script
                .enums
                .iter()
                .any(|info| info.constant && &info.name == name)
        })
        .collect();
    for name in &names {
        writer.push(&format!("const __zubraScript_{name} = {name};\n"));
    }
    writer.push("function __zubraTemplate() {\n");
    for name in &names {
        writer.push(&format!(
            "const {name} = __zubraValue(__zubraScript_{name});\n"
        ));
    }
    // The host's defaults, against the props' types: an expression as written, a text default
    // (`size="big"`) as the string it is.
    for declaration in &component.props {
        if !is_binding_name(&declaration.name) {
            continue;
        }
        match &declaration.default {
            PropDefault::Expression(_, span) => writer.expression(
                *span,
                &format!("__zubraCheck<typeof {}>(", declaration.name),
                ");",
            ),
            PropDefault::Text(text) if is_text_typed(component, &declaration.name) => {
                writer.push(&format!("__zubraCheck<typeof {}>(", declaration.name));
                // The quoted value as written, when it reads as the same JavaScript string (so
                // an error lands on it); otherwise the string itself.
                match quoted_value(source, declaration.span) {
                    Some((offset, length))
                        if source[offset + 1..offset + length - 1] == **text
                            && !text.contains(['\\', '\n', '\r']) =>
                    {
                        writer.copy(offset, length);
                    }
                    _ => writer.push(&json(text)),
                }
                writer.push(");\n");
            }
            _ => {}
        }
    }
    writer.nodes(component, &component.nodes);
    writer.push("}\n");
    Ok((writer.code, writer.mappings))
}

/// The script's text: from its `<script …>` to `</script>`.
fn script_range(source: &str, component: &ComponentAst) -> Option<(usize, usize)> {
    let start = offset_of(source, component.script.start?)?;
    let end = source[start..].to_ascii_lowercase().find("</script")?;
    Some((start, end))
}

/// A line and column (characters, from 1) as a byte offset.
pub fn offset_of(source: &str, span: Span) -> Option<usize> {
    let mut offset = 0;
    for (line, text) in (1..).zip(source.split_inclusive('\n')) {
        if line == span.line {
            let column = text
                .char_indices()
                .nth(span.column.saturating_sub(1))
                .map_or(text.len(), |(at, _)| at);
            return Some(offset + column);
        }
        offset += text.len();
    }
    None
}

/// An attribute's quoted value (`"big"`, quotes included), from the attribute at `span`.
fn quoted_value(source: &str, span: Span) -> Option<(usize, usize)> {
    let start = offset_of(source, span)?;
    let rest = &source[start..];
    let equals = rest.find('=')?;
    if rest[..equals].contains(['>', '{', '"', '\'']) {
        return None;
    }
    let after = &rest[equals + 1..];
    let lead = after.len() - after.trim_start().len();
    let quote = after
        .trim_start()
        .chars()
        .next()
        .filter(|c| *c == '"' || *c == '\'')?;
    let open = start + equals + 1 + lead;
    let close = source[open + 1..].find(quote)?;
    Some((open, close + 2))
}

/// Whether `name` can be declared as a variable.
fn is_binding_name(name: &str) -> bool {
    const RESERVED: &[&str] = &[
        "await",
        "break",
        "case",
        "catch",
        "class",
        "const",
        "continue",
        "debugger",
        "default",
        "delete",
        "do",
        "else",
        "enum",
        "export",
        "extends",
        "false",
        "finally",
        "for",
        "function",
        "if",
        "implements",
        "import",
        "in",
        "instanceof",
        "interface",
        "let",
        "new",
        "null",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "static",
        "super",
        "switch",
        "this",
        "throw",
        "true",
        "try",
        "typeof",
        "var",
        "void",
        "while",
        "with",
        "yield",
    ];
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '_' || first == '$')
        && chars
            .all(|character| character.is_alphanumeric() || character == '_' || character == '$')
        && !RESERVED.contains(&name)
}

/// Whether a prop's type is declared in the script (so a text default is checked against it,
/// rather than against the `string` it was inferred as).
fn is_text_typed(component: &ComponentAst, name: &str) -> bool {
    component
        .script
        .prop_types
        .iter()
        .any(|(prop, _, _)| prop == name)
}

fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for character in name.chars() {
        if character == '-' {
            upper = true;
        } else if upper {
            out.extend(character.to_uppercase());
            upper = false;
        } else {
            out.push(character);
        }
    }
    out
}

fn json(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
