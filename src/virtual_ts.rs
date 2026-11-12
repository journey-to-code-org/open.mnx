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
                for attribute in &element.attributes {
                    let base = attribute.name.split('.').next().unwrap_or(&attribute.name);
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
                                (Some(event), None) => self.expression(
                                    *span,
                                    &format!(
                                        "__zubraCheck<(event: __Event<{}>) => unknown>(",
                                        json(&event)
                                    ),
                                    ");",
                                ),
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
                test_span,
                consequent,
                alternate,
                ..
            } => {
                if let Some((offset, length)) = self.braced(*test_span) {
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
        writer.push(&format!(
            "import type {{ {class}Props as __P{index}, {class}EventMap as __M{index} }} from {};\n",
            json(&import.specifier)
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
    for prop in &interface.props {
        if component
            .script
            .prop_types
            .iter()
            .any(|(name, _, _)| name == &prop.name)
        {
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
    writer.push("type __Value<T> = T extends { get(): infer V } ? V : T;\n");
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
    // The host's defaults, against the props' types.
    for declaration in &component.props {
        if let PropDefault::Expression(_, span) = &declaration.default {
            writer.expression(
                *span,
                &format!("__zubraCheck<typeof {}>(", declaration.name),
                ");",
            );
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
