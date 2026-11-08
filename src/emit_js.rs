//! The JavaScript backend: a module that defines the custom element.
//!
//! The output is a template plus a list of *parts* — the places in that template that change —
//! each with the expression that computes it:
//!
//! ```js
//! export default $define("zb-header", {
//!   props: { title: { attribute: "title", default: "Mikey Nichols" } },
//!   template: "\n  <header>…<h1></h1>…</header>\n",
//!   setup($p) {
//!     /* the component's <script>, verbatim */
//!     return [{ path: [0, 0, 0], text: () => $t($p.title) }];
//!   },
//! });
//! ```
//!
//! A fresh element clones the template; an element whose markup came from the server is walked
//! by the same paths, so hydration binds to the existing DOM instead of re-rendering it. Paths
//! count only elements and comments: the browser merges and drops text nodes, so text can't be
//! addressed by position. Dynamic text that is an element's only child is bound through that
//! element; dynamic text beside other nodes follows an empty-comment anchor (emitted by both
//! backends — see `validate::needs_text_anchor`).

use crate::{
    ast::{self, AttributeValue, ComponentAst, Node, Part},
    diagnostic::Diagnostic,
    expression::Expression,
    parser::is_event_attribute,
    validate::{self, needs_text_anchor, Interface, BOOLEAN_ATTRIBUTES, URL_ATTRIBUTES},
};

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

pub struct Options<'a> {
    /// Module specifier the output imports the runtime from.
    pub runtime: &'a str,
    /// Shown in the generated header comment.
    pub source_name: &'a str,
    /// Rewrite `.zb` imports to this extension (`".js"` for CLI output); `None` keeps them,
    /// for bundler plugins that load `.zb` files themselves.
    pub component_extension: Option<&'a str>,
    /// How the `<style>` reaches the page: `None` inlines it in the module; `Some` imports it
    /// through the bundler's CSS pipeline (so Tailwind, PostCSS and preprocessors run on it).
    pub style_imports: Option<StyleImports<'a>>,
}

/// Module specifiers for a component's stylesheet, as the bundler serves it.
#[derive(Clone, Copy, Debug)]
pub struct StyleImports<'a> {
    /// Imported for its side effect: the bundler adds the CSS to the page (light DOM).
    pub stylesheet: &'a str,
    /// Imported as a string, for a shadow root (Vite's `?inline`).
    pub inline: &'a str,
}

/// `<zb-window>` and `<zb-document>`: listeners on the window or document while rendered.
pub(crate) fn is_global_listener(name: &str) -> bool {
    name.eq_ignore_ascii_case("zb-window") || name.eq_ignore_ascii_case("zb-document")
}

pub fn emit(component: &ComponentAst, options: &Options<'_>) -> Result<String, Diagnostic> {
    let interface = validate::analyze(component)?;
    for name in &interface.script_names {
        if name.starts_with('$') {
            return Err(Diagnostic::new(
                component.tag_span,
                format!("`{name}`: names starting with $ are reserved for compiled code"),
            ));
        }
    }
    let children = child_infos(component)?;
    // 2.0's script semantics: props by name, `let` as state, derived `const`s.
    let prop_names: Vec<String> = interface
        .props
        .iter()
        .map(|prop| prop.name.clone())
        .collect();
    // The local names `state`, `computed` and `inject` have, imported from the runtime.
    let makers: Vec<String> = component
        .script
        .imports
        .iter()
        .filter(|import| import.specifier == "@zubra/runtime")
        .flat_map(|import| {
            let names = import
                .text
                .split_once('{')
                .and_then(|(_, rest)| rest.split_once('}'))
                .map_or("", |(names, _)| names);
            names
                .split(',')
                .filter_map(|name| {
                    let mut words = name.split_whitespace();
                    let imported = words.next()?;
                    let local = match (words.next(), words.next()) {
                        (Some("as"), Some(local)) => local,
                        _ => imported,
                    };
                    // `__zubra…` names come from JSX lowering, which writes its own `.get()`s.
                    (matches!(
                        imported,
                        "state" | "computed" | "inject" | "hasSlot" | "hydrated"
                    ) && !local.starts_with("__zubra"))
                    .then(|| local.to_owned())
                })
                .collect::<Vec<_>>()
        })
        .collect();
    // Every name the script's imports bind (the body has them taken out).
    let imported: Vec<String> = component
        .script
        .imports
        .iter()
        .flat_map(|import| crate::reactive::imported_names(&import.text))
        .collect();
    let script = crate::reactive::rewrite_script(
        &component.script.body,
        &prop_names,
        &makers,
        &imported,
        &component.script.from,
        component
            .script
            .start
            .unwrap_or(crate::diagnostic::Span::new(1, 1)),
    )?;
    let mut emitter = Emitter {
        state: &script.state,
        derived: &script.derived,
        signals: &script.signals,
        interface: &interface,
        children: &children,
        shadow: component.shadow,
        scopes: Vec::new(),
        base: Vec::new(),
        template: String::new(),
        parts: Vec::new(),
        slot_paths: Vec::new(),
    };
    emitter.nodes(&component.nodes, &[], false)?;

    let mut out = String::new();
    out.push_str(&format!(
        "// Generated by zubra from {}. Do not edit.\nimport {{ $define, $r, $t }} from {};\n",
        options.source_name,
        json(options.runtime)
    ));
    for import in &component.script.imports {
        let mut text = import.text.clone();
        // A component import loads the compiled module, which defines the element.
        if let (Some(extension), Some(component)) = (
            options.component_extension,
            crate::components::component_extension(&import.specifier),
        ) {
            let rewritten = format!(
                "{}{extension}",
                &import.specifier[..import.specifier.len() - component.len()]
            );
            text.replace_range(import.specifier_range.clone(), &json(&rewritten));
        }
        out.push_str(&text);
        if !text.trim_end().ends_with(';') {
            out.push(';');
        }
        out.push('\n');
    }
    if !script.state.is_empty() || !script.derived.is_empty() {
        out.push_str(&format!(
            "import {{ state as {}, computed as {} }} from {};\n",
            crate::reactive::STATE,
            crate::reactive::COMPUTED,
            json(options.runtime)
        ));
    }
    // The stylesheet: inlined, or through the bundler.
    let mut styles = None;
    let mut in_page = false;
    if let Some(style) = &component.style {
        match options.style_imports {
            Some(imports) if component.shadow => {
                out.push_str(&format!("import $styles from {};\n", json(imports.inline)));
                styles = Some("$styles".to_owned());
            }
            Some(imports) => {
                // Light DOM: the bundler puts the CSS in the page, and the text comes too, for
                // when the element is inside someone else's shadow root (a Lit app, say), where
                // page CSS doesn't reach.
                out.push_str(&format!("import {};\n", json(imports.stylesheet)));
                out.push_str(&format!("import $styles from {};\n", json(imports.inline)));
                styles = Some("$styles".to_owned());
                in_page = true;
            }
            None => {
                if let Some(lang) = &style.lang {
                    return Err(Diagnostic::new(
                        style.span,
                        format!("`<style lang=\"{lang}\">` needs a bundler to compile it: use @zubra/unplugin (Vite)"),
                    ));
                }
                styles = crate::styles::stylesheet(component).map(|css| json(&css));
            }
        }
    }
    out.push_str(&format!(
        "\nexport const tag = {};\n\nexport default $define(tag, {{\n  props: {{\n",
        json(&component.tag)
    ));
    for prop in &interface.props {
        let default = prop
            .default
            .as_ref()
            .map_or_else(|| "undefined".to_owned(), |value| value.to_string());
        out.push_str(&format!(
            "    {}: {{ attribute: {}, default: {default}, required: {}{} }},\n",
            json(&prop.name),
            json(&prop.attribute),
            prop.required(),
            if prop.model { ", model: true" } else { "" }
        ));
    }
    let mut slots: Vec<String> = {
        let mut names = std::collections::HashSet::new();
        validate::collect_slots(&component.nodes, &mut names);
        names.into_iter().collect()
    };
    slots.sort();
    let list =
        |names: &mut dyn Iterator<Item = &str>| names.map(json).collect::<Vec<_>>().join(", ");
    out.push_str(&format!(
        "  }},\n  abi: 2,\n  shadow: {},\n  form: {},\n  slots: [{}],\n  events: [{}],\n{}  template: {},\n  setup($p, $emit{}) {{\n",
        component.shadow,
        component.form_associated,
        list(&mut slots.iter().map(String::as_str)),
        list(&mut interface.events.iter().map(|event| event.name.as_str())),
        // `styled`: the runtime marks slotted content, where light-DOM styles stop.
        match (component.style.is_some(), styles) {
            (false, _) => String::new(),
            (true, None) => "  styled: true,\n".to_owned(),
            (true, Some(styles)) if in_page => format!("  styled: true,\n  styles: {styles},\n  inPage: true,\n"),
            (true, Some(styles)) => format!("  styled: true,\n  styles: {styles},\n"),
        },
        json(&emitter.template),
        if interface.props.iter().any(|prop| prop.runtime_default.is_some()) { ", $initial" } else { "" }
    ));
    // `emit` from the runtime, bound to this element (handlers call it long after setup).
    if let Some(emit) = &component.script.emit {
        out.push_str(&format!("    const {emit} = $emit;\n"));
    }
    if !script.state.is_empty() {
        out.push_str(crate::reactive::HELPERS);
    }
    let body = script.body.trim_matches('\n');
    if !body.trim().is_empty() {
        out.push_str(body);
        out.push('\n');
    }
    // Defaults that use script values: computed now, unless the prop was already given.
    for prop in &interface.props {
        if let Some(default) = &prop.runtime_default {
            let runtime = default.is_runtime();
            let rewritten =
                reactive_expression(default, &script.state, &script.derived, &script.signals);
            let default = rewritten.as_ref().unwrap_or(default);
            let value = default.to_js_with(&|name| {
                if runtime {
                    name.to_owned()
                } else {
                    format!("$r({name})")
                }
            });
            out.push_str(&format!(
                "    $initial({}, () => {value});\n",
                json(&prop.name)
            ));
        }
    }
    out.push_str("    return [\n");
    for part in &emitter.parts {
        out.push_str("      ");
        out.push_str(&part.render());
        out.push_str(",\n");
    }
    out.push_str("    ];\n  },\n});\n");
    // A spread's binder comes from `@zubra/runtime/spread`, imported only when the template uses one.
    if out.contains(&format!("bind: {SPREAD_BINDER}")) {
        let header_end = out.find('\n').map_or(0, |at| at + 1);
        // `@zubra/runtime` → `@zubra/runtime/spread`; a file (`/vendor/zubra/index.js`) → its sibling.
        let spread_module = match options.runtime.rsplit_once('/') {
            Some((directory, file)) if file.ends_with(".js") || file.ends_with(".mjs") => {
                format!("{directory}/spread.js")
            }
            _ => format!("{}/spread", options.runtime.trim_end_matches('/')),
        };
        out.insert_str(
            header_end,
            &format!(
                "import {{ spread as {SPREAD_BINDER} }} from {};\n",
                json(&spread_module)
            ),
        );
    }
    Ok(out)
}

/// The local name of `@zubra/runtime/spread`'s binder in compiled modules.
const SPREAD_BINDER: &str = "$spread";

/// The children `component` imports, as its emitter needs them.
/// The checks the HTML backend runs on a child component's attributes, with the values known at
/// build time (literals); values from props and state are checked in the browser.
fn check_child(element: &ast::Element, info: &ChildInfo) -> Result<(), Diagnostic> {
    for attribute in &element.attributes {
        validate::check_child_event(&element.name, &info.interface, attribute)?;
        if validate::is_unknown_child_attribute(&info.interface, attribute) {
            return Err(validate::unknown_child_prop(
                &element.name,
                &info.interface,
                attribute,
            ));
        }
        let prop_name = validate::camel(&attribute.name);
        let Some(prop) = info
            .interface
            .props
            .iter()
            .find(|prop| prop.name == prop_name)
        else {
            continue;
        };
        let known = match &attribute.value {
            AttributeValue::None => Some((serde_json::Value::Bool(true), attribute.span)),
            AttributeValue::Text(parts)
                if parts.iter().all(|part| matches!(part, Part::Literal(_))) =>
            {
                let text: String = parts
                    .iter()
                    .map(|part| match part {
                        Part::Literal(text) => html_escape::decode_html_entities(text).into_owned(),
                        Part::Expression { .. } => String::new(),
                    })
                    .collect();
                Some((serde_json::Value::String(text), attribute.span))
            }
            AttributeValue::Text(_) => {
                Some((serde_json::Value::String(String::new()), attribute.span))
            }
            AttributeValue::Expression(expression, span) => {
                let mut free = false;
                expression.for_each_identifier(&mut |_| free = true);
                if free {
                    None
                } else {
                    expression
                        .evaluate(&|_| None)
                        .ok()
                        .map(|value| (value, *span))
                }
            }
        };
        if let Some((value, span)) = known {
            validate::check_child_prop_type(&element.name, prop, &value, span)?;
        }
    }
    validate::check_child_required(&element.name, &info.interface, element)
}

fn child_infos(component: &ComponentAst) -> Result<Vec<(String, ChildInfo)>, Diagnostic> {
    component
        .children
        .iter()
        .map(|child| {
            let info = (|| {
                let interface = validate::analyze(&child.ast)?;
                let grandchildren = child_infos(&child.ast)?;
                let mut emitter = Emitter {
                    state: &[],
                    derived: &[],
                    signals: &[],
                    interface: &interface,
                    children: &grandchildren,
                    shadow: child.ast.shadow,
                    scopes: Vec::new(),
                    base: Vec::new(),
                    template: String::new(),
                    parts: Vec::new(),
                    slot_paths: Vec::new(),
                };
                emitter.nodes(&child.ast.nodes, &[], false)?;
                let slot_paths = std::mem::take(&mut emitter.slot_paths);
                drop(emitter);
                Ok(ChildInfo {
                    props: interface
                        .props
                        .iter()
                        .map(|prop| prop.name.clone())
                        .collect(),
                    interface,
                    shadow: child.ast.shadow,
                    slot_paths,
                })
            })()
            .map_err(|error: Diagnostic| error.in_file(&child.path, &child.source))?;
            Ok((child.ast.tag.clone(), info))
        })
        .collect()
}

fn json(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize")
}

/// One part: where it is (`path` in a fresh template; `hydrate` where it sits in server markup
/// when that differs — content projected into a child component's slot) and what it does.
#[derive(Clone)]
struct JsPart {
    path: Vec<usize>,
    hydrate: Option<Vec<usize>>,
    body: String,
}

impl JsPart {
    fn at(path: &[usize], body: String) -> Self {
        Self {
            path: path.to_vec(),
            hydrate: None,
            body,
        }
    }

    fn render(&self) -> String {
        match &self.hydrate {
            Some(hydrate) => format!(
                "{{ path: {}, hydrate: {}, {} }}",
                path_js(&self.path),
                path_js(hydrate),
                self.body
            ),
            None => format!("{{ path: {}, {} }}", path_js(&self.path), self.body),
        }
    }
}

fn path_js(path: &[usize]) -> String {
    format!(
        "[{}]",
        path.iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// What a parent needs to know about a child component it uses.
struct ChildInfo {
    interface: Interface,
    props: Vec<String>,
    shadow: bool,
    /// Where each slot region is in the child's template (light DOM only), for hydrate paths.
    slot_paths: Vec<(String, Vec<usize>)>,
}

struct Emitter<'a> {
    /// The script's state (`let`) and derived `const`s, read with `.get()` in runtime
    /// expressions.
    state: &'a [String],
    derived: &'a [String],
    /// The script's signal `const`s (`computed()`, `inject()`, `state()`): read like values.
    signals: &'a [String],
    interface: &'a Interface,
    children: &'a [(String, ChildInfo)],
    /// Shadow-DOM components compile zb-slot to a native <slot>.
    shadow: bool,
    /// Loop variables in scope, innermost last.
    scopes: Vec<String>,
    /// This emitter's position in the component template (non-empty inside zb-if blocks), so
    /// slot regions can be recorded with full paths.
    base: Vec<usize>,
    template: String,
    parts: Vec<JsPart>,
    slot_paths: Vec<(String, Vec<usize>)>,
}

impl<'a> Emitter<'a> {
    fn child(&self, extra: &[String]) -> Emitter<'a> {
        let mut scopes = self.scopes.clone();
        scopes.extend(extra.iter().cloned());
        Emitter {
            state: self.state,
            derived: self.derived,
            signals: self.signals,
            interface: self.interface,
            children: self.children,
            shadow: self.shadow,
            scopes,
            base: self.base.clone(),
            template: String::new(),
            parts: Vec::new(),
            slot_paths: Vec::new(),
        }
    }

    fn child_info(&self, tag: &str) -> Option<&'a ChildInfo> {
        self.children
            .iter()
            .find(|(child, _)| child.eq_ignore_ascii_case(tag))
            .map(|(_, info)| info)
    }

    /// An expression as JavaScript: loop variables and script names go through `$r`, which
    /// unwraps signals (rows hold their item as a signal; `const count = state(0)` makes `{count}`
    /// reactive); props read from `$p`, whose getters are signal-backed. Loop variables shadow
    /// props, props shadow script names — the same order the HTML backend resolves.
    ///
    /// A runtime expression (beyond the build-time subset) is script code: its script names
    /// mean what they mean in the script, so a `state()` is read with `.get()` there.
    fn js(&self, expression: &Expression) -> String {
        let runtime = expression.is_runtime();
        let rewritten = reactive_expression(expression, self.state, self.derived, self.signals);
        let expression = rewritten.as_ref().unwrap_or(expression);
        expression.to_js_with(&|name| {
            if self.scopes.iter().any(|scope| scope == name) {
                format!("$r({name})")
            } else if self.interface.props.iter().any(|prop| prop.name == name) {
                format!("$p.{name}")
            } else if runtime {
                // A script name, or a browser global.
                name.to_owned()
            } else {
                format!("$r({name})")
            }
        })
    }

    /// An event listener part's fields: the event, its handler, and its modifiers.
    fn listener(&self, lower: &str, expression: &Expression) -> String {
        let (event, modifiers) = crate::parser::event_parts(lower).unwrap_or_default();
        let mut fields = format!(
            "on: {}, handler: () => {}",
            json(&event),
            self.js(expression)
        );
        if modifiers != crate::parser::Modifiers::default() {
            let mut flags = Vec::new();
            for (on, name) in [
                (modifiers.prevent, "prevent"),
                (modifiers.stop, "stop"),
                (modifiers.once, "once"),
                (modifiers.self_only, "self"),
                (modifiers.capture, "capture"),
                (modifiers.passive, "passive"),
                (modifiers.shift, "shift"),
                (modifiers.ctrl, "ctrl"),
                (modifiers.alt, "alt"),
                (modifiers.meta, "meta"),
                (modifiers.primary, "mod"),
                (modifiers.submit, "submit"),
            ] {
                if on {
                    flags.push(format!("{name}: true"));
                }
            }
            if !modifiers.keys.is_empty() {
                flags.push(format!(
                    "keys: [{}]",
                    modifiers
                        .keys
                        .iter()
                        .map(|key| json(key))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            fields.push_str(&format!(", modifiers: {{ {} }}", flags.join(", ")));
        }
        fields
    }

    /// Text parts as one string-valued JavaScript expression.
    fn text_js(&self, parts: &[Part]) -> String {
        let pieces: Vec<String> = parts
            .iter()
            .filter_map(|part| match part {
                Part::Literal(text) if text.is_empty() => None,
                Part::Literal(text) => Some(json(&html_escape::decode_html_entities(text))),
                Part::Expression { expression, .. } => Some(format!("$t({})", self.js(expression))),
            })
            .collect();
        match pieces.as_slice() {
            [] => "\"\"".to_owned(),
            [only] if only.starts_with("$t(") => only.clone(),
            _ => pieces.join(" + "),
        }
    }

    /// A branch or row: its own template, and a function from its loop variables to its parts.
    fn block(
        &mut self,
        nodes: &[Node],
        params: &[String],
        at: &[usize],
    ) -> Result<String, Diagnostic> {
        let mut block = self.child(params);
        block.base = self.base.iter().chain(at).copied().collect();
        block.nodes(nodes, &[], true)?;
        self.slot_paths.append(&mut block.slot_paths);
        Ok(format!(
            "{{ template: {}, parts: ({}) => [{}] }}",
            json(&block.template),
            params.join(", "),
            block
                .parts
                .iter()
                .map(JsPart::render)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    /// `block_top`: these nodes are the top level of a branch or row (see
    /// `validate::needs_text_anchor`).
    fn nodes(&mut self, nodes: &[Node], path: &[usize], block_top: bool) -> Result<(), Diagnostic> {
        let mut index = 0;
        let mut next = |path: &[usize]| {
            let mut at = path.to_vec();
            at.push(index);
            index += 1;
            at
        };
        for node in nodes {
            match node {
                Node::Text(parts) => {
                    let dynamic = parts
                        .iter()
                        .any(|part| matches!(part, Part::Expression { .. }));
                    if !dynamic {
                        for part in parts {
                            if let Part::Literal(text) = part {
                                self.template.push_str(text);
                            }
                        }
                    } else if needs_text_anchor(nodes, node, block_top) {
                        self.template.push_str("<!---->");
                        let anchor = next(path);
                        self.parts.push(JsPart::at(
                            &anchor,
                            format!("anchor: () => {}", self.text_js(parts)),
                        ));
                    } else {
                        // The element's only child: bind the element's text.
                        self.parts.push(JsPart::at(
                            path,
                            format!("text: () => {}", self.text_js(parts)),
                        ));
                    }
                }
                Node::Element(element) if is_global_listener(&element.name) => {
                    // <zb-window>/<zb-document>: a placeholder comment, and listeners there.
                    self.template.push_str("<!---->");
                    let at = next(path);
                    let lower = element.name.to_ascii_lowercase();
                    let target = lower.strip_prefix("zb-").unwrap_or(&lower);
                    for attribute in &element.attributes {
                        if let AttributeValue::Expression(expression, _) = &attribute.value {
                            let lower = attribute.name.to_ascii_lowercase();
                            let body = format!(
                                "global: {}, {}",
                                json(target),
                                self.listener(&lower, expression)
                            );
                            self.parts.push(JsPart::at(&at, body));
                        }
                    }
                }
                Node::Element(element) => {
                    let element_path = next(path);
                    self.element(element, &element_path)?;
                }
                Node::If {
                    test,
                    consequent,
                    alternate,
                    ..
                } => {
                    // An empty region in the template; the branch is rendered (or found in
                    // server markup) at runtime.
                    self.template.push_str("<!--[--><!--]-->");
                    let region = next(path);
                    let yes = self.block(consequent, &[], &region)?;
                    let no = if alternate.is_empty() {
                        "null".to_owned()
                    } else {
                        self.block(alternate, &[], &region)?
                    };
                    let body = format!("when: () => {}, blocks: [{yes}, {no}]", self.js(test));
                    self.parts.push(JsPart::at(&region, body));
                }
                Node::Each {
                    items,
                    item,
                    index: position,
                    key,
                    children,
                    ..
                } => {
                    self.template.push_str("<!--[--><!--]-->");
                    let region = next(path);
                    let params = vec![
                        item.clone(),
                        position.clone().unwrap_or_else(|| "$index".to_owned()),
                    ];
                    let row = self.block(children, &params, &region)?;
                    // The key gets plain values (not row signals): it identifies a row.
                    let key = match key {
                        Some((key, _)) => format!(
                            ", key: ({}) => {}",
                            params.join(", "),
                            self.child(&params).js(key)
                        ),
                        None => String::new(),
                    };
                    let body = format!("each: () => {}{key}, block: {row}", self.js(items));
                    self.parts.push(JsPart::at(&region, body));
                }
                Node::Slot {
                    name,
                    fallback,
                    span,
                } => {
                    if self.shadow {
                        // The platform's own <slot>, with the fallback as its children.
                        let attributes = if name == "default" {
                            Vec::new()
                        } else {
                            vec![ast::Attribute {
                                name: "name".to_owned(),
                                value: AttributeValue::Text(vec![Part::Literal(name.clone())]),
                                span: *span,
                            }]
                        };
                        let slot = ast::Element {
                            name: "slot".to_owned(),
                            attributes,
                            children: fallback.clone(),
                            span: *span,
                        };
                        let slot_path = next(path);
                        self.element(&slot, &slot_path)?;
                    } else {
                        // A region the runtime fills with the host's own children for this slot,
                        // or with the fallback block.
                        self.template.push_str("<!--[--><!--]-->");
                        let region = next(path);
                        self.slot_paths.push((
                            name.clone(),
                            self.base.iter().chain(&region).copied().collect(),
                        ));
                        let fallback = if fallback.is_empty() {
                            "null".to_owned()
                        } else {
                            self.block(fallback, &[], &region)?
                        };
                        let body = format!("slot: {}, fallback: {fallback}", json(name));
                        self.parts.push(JsPart::at(&region, body));
                    }
                }
                Node::Else { span, .. } => {
                    return Err(Diagnostic::new(
                        *span,
                        "zb-else is only valid as a direct child of zb-if",
                    ));
                }
                Node::Await {
                    value,
                    pending,
                    then,
                    catch,
                    ..
                } => {
                    self.template.push_str("<!--[--><!--]-->");
                    let region = next(path);
                    let pending = self.block(pending, &[], &region)?;
                    let mut settled = Vec::new();
                    for (branch, unnamed) in [(then, "$value"), (catch, "$error")] {
                        settled.push(match branch {
                            Some(branch) => {
                                let name =
                                    branch.name.clone().unwrap_or_else(|| unnamed.to_owned());
                                self.block(&branch.children, &[name], &region)?
                            }
                            None => "null".to_owned(),
                        });
                    }
                    let body = format!(
                        "await: () => {}, blocks: [{pending}, {}, {}]",
                        self.js(value),
                        settled[0],
                        settled[1]
                    );
                    self.parts.push(JsPart::at(&region, body));
                }
                Node::Settled { caught, branch } => {
                    return Err(Diagnostic::new(
                        branch.span,
                        format!(
                            "zb-{} is only valid as a direct child of zb-await",
                            if *caught { "catch" } else { "then" }
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    fn element(&mut self, element: &ast::Element, path: &[usize]) -> Result<(), Diagnostic> {
        let child = self.child_info(&element.name);
        if let Some(info) = child {
            check_child(element, info)?;
        }
        let custom = element.name.contains('-');
        self.template.push('<');
        self.template.push_str(&element.name);
        // What the element binds itself, which a spread leaves alone (an explicit attribute wins).
        let own: Vec<String> = element
            .attributes
            .iter()
            .filter(|attribute| attribute.name != crate::parser::SPREAD)
            .map(|attribute| {
                let lower = attribute.name.to_ascii_lowercase();
                match lower.split_once('.') {
                    Some((name, _)) if is_event_attribute(name) => name.to_owned(),
                    _ => lower,
                }
            })
            .collect();
        for attribute in &element.attributes {
            if attribute.name == crate::parser::SPREAD {
                if let Some(info) = child {
                    let _ = info;
                    return Err(Diagnostic::new(
                        attribute.span,
                        format!("<{}> is a zubra component: pass each prop rather than spreading an object onto it", element.name),
                    )
                    .with_help("a spread works on HTML elements and other libraries' custom elements"));
                }
                let AttributeValue::Expression(expression, _) = &attribute.value else {
                    unreachable!("a spread is always an expression");
                };
                // `bind`: the code that applies it, from its own runtime entry, so components
                // without a spread don't load it.
                let body = format!(
                    "spread: () => {}, own: [{}], bind: {SPREAD_BINDER}",
                    self.js(expression),
                    own.iter()
                        .map(|name| json(name))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                self.parts.push(JsPart::at(path, body));
                continue;
            }
            let lower = attribute.name.to_ascii_lowercase();
            let prop = validate::camel(&lower);
            // A prop of a known child component: always passed as a property value.
            if let Some(child) = child.filter(|child| child.props.contains(&prop)) {
                let _ = child;
                let compute = match &attribute.value {
                    AttributeValue::None => "true".to_owned(),
                    AttributeValue::Text(parts) => self.text_js(parts),
                    AttributeValue::Expression(expression, _) => self.js(expression),
                };
                self.parts.push(JsPart::at(
                    path,
                    format!("property: {}, value: () => {compute}", json(&prop)),
                ));
                continue;
            }
            match &attribute.value {
                AttributeValue::None => {
                    self.template.push(' ');
                    self.template.push_str(&attribute.name);
                }
                AttributeValue::Text(parts)
                    if parts.iter().all(|part| matches!(part, Part::Literal(_))) =>
                {
                    self.template.push(' ');
                    self.template.push_str(&attribute.name);
                    self.template.push_str("=\"");
                    for part in parts {
                        if let Part::Literal(text) = part {
                            self.template.push_str(text);
                        }
                    }
                    self.template.push('"');
                }
                AttributeValue::Expression(expression, _) if is_event_attribute(&lower) => {
                    let body = self.listener(&lower, expression);
                    self.parts.push(JsPart::at(path, body));
                }
                AttributeValue::Expression(expression, _) if lower.starts_with("class:") => {
                    let body = format!(
                        "toggle: {}, value: () => {}",
                        json(&attribute.name[6..]),
                        self.js(expression)
                    );
                    self.parts.push(JsPart::at(path, body));
                }
                AttributeValue::Expression(expression, _) if lower.starts_with("style:") => {
                    let body = format!(
                        "style: {}, value: () => {}",
                        json(&attribute.name[6..]),
                        self.js(expression)
                    );
                    self.parts.push(JsPart::at(path, body));
                }
                AttributeValue::Expression(expression, _) if lower == "ref" => {
                    let body = format!("ref: () => {}", self.js(expression));
                    self.parts.push(JsPart::at(path, body));
                }
                value
                    if lower == "class"
                        && element
                            .attributes
                            .iter()
                            .any(|other| other.name.to_ascii_lowercase().starts_with("class:")) =>
                {
                    // A computed class next to class: toggles: its tokens are added and removed
                    // one by one, so the toggles' classes stay.
                    let compute = match value {
                        AttributeValue::Text(parts) => self.text_js(parts),
                        AttributeValue::Expression(expression, _) => self.js(expression),
                        AttributeValue::None => unreachable!("handled above"),
                    };
                    self.parts
                        .push(JsPart::at(path, format!("classes: () => {compute}")));
                }
                value => {
                    let compute = match value {
                        AttributeValue::Text(parts) => self.text_js(parts),
                        AttributeValue::Expression(expression, _) => self.js(expression),
                        AttributeValue::None => unreachable!("handled above"),
                    };
                    let kind = if BOOLEAN_ATTRIBUTES.contains(&lower.as_str()) {
                        ", boolean: true".to_owned()
                    } else if URL_ATTRIBUTES.contains(&lower.as_str()) {
                        ", url: true".to_owned()
                    } else if custom
                        && child.is_none()
                        && matches!(value, AttributeValue::Expression(..))
                    {
                        // Another library's custom element: a property if it has one, else an
                        // attribute (React 19's rule).
                        format!(", prop: {}", json(&prop))
                    } else {
                        String::new()
                    };
                    let body = format!(
                        "attribute: {}{kind}, value: () => {compute}",
                        json(&attribute.name)
                    );
                    self.parts.push(JsPart::at(path, body));
                }
            }
        }
        self.template.push('>');
        if VOID_ELEMENTS.contains(&element.name.to_ascii_lowercase().as_str()) {
            return Ok(());
        }
        match child {
            // Content for a light-DOM child component's slots: emitted here (it's this
            // component's markup, in this component's scope), with hydrate paths that follow
            // each node to where the child projected it in server markup.
            Some(info) if !info.shadow => {
                let units = content_units(&element.children);
                let mut content = self.child(&[]);
                content.nodes(&element.children, &[], true)?;
                self.template.push_str(&content.template);
                for part in content.parts {
                    let local = part.hydrate.clone().unwrap_or_else(|| part.path.clone());
                    let hydrate = match local.split_first() {
                        Some((first, rest)) => {
                            let Some((slot, position)) = units.get(*first) else {
                                return Err(Diagnostic::new(
                                    element.span,
                                    "internal error: slot content position out of range",
                                ));
                            };
                            let Some((_, region)) =
                                info.slot_paths.iter().find(|(name, _)| name == slot)
                            else {
                                return Err(Diagnostic::new(
                                    element.span,
                                    format!("<{}> has no slot named `{slot}`", element.name),
                                ));
                            };
                            path.iter()
                                .chain(region)
                                .copied()
                                .chain(std::iter::once(*position))
                                .chain(rest.iter().copied())
                                .collect()
                        }
                        // A part bound to the content's own parent: can't happen at block top.
                        None => path.to_vec(),
                    };
                    self.parts.push(JsPart {
                        path: path.iter().chain(&part.path).copied().collect(),
                        hydrate: Some(hydrate),
                        body: part.body,
                    });
                }
            }
            _ => self.nodes(&element.children, path, false)?,
        }
        self.template.push_str("</");
        self.template.push_str(&element.name);
        self.template.push('>');
        Ok(())
    }
}

/// For content placed inside a light-DOM child component: for each position (as `nodes`
/// counts them with `block_top`), the slot it goes to and its position within that slot.
fn content_units(nodes: &[Node]) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut units = Vec::new();
    let mut push = |slot: String| {
        let entry = counts.iter_mut().find(|(name, _)| *name == slot);
        let position = match entry {
            Some((_, count)) => {
                *count += 1;
                *count - 1
            }
            None => {
                counts.push((slot.clone(), 1));
                0
            }
        };
        units.push((slot, position));
    };
    for node in nodes {
        match node {
            Node::Text(parts) => {
                if needs_text_anchor(nodes, node, true)
                    && parts
                        .iter()
                        .any(|part| matches!(part, Part::Expression { .. }))
                {
                    push("default".to_owned());
                }
            }
            Node::Element(element) => {
                let slot = element
                    .attributes
                    .iter()
                    .find(|attribute| attribute.name == "slot")
                    .and_then(|attribute| match &attribute.value {
                        AttributeValue::Text(parts) => match parts.as_slice() {
                            [Part::Literal(text)] => Some(text.clone()),
                            _ => None,
                        },
                        _ => None,
                    })
                    .unwrap_or_else(|| "default".to_owned());
                push(slot);
            }
            Node::If { .. } | Node::Each { .. } | Node::Slot { .. } | Node::Await { .. } => {
                push("default".to_owned())
            }
            Node::Else { .. } | Node::Settled { .. } => {}
        }
    }
    units
}

/// A runtime expression with the script's state and derived values read with `.get()` (and
/// state assigned), or `None` when it doesn't use them.
fn reactive_expression(
    expression: &Expression,
    state: &[String],
    derived: &[String],
    signals: &[String],
) -> Option<Expression> {
    let Expression::Runtime { source, .. } = expression else {
        return None;
    };
    if state.is_empty() && derived.is_empty() && signals.is_empty() {
        return None;
    }
    let rewritten =
        crate::reactive::rewrite_template_expression(source, state, derived, signals).ok()??;
    let names = crate::runtime_expression::parse(&rewritten).ok()?;
    Some(Expression::Runtime {
        source: rewritten,
        names,
    })
}
