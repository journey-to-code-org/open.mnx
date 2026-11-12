//! `--emit element`: the component as a standard custom element, written to be read.
//!
//! The output is one class that extends `HTMLElement` and is registered with
//! `customElements.define()`, with no runtime and no imports of its own. Each part of the
//! component is there as the platform does it, so the file teaches how custom elements work:
//!
//! - props are accessors over a private `#props` object, listed in `observedAttributes`, with
//!   `attributeChangedCallback` turning each attribute's text into its prop's type;
//! - the template is markup cloned once per element; the nodes that change are looked up by
//!   position and named (`const less = content.children[0]`);
//! - each dynamic spot is one line: what it reads, and the DOM call that writes it
//!   (`bind(() => element.label, (value) => less.setAttribute("aria-label", value))`);
//! - events are `addEventListener` calls; a form control uses `attachInternals()`;
//! - the component's `<script>` runs once per element, inside `#setup()`, with its props as
//!   `element.name` and its state as `name.value`.
//!
//! What the platform doesn't do for light DOM (keyed lists, light-DOM slots, deep state) is in
//! small helpers below the class, each written into the module only when the component uses it.
//!
//! What isn't covered is refused with a reason, pointing at `--emit js`: shadow DOM, spreads,
//! zb-await, and runtime features beyond the basics (`resource`, `createContext`,
//! `@zubra/runtime/zag`…). `@zubra/runtime/primitives` stays an import: it needs nothing else.

use std::collections::{BTreeSet, HashMap, HashSet};

use oxc_ast::ast::Expression as JsExpression;

use crate::{
    ast::{self, AttributeValue, ComponentAst, Node, Part},
    diagnostic::Diagnostic,
    emit_js::{self, ChildInfo},
    expression::Expression,
    parser::is_event_attribute,
    reactive::Lowering,
    validate::{self, needs_text_anchor, Interface, BOOLEAN_ATTRIBUTES, URL_ATTRIBUTES},
};

/// The helpers a module may include (see the file's header).
const HELPERS: &str = include_str!("element_helpers.js");

/// What a script may import from `@zubra/runtime` in an element: the element defines these.
const PROVIDED: &[&str] = &[
    "state",
    "computed",
    "effect",
    "onMount",
    "onUnmount",
    "id",
    "host",
    "emit",
    "formValue",
    "validity",
    "hasSlot",
    "hydrated",
    "isSafeUrl",
    "isSafeSrcset",
];

/// Runtime entry points an element may import as they are (they import nothing themselves).
const STANDALONE: &[&str] = &["@zubra/runtime/primitives"];

const HINT: &str = "use --emit js, which keeps @zubra/runtime";

/// Elements whose `value` attribute is only a starting value: the property is what's shown.
const VALUE_PROPERTY: &[&str] = &[
    "input", "textarea", "select", "option", "output", "data", "li", "meter", "progress", "param",
];

/// Words a generated name can't be.
const RESERVED: &[&str] = &[
    "arguments",
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
    "eval",
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
    "undefined",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "async",
    "of",
    "get",
    "set",
    "window",
    "document",
    "globalThis",
    "customElements",
    "Node",
    "Element",
    "HTMLElement",
    "Text",
    "Comment",
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "JSON",
    "Symbol",
    "Map",
    "Set",
    "WeakMap",
    "WeakRef",
    "Proxy",
    "Reflect",
    "Promise",
    "Math",
    "console",
    "queueMicrotask",
    "structuredClone",
    "MutationObserver",
    "CSSStyleSheet",
    "CustomEvent",
    "FormData",
    "File",
    "navigator",
    "tag",
];

pub fn emit(
    component: &ComponentAst,
    source_name: &str,
    component_extension: Option<&str>,
) -> Result<String, Diagnostic> {
    // ---- what --emit element doesn't cover
    // `@zubra/sync` binds to `@zubra/runtime`'s signals, which an element doesn't have.
    if let Some(collection) = &component.script.collection {
        return Err(Diagnostic::new(
            collection.span,
            "--emit element doesn't support 'use collection': `@zubra/sync` works with `@zubra/runtime`, which a plain element doesn't include",
        )
        .with_help(
            "compile this component with --emit js (the default), which keeps its state on the device",
        ));
    }
    if component.shadow {
        return Err(Diagnostic::new(
            component.tag_span,
            "--emit element makes light-DOM elements, and this component has a shadow root",
        )
        .with_help(HINT));
    }
    // The script's runtime imports, as (imported, local).
    let mut runtime_imports: Vec<(String, String)> = Vec::new();
    for import in &component.script.imports {
        let specifier = import.specifier.as_str();
        if specifier == "@zubra/runtime" {
            for (imported, local) in named_imports(&import.text) {
                if !PROVIDED.contains(&imported.as_str()) {
                    return Err(Diagnostic::new(
                        component.tag_span,
                        format!("--emit element doesn't provide `{imported}` from @zubra/runtime"),
                    )
                    .with_help(format!(
                        "an element has {}; for more, {HINT}",
                        PROVIDED.join(", ")
                    )));
                }
                runtime_imports.push((imported, local));
            }
        } else if specifier.starts_with("@zubra/runtime/") && !STANDALONE.contains(&specifier) {
            return Err(Diagnostic::new(
                component.tag_span,
                format!("--emit element can't include `{specifier}`: it needs the runtime"),
            )
            .with_help(HINT));
        }
    }
    refuse_unsupported(&component.nodes)?;

    // ---- the component, as the JavaScript backend understands it
    let interface = validate::analyze(component)?;
    for name in &interface.script_names {
        if name.starts_with('$') {
            return Err(Diagnostic::new(
                component.tag_span,
                format!("`{name}`: names starting with $ are reserved for compiled code"),
            ));
        }
    }
    let children = emit_js::child_infos(component)?;
    let prop_names: Vec<String> = interface
        .props
        .iter()
        .map(|prop| prop.name.clone())
        .collect();
    let imported: Vec<String> = component
        .script
        .imports
        .iter()
        .flat_map(|import| crate::reactive::imported_names(&import.text))
        .collect();
    // The local names of the hooks that make signals.
    let makers: Vec<String> = runtime_imports
        .iter()
        .filter(|(imported, local)| {
            matches!(
                imported.as_str(),
                "state" | "computed" | "inject" | "hasSlot" | "hydrated"
            ) && !local.starts_with("__zubra")
        })
        .map(|(_, local)| local.clone())
        .collect();

    // ---- names: everything the script and template use is taken
    let mut taken: HashSet<String> = RESERVED.iter().map(|name| (*name).to_owned()).collect();
    taken.extend(interface.script_names.iter().cloned());
    taken.extend(imported.iter().cloned());
    taken.extend(prop_names.iter().cloned());
    taken.extend(script_identifiers(&component.script.body));
    collect_template_names(&component.nodes, &mut taken);
    let mut names = Names::new(taken);
    let receiver = names.local("element");
    let local_for = |wanted: &str| {
        runtime_imports
            .iter()
            .find(|(imported, _)| imported == wanted)
            .map(|(_, local)| local.clone())
    };
    let state_name = local_for("state").unwrap_or_else(|| names.local("state"));
    let computed_name = local_for("computed").unwrap_or_else(|| names.local("computed"));
    let models: Vec<String> = interface
        .props
        .iter()
        .filter(|prop| prop.model)
        .map(|prop| prop.name.clone())
        .collect();
    let lowering = Lowering {
        props: &receiver,
        models: &models,
        state: &state_name,
        computed: &computed_name,
        value: true,
    };
    let script = crate::reactive::rewrite_script_with(
        &component.script.body,
        &prop_names,
        &makers,
        &imported,
        &component.script.from,
        component
            .script
            .start
            .unwrap_or(crate::diagnostic::Span::new(1, 1)),
        lowering,
    )?;

    let mut slots: Vec<String> = {
        let mut found = HashSet::new();
        validate::collect_slots(&component.nodes, &mut found);
        found.into_iter().collect()
    };
    slots.sort();
    let imports_hook = |hook: &str| runtime_imports.iter().any(|(imported, _)| imported == hook);
    let uses_slots = !slots.is_empty() || imports_hook("hasSlot");
    let styled = component.style.is_some();

    let mut emitter = Emitter {
        interface: &interface,
        children: &children,
        state: &script.state,
        derived: &script.derived,
        signals: &script.signals,
        functions: &component.script.runtime_names,
        receiver: receiver.clone(),
        lowering,
        names: &mut names,
        uses: BTreeSet::new(),
        members: BTreeSet::new(),
        slots: uses_slots,
    };

    // ---- the template
    let content = emitter.names.local("content");
    let mut main = Block::new(&content, "    ", false, Vec::new());
    emitter.nodes(&mut main, &component.nodes, false)?;
    let markup_call = emitter.clone_call(&main);

    // ---- the script's hooks, as this element provides them
    let mut hooks: Vec<String> = Vec::new();
    let mut defined: HashSet<String> = HashSet::new();
    let mut wanted: Vec<(String, String)> = runtime_imports.clone();
    if !script.state.is_empty() && !wanted.iter().any(|(_, local)| *local == state_name) {
        wanted.push(("state".to_owned(), state_name.clone()));
    }
    if !script.derived.is_empty() && !wanted.iter().any(|(_, local)| *local == computed_name) {
        wanted.push(("computed".to_owned(), computed_name.clone()));
    }
    if let Some(emit) = &component.script.emit {
        if !wanted.iter().any(|(_, local)| local == emit) {
            wanted.push(("emit".to_owned(), emit.clone()));
        }
    }
    for (imported, local) in &wanted {
        if !defined.insert(local.clone()) {
            continue;
        }
        let definition = match imported.as_str() {
            "state" => {
                let create = emitter.helper("createState");
                format!("(initial) => {create}(initial, () => this.#requestUpdate())")
            }
            "computed" => {
                emitter.members.insert("tracking");
                emitter.helper("createComputed")
            }
            "effect" => {
                emitter.members.insert("effects");
                "(run) => {\n      this.#effects.push({ run, seen: null, cleanup: null });\n    }"
                    .to_owned()
            }
            "onMount" => {
                emitter.members.insert("mounted");
                "(run) => {\n      this.#mounted.push(run);\n    }".to_owned()
            }
            "onUnmount" => {
                emitter.members.insert("unmounted");
                "(run) => {\n      this.#unmounted.push(run);\n    }".to_owned()
            }
            "id" => {
                let ids = emitter.helper("ids");
                format!("() => `${{this.localName}}-${{++{ids}}}`")
            }
            "host" => "() => this".to_owned(),
            "emit" => "(name, detail) => this.#fire(name, detail)".to_owned(),
            "formValue" => {
                emitter.members.insert("formValue");
                "(read) => {\n      this.#formValue = read;\n    }".to_owned()
            }
            "validity" => {
                emitter.members.insert("validity");
                "(read) => {\n      this.#validity = read;\n    }".to_owned()
            }
            "hasSlot" => {
                let live = emitter.helper("live");
                emitter.helper("slotted");
                let is_content = emitter.names.module("isContent");
                format!("(name = \"default\") => {live}(() => this.#slot(name).nodes.some({is_content}))")
            }
            "hydrated" => {
                let live = emitter.helper("live");
                format!("() => {live}(() => this.#started)")
            }
            "isSafeUrl" | "isSafeSrcset" => {
                let helper = emitter.helper(imported);
                if helper == *local {
                    continue;
                }
                helper
            }
            _ => unreachable!("checked against PROVIDED"),
        };
        hooks.push(format!("    const {local} = {definition};\n"));
    }
    // Prop reads are tracked when something caches by what it read (computed(), effect()).
    let tracking = emitter.members.contains("effects") || emitter.members.contains("tracking");
    if tracking {
        emitter.helper("reads");
    }

    // Defaults that use script values: worked out after the script, unless the prop was given.
    let mut initial = String::new();
    for prop in &interface.props {
        if let Some(default) = &prop.runtime_default {
            let main_scope = Block::new("", "", false, Vec::new());
            let value = emitter.js(&main_scope, default);
            initial.push_str(&format!(
                "    if (!this.#given.has({name})) this.#props.{prop} = {value};\n",
                name = json(&prop.name),
                prop = prop.name
            ));
        }
    }

    let model = if component.form_associated && models.len() == 1 {
        Some(models[0].clone())
    } else {
        None
    };
    let class_name = names_class(&component.tag, emitter.names);
    let mut uses = emitter.uses.clone();
    let members = emitter.members.clone();
    let main_lines = main.lines.clone();
    let main_updates = main.updates.clone();
    let insert_bypass = uses_slots;
    drop(emitter);

    // ---- the module
    let mut out = String::new();
    out.push_str(&format!(
        "// Generated by zubra from {source_name} (--emit element). Do not edit: change the .zb file.\n//\n// A standard custom element: a class that extends HTMLElement, registered with\n// customElements.define(), with no framework and nothing to install. Each part of the component\n// is here as the platform does it. What the platform doesn't do for light DOM is in small helpers\n// after the class.\n"
    ));
    let mut module_imports = String::new();
    for import in &component.script.imports {
        if import.specifier == "@zubra/runtime" {
            continue;
        }
        let mut text = import.text.clone();
        if let (Some(extension), Some(found)) = (
            component_extension,
            crate::components::component_extension(&import.specifier),
        ) {
            let rewritten = format!(
                "{}{extension}",
                &import.specifier[..import.specifier.len() - found.len()]
            );
            text.replace_range(import.specifier_range.clone(), &json(&rewritten));
        }
        module_imports.push_str(&text);
        if !text.trim_end().ends_with(';') {
            module_imports.push(';');
        }
        module_imports.push('\n');
    }
    if !module_imports.is_empty() {
        out.push('\n');
        out.push_str(&module_imports);
    }
    out.push_str(&format!("\nexport const tag = {};\n", json(&component.tag)));

    // The styles.
    let css = match &component.style {
        Some(style) => {
            if let Some(lang) = &style.lang {
                return Err(Diagnostic::new(
                    style.span,
                    format!("`<style lang=\"{lang}\">` needs a bundler to compile it: use @zubra/unplugin (Vite)"),
                ));
            }
            crate::styles::stylesheet(component)
        }
        None => None,
    };
    let sheet = css.as_ref().map(|_| names.module("sheet"));
    if let (Some(css), Some(sheet)) = (&css, &sheet) {
        out.push_str(&format!(
            "\n// The component's styles: one stylesheet, shared by every {tag} on the page (made when the\n// first one connects, since a server that imports this module has no CSSStyleSheet).\nlet {sheet} = null;\nconst css = {};\n",
            template_literal(css),
            tag = component.tag
        ));
    }

    // The class.
    let observed: Vec<String> = interface
        .props
        .iter()
        .map(|prop| json(&prop.attribute))
        .collect();
    out.push_str(&format!(
        "\nexport class {class_name} extends HTMLElement {{\n"
    ));
    out.push_str(&format!(
        "  /** The attributes this element watches: attributeChangedCallback runs when one changes. */\n  static observedAttributes = [{}];\n",
        observed.join(", ")
    ));
    if component.form_associated {
        out.push_str("  /** A form control: it submits a value with its <form>, resets and validates. */\n  static formAssociated = true;\n");
    }
    // What the framework adapters read (@zubra/runtime/react and /vue wrap the element with it).
    let meta_props: Vec<String> = interface
        .props
        .iter()
        .map(|prop| {
            format!(
                "      {}: {{ attribute: {}, default: {}, required: {}{} }},\n",
                property_key(&prop.name),
                json(&prop.attribute),
                prop.default
                    .as_ref()
                    .map_or_else(|| "undefined".to_owned(), |value| value.to_string()),
                prop.required(),
                if prop.model { ", model: true" } else { "" }
            )
        })
        .collect();
    let events: Vec<String> = interface
        .events
        .iter()
        .map(|event| json(&event.name))
        .collect();
    out.push_str(&format!(
        "  /** What framework adapters (@zubra/runtime/react, /vue) read to wrap this element. */\n  static zubra = {{\n    tag,\n    props: {{\n{}    }},\n    events: [{}],\n    slots: [{}],\n    shadow: false,\n    form: {},\n    element: true,\n  }};\n\n",
        meta_props.concat(),
        events.join(", "),
        slots.iter().map(|slot| json(slot)).collect::<Vec<_>>().join(", "),
        component.form_associated
    ));

    // Fields.
    out.push_str("  // ElementInternals: the element's form value and validity, and :state() for CSS.\n  #internals = this.attachInternals();\n");
    let defaults: Vec<String> = interface
        .props
        .iter()
        .map(|prop| {
            format!(
                "{}: {}",
                property_key(&prop.name),
                prop.default
                    .as_ref()
                    .map_or_else(|| "undefined".to_owned(), |value| value.to_string())
            )
        })
        .collect();
    out.push_str(&format!(
        "  // The props, each starting at its default; #given has the ones set from outside.\n  #props = {{ {} }};\n  #given = new Set();\n",
        defaults.join(", ")
    ));
    out.push_str("  // What brings the DOM up to date: one function for each spot that changes.\n  #updates = [];\n  #pending = null;\n  #started = false;\n");
    if members.contains("effects") {
        out.push_str("  #effects = [];\n");
    }
    if members.contains("mounted") || members.contains("unmounted") {
        out.push_str("  #mounted = [];\n  #cleanups = [];\n");
    }
    if members.contains("unmounted") {
        out.push_str("  #unmounted = [];\n");
    }
    if members.contains("formValue") {
        out.push_str("  #formValue = null;\n");
    }
    if members.contains("validity") {
        out.push_str("  #validity = null;\n");
    }
    if model.is_some() {
        out.push_str("  #reset; // the two-way prop's starting value, for a form reset\n");
    }

    // Constructor.
    out.push_str("\n  constructor() {\n    super();\n");
    for event in &interface.events {
        out.push_str(&format!(
            "    // {name} is this element's own event: one of the same name bubbling up from inside stops here.\n    this.addEventListener({quoted}, (event) => {{\n      if (event.target !== this) event.stopImmediatePropagation();\n    }});\n",
            name = event.name,
            quoted = json(&event.name)
        ));
    }
    if !interface.props.is_empty() {
        let list: Vec<String> = interface
            .props
            .iter()
            .map(|prop| json(&prop.name))
            .collect();
        out.push_str(&format!(
            "    // A property set before this class was defined sits on the element itself, hiding the\n    // accessor below: take it over.\n    for (const prop of [{}]) {{\n      if (Object.hasOwn(this, prop)) {{\n        const value = this[prop];\n        delete this[prop];\n        this[prop] = value;\n      }}\n    }}\n",
            list.join(", ")
        ));
    }
    out.push_str("  }\n");

    // Props.
    if !interface.props.is_empty() {
        out.push_str("\n  // ---- props: properties, and attributes that set them\n");
    }
    let reads = if tracking {
        Some(names.module("reads"))
    } else {
        None
    };
    for prop in &interface.props {
        let name = &prop.name;
        let track = reads.as_ref().map_or_else(String::new, |reads| {
            format!("    {reads}?.push(() => this.#props.{name}); // what reads it (a computed, an effect) depends on it\n")
        });
        out.push_str(&format!(
            "\n  get {name}() {{\n{track}    return this.#props.{name};\n  }}\n  set {name}(value) {{\n    this.#given.add({quoted});\n    if (Object.is(value, this.#props.{name})) return;\n    this.#props.{name} = value;\n    this.#requestUpdate();\n  }}\n",
            quoted = json(name)
        ));
        if prop.model {
            let event = format!("{}change", name.to_ascii_lowercase());
            out.push_str(&format!(
                "  // The component's own writes to {name} (from its script): {name} is two-way, so they fire {event}.\n  get #{name}() {{\n    return this.{name};\n  }}\n  set #{name}(value) {{\n    if (Object.is(value, this.{name})) return;\n    this.{name} = value;\n    this.#fire({quoted}, value);\n  }}\n",
                quoted = json(&event)
            ));
        }
    }
    if !interface.props.is_empty() {
        let mut from_json = None;
        out.push_str("\n  attributeChangedCallback(name, previous, raw) {\n    // raw is the attribute's text, or null once it's removed.\n    switch (name) {\n");
        for prop in &interface.props {
            let default = prop
                .default
                .as_ref()
                .map_or_else(|| "undefined".to_owned(), |value| value.to_string());
            let parsed = match &prop.default {
                Some(serde_json::Value::Bool(true)) => "raw !== \"false\"".to_owned(),
                Some(serde_json::Value::Bool(false)) => "raw !== null".to_owned(),
                Some(serde_json::Value::Number(_)) => {
                    format!("raw === null ? {default} : Number(raw)")
                }
                Some(serde_json::Value::String(_)) => format!("raw ?? {default}"),
                other => {
                    let helper = from_json
                        .get_or_insert_with(|| names.module("fromJson"))
                        .clone();
                    let fallback = match other {
                        Some(serde_json::Value::Array(_) | serde_json::Value::Object(_)) => {
                            default.clone()
                        }
                        _ => "raw".to_owned(),
                    };
                    format!("raw === null ? {default} : {helper}(raw, {fallback})")
                }
            };
            out.push_str(&format!(
                "      case {}:\n        this.{} = {parsed};\n        break;\n",
                json(&prop.attribute),
                prop.name
            ));
        }
        out.push_str("    }\n  }\n");
        if from_json.is_some() {
            uses.insert("fromJson");
        }
    }

    // Lifecycle.
    out.push_str("\n  // ---- lifecycle\n\n  connectedCallback() {\n");
    if let Some(sheet) = &sheet {
        out.push_str(&format!(
            "    // The styles go to the root the element is in: the document, or a shadow root it's inside.\n    const root = this.getRootNode();\n    if (root.adoptedStyleSheets) {{\n      if (!{sheet}) {{\n        {sheet} = new CSSStyleSheet();\n        {sheet}.replaceSync(css);\n      }}\n      if (!root.adoptedStyleSheets.includes({sheet})) root.adoptedStyleSheets = [...root.adoptedStyleSheets, {sheet}];\n    }}\n"
        ));
    }
    out.push_str("    if (!this.#started) this.#start();\n    this.#update();\n");
    if members.contains("mounted") {
        out.push_str("    this.#runMounted();\n");
    }
    out.push_str("  }\n");
    if members.contains("mounted") || members.contains("unmounted") {
        out.push_str("\n  disconnectedCallback() {\n");
        if members.contains("mounted") {
            out.push_str("    // What onMount() returned: undone each time the element leaves the page.\n    for (const cleanup of this.#cleanups.splice(0)) cleanup();\n");
        }
        if members.contains("unmounted") {
            out.push_str("    for (const run of this.#unmounted) run();\n");
        }
        out.push_str("  }\n");
    }
    if members.contains("mounted") {
        out.push_str("\n  #runMounted() {\n");
        if members.contains("effects") {
            out.push_str("    const effects = this.#effects.length;\n");
        }
        out.push_str("    for (const run of this.#mounted) {\n      const cleanup = run();\n      if (typeof cleanup === \"function\") this.#cleanups.push(cleanup);\n    }\n");
        if members.contains("effects") {
            out.push_str("    if (this.#effects.length > effects) this.#runEffects(); // effects onMount made\n");
        }
        out.push_str("  }\n");
    }

    // First connection: the template goes in.
    out.push_str("\n  #start() {\n    // Props a framework's server rendering wrote as JSON (zb-props), before it sets them as properties.\n    let given;\n    try {\n      given = JSON.parse(this.getAttribute(\"zb-props\"));\n    } catch {\n      // none\n    }\n    for (const name in given) if (Object.hasOwn(this.#props, name) && !this.#given.has(name)) this[name] = given[name];\n");
    if component.form_associated {
        out.push_str("    // The server's stand-in for this control's value: the element's own form value takes over.\n    for (const child of this.querySelectorAll(\":scope > input[data-zb-fallback]\")) child.remove();\n");
    }
    if uses_slots {
        out.push_str("    this.#collectSlots(); // the page's children, before the template takes their place\n");
    }
    out.push_str("    const content = this.#setup();\n    for (const update of this.#updates) update(); // filled in before it's on the page\n");
    if insert_bypass {
        out.push_str("    Element.prototype.replaceChildren.call(this, content);\n");
    } else {
        out.push_str("    this.replaceChildren(content);\n");
    }
    out.push_str("    this.#started = true;\n    this.#internals.states?.add(\"hydrated\"); // :state(hydrated), for CSS\n");
    if uses_slots && !slots.is_empty() {
        out.push_str("    this.#observe();\n");
    }
    if let Some(model) = &model {
        out.push_str(&format!(
            "    this.#reset = structuredClone(this.#props.{model});\n"
        ));
    }
    out.push_str("  }\n");

    // The script and the template.
    out.push_str(&format!(
        "\n  // The component's <script> and template, set up once per element. Props are read as\n  // {receiver}.name; state (a let) is name.value. Returns the template's nodes.\n  #setup() {{\n    const {receiver} = this;\n"
    ));
    if !hooks.is_empty() {
        out.push_str("    // The hooks the script uses (from @zubra/runtime in the source), made for this element.\n");
        for hook in &hooks {
            out.push_str(hook);
        }
    }
    let body = script.body.trim_matches('\n');
    if body.contains("$p.") {
        // A script the JSX front end lowered reads its props through $p.
        out.push_str("    // The script reads its props through $p (the JSX front end writes it that way).\n    const $p = {\n");
        for prop in &interface.props {
            let name = &prop.name;
            let private = if prop.model { "#" } else { "" };
            out.push_str(&format!(
                "      get {name}() {{\n        return {receiver}.{name};\n      }},\n      set {name}(value) {{\n        {receiver}.{private}{name} = value;\n      }},\n"
            ));
        }
        out.push_str("    };\n");
    }
    if !body.trim().is_empty() {
        out.push_str("\n    // ---- <script>\n");
        out.push_str(&indent_script(body, "    "));
        out.push('\n');
    }
    out.push_str(&initial);
    out.push_str(
        "\n    // ---- the template: its nodes, and how each changing spot is kept up to date\n",
    );
    out.push_str(&format!("    const {content} = {markup_call};\n"));
    for line in &main_lines {
        out.push_str(line);
        out.push('\n');
    }
    if main_updates.is_empty() {
        out.push_str("    this.#updates = [];\n");
    } else {
        out.push_str("    this.#updates = [\n");
        for update in &main_updates {
            out.push_str("      ");
            out.push_str(update);
            out.push_str(",\n");
        }
        out.push_str("    ];\n");
    }
    out.push_str(&format!("    return {content};\n  }}\n"));

    // Updates.
    out.push_str("\n  // ---- updates: changes are batched, and applied together in a microtask\n\n  #requestUpdate() {\n");
    out.push_str("    this.#pending ??= Promise.resolve().then(() => this.#update());\n  }\n\n  #update() {\n    this.#pending = null;\n    // Off the page, nothing updates; it catches up when it's back (connectedCallback).\n    if (!this.#started || !this.isConnected) return;\n    for (const update of this.#updates) update();\n");
    if members.contains("formValue") {
        out.push_str("    // What the element submits with its form (formValue() in the script).\n    if (this.#formValue) {\n      const value = this.#formValue();\n      this.#internals.setFormValue(value == null ? null : value instanceof FormData || value instanceof File ? value : String(value));\n    }");
        if model.is_some() {
            out.push_str(" else {\n");
        } else {
            out.push('\n');
        }
    }
    if let Some(model) = &model {
        let pad = if members.contains("formValue") {
            "      "
        } else {
            "    "
        };
        out.push_str(&format!(
            "{pad}// What the element submits with its form: its one two-way prop.\n{pad}const value = this.#props.{model};\n{pad}this.#internals.setFormValue(value == null || value === false || value === \"\" ? null : value === true ? \"on\" : typeof value === \"object\" ? JSON.stringify(value) : String(value));\n"
        ));
        if members.contains("formValue") {
            out.push_str("    }\n");
        }
    }
    if members.contains("validity") {
        out.push_str("    if (this.#validity) {\n      const message = String(this.#validity() || \"\");\n      // The browser shows the message at, and focuses, the first focusable thing the element rendered.\n      const anchor = [...this.querySelectorAll('input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex=\"-1\"]), [contenteditable]')].find((node) => !node.closest(\"[data-zb-slotted]\")) ?? this;\n      if (message) this.#internals.setValidity({ customError: true }, message, anchor);\n      else this.#internals.setValidity({});\n    }\n");
    }
    if members.contains("effects") {
        out.push_str("    this.#runEffects();\n");
    }
    out.push_str("  }\n");
    if let (Some(reads), true) = (&reads, members.contains("effects")) {
        out.push_str(&format!(
            "\n  // effect(): runs again only when something it read has changed since.\n  #runEffects() {{\n    for (const effect of this.#effects) {{\n      if (effect.seen?.every(([read, value]) => Object.is(read(), value))) continue;\n      if (typeof effect.cleanup === \"function\") effect.cleanup();\n      const outer = {reads};\n      const seen = ({reads} = []);\n      try {{\n        effect.cleanup = effect.run();\n      }} finally {{\n        {reads} = outer;\n        effect.seen = seen.map((read) => [read, read()]);\n      }}\n    }}\n  }}\n"
        ));
    }
    out.push_str("\n  /** Resolves once pending changes are on the page. */\n  get updateComplete() {\n    return this.#pending ?? Promise.resolve();\n  }\n\n  /** Fires one of the element's events: it bubbles; a before… event can be cancelled. */\n  #fire(name, detail) {\n    return this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, cancelable: name.startsWith(\"before\") }));\n  }\n");

    // Forms.
    if component.form_associated {
        out.push_str("\n  // ---- form control: what <input> has, from ElementInternals\n\n  get form() {\n    return this.#internals.form;\n  }\n  get validity() {\n    return this.#internals.validity;\n  }\n  get validationMessage() {\n    return this.#internals.validationMessage;\n  }\n  get willValidate() {\n    return this.#internals.willValidate;\n  }\n  checkValidity() {\n    return this.#internals.checkValidity();\n  }\n  reportValidity() {\n    return this.#internals.reportValidity();\n  }\n");
        if let Some(model) = &model {
            let event = format!("{}change", model.to_ascii_lowercase());
            out.push_str(&format!(
                "  /** A form reset brings {model} back to what it started as. */\n  formResetCallback() {{\n    if (this.#reset === undefined || Object.is(this.#props.{model}, this.#reset)) return;\n    this.{model} = structuredClone(this.#reset);\n    this.#fire({}, this.#props.{model}); // a reset is the control's own change\n  }}\n",
                json(&event)
            ));
        }
    }

    // Slots, and the helpers.
    let sections = Sections::parse(HELPERS);
    let mut wanted_sections: BTreeSet<String> =
        uses.iter().map(|name| (*name).to_owned()).collect();
    if uses_slots {
        wanted_sections.insert("class:slots".to_owned());
    }
    let ordered = sections.resolve(&wanted_sections);
    let fill = |text: &str, names: &mut Names| -> String {
        let text = text
            .replace("@@styled", if styled { "true" } else { "false" })
            .replace(
                "@@slots",
                &format!(
                    "[{}]",
                    slots
                        .iter()
                        .map(|slot| json(slot))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        substitute(&text, names)
    };
    for section in ordered.iter().filter(|name| name.starts_with("class:")) {
        out.push('\n');
        out.push_str(&fill(&sections.text(section), &mut names));
    }
    out.push_str("}\n");
    let helpers: Vec<String> = ordered
        .iter()
        .filter(|name| !name.starts_with("class:"))
        .map(|name| fill(&sections.text(name), &mut names))
        .collect();
    if !helpers.is_empty() {
        out.push_str("\n// ---- helpers\n");
        for helper in helpers {
            out.push('\n');
            out.push_str(helper.trim_end());
            out.push('\n');
        }
    }
    out.push_str(&format!(
        "\n// Register the element (a server import, with no customElements, defines nothing).\nif (globalThis.customElements && !customElements.get(tag)) customElements.define(tag, {class_name});\nexport default {class_name};\n"
    ));
    // On a server, `class … extends HTMLElement` needs something to extend.
    let out = out.replacen(
        "\nexport const tag",
        "\nconst HTMLElement = globalThis.HTMLElement ?? class {}; // on a server, nothing to extend\nexport const tag",
        1,
    );
    Ok(out)
}

/// zb-await, spreads and outlets: the runtime's.
fn refuse_unsupported(nodes: &[Node]) -> Result<(), Diagnostic> {
    for node in nodes {
        match node {
            Node::Await { span, .. } => {
                return Err(
                    Diagnostic::new(*span, "--emit element doesn't support zb-await")
                        .with_help(HINT),
                )
            }
            Node::Element(element) => {
                if element.name == "zb-outlet" {
                    return Err(Diagnostic::new(
                        element.span,
                        "--emit element doesn't support <zb-outlet>: outlets are filled by @zubra/runtime's adapters",
                    )
                    .with_help(HINT));
                }
                for attribute in &element.attributes {
                    if attribute.name == crate::parser::SPREAD {
                        return Err(Diagnostic::new(
                            attribute.span,
                            "--emit element doesn't support `{...spread}` in the template",
                        )
                        .with_help(HINT));
                    }
                }
                refuse_unsupported(&element.children)?;
            }
            Node::If {
                consequent,
                alternate,
                ..
            } => {
                refuse_unsupported(consequent)?;
                refuse_unsupported(alternate)?;
            }
            Node::Each { children, .. } | Node::Else { children, .. } => {
                refuse_unsupported(children)?
            }
            Node::Slot { fallback, .. } => refuse_unsupported(fallback)?,
            Node::Settled { branch, .. } => refuse_unsupported(&branch.children)?,
            Node::Text(_) => {}
        }
    }
    Ok(())
}

// ---- names

/// The names the module uses: each generated one is new (not one the script or template uses).
struct Names {
    taken: HashSet<String>,
    /// Module-level helpers, by their name in the helper file.
    modules: HashMap<String, String>,
}

impl Names {
    fn new(taken: HashSet<String>) -> Self {
        Self {
            taken,
            modules: HashMap::new(),
        }
    }

    /// A new local name like `hint`: `hint`, else `hint2`, `hint3`…
    fn local(&mut self, hint: &str) -> String {
        let base = identifier(hint);
        let mut name = base.clone();
        let mut n = 2;
        while self.taken.contains(&name) {
            name = format!("{base}{n}");
            n += 1;
        }
        self.taken.insert(name.clone());
        name
    }

    /// A module-level helper's name: its own, or `$name` when the component uses that name.
    fn module(&mut self, helper: &str) -> String {
        if let Some(name) = self.modules.get(helper) {
            return name.clone();
        }
        let name = if self.taken.contains(helper) {
            format!("${helper}")
        } else {
            helper.to_owned()
        };
        self.taken.insert(name.clone());
        self.modules.insert(helper.to_owned(), name.clone());
        name
    }
}

/// `quantity-stepper` → `QuantityStepper`.
fn names_class(tag: &str, names: &mut Names) -> String {
    let mut out = String::new();
    for word in tag.split(|c: char| !c.is_ascii_alphanumeric()) {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            out.extend(chars);
        }
    }
    if !out.starts_with(|c: char| c.is_ascii_alphabetic()) {
        out.insert_str(0, "Element");
    }
    names.local(&out)
}

/// A JavaScript identifier from a hint (`aria-label` → `ariaLabel`).
fn identifier(hint: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in hint.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '$' {
            if upper && !out.is_empty() {
                out.push(c.to_ascii_uppercase());
            } else {
                out.push(c);
            }
            upper = false;
        } else {
            upper = true;
        }
    }
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, 'n');
    }
    out
}

/// Every identifier-like word in the script (declared or used): generated names avoid them.
fn script_identifiers(body: &str) -> HashSet<String> {
    let mut words = HashSet::new();
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, body, oxc_span::SourceType::mjs()).parse();
    let semantic = oxc_semantic::SemanticBuilder::new()
        .build(&parsed.program)
        .semantic;
    let scoping = semantic.scoping();
    for symbol in scoping.symbol_ids() {
        words.insert(scoping.symbol_name(symbol).to_owned());
    }
    for (name, _) in scoping.root_unresolved_references() {
        words.insert(name.to_string());
    }
    words
}

fn collect_template_names(nodes: &[Node], taken: &mut HashSet<String>) {
    ast::for_each_expression(nodes, &mut |expression, _| {
        expression.for_each_identifier(&mut |name| {
            taken.insert(name.to_owned());
        });
        if let Expression::Runtime { source, .. } = expression {
            taken.extend(script_identifiers(&format!("({source}\n)")));
        }
    });
    for node in nodes {
        match node {
            Node::Each {
                item,
                index,
                lets,
                children,
                ..
            } => {
                if ast::is_pattern(item) {
                    for (name, _) in ast::bindings(item).unwrap_or_default() {
                        taken.insert(name);
                    }
                } else {
                    taken.insert(item.clone());
                }
                if let Some(index) = index {
                    taken.insert(index.clone());
                }
                for binding in lets {
                    taken.insert(binding.name.clone());
                }
                collect_template_names(children, taken);
            }
            Node::Element(element) => collect_template_names(&element.children, taken),
            Node::If {
                consequent,
                alternate,
                ..
            } => {
                collect_template_names(consequent, taken);
                collect_template_names(alternate, taken);
            }
            Node::Slot { fallback, .. } => collect_template_names(fallback, taken),
            _ => {}
        }
    }
}

// ---- the helper file

struct Sections {
    order: Vec<String>,
    deps: HashMap<String, Vec<String>>,
    texts: HashMap<String, String>,
}

impl Sections {
    fn parse(file: &str) -> Self {
        let mut sections = Self {
            order: Vec::new(),
            deps: HashMap::new(),
            texts: HashMap::new(),
        };
        let mut current: Option<String> = None;
        for line in file.lines() {
            if let Some(header) = line.strip_prefix("//@@ ") {
                // `name: deps` (a name may itself have a colon: `class:slots`).
                let (name, deps) = header
                    .split_once(": ")
                    .unwrap_or((header.trim_end().trim_end_matches(':'), ""));
                let name = name.trim().to_owned();
                sections.order.push(name.clone());
                sections.deps.insert(
                    name.clone(),
                    deps.split_whitespace().map(str::to_owned).collect(),
                );
                sections.texts.insert(name.clone(), String::new());
                current = Some(name);
                continue;
            }
            if let Some(name) = &current {
                let text = sections.texts.get_mut(name).expect("section");
                text.push_str(line);
                text.push('\n');
            }
        }
        sections
    }

    /// `wanted` with what they need, in the file's order.
    fn resolve(&self, wanted: &BTreeSet<String>) -> Vec<String> {
        let mut all: HashSet<String> = HashSet::new();
        let mut stack: Vec<String> = wanted.iter().cloned().collect();
        while let Some(name) = stack.pop() {
            if !self.texts.contains_key(&name) {
                panic!("no helper section `{name}`");
            }
            if all.insert(name.clone()) {
                stack.extend(self.deps[&name].iter().cloned());
            }
        }
        self.order
            .iter()
            .filter(|name| all.contains(*name))
            .cloned()
            .collect()
    }

    fn text(&self, name: &str) -> String {
        self.texts[name].trim_end().to_owned() + "\n"
    }
}

/// `@name` in helper text → the helper's name in this module.
fn substitute(text: &str, names: &mut Names) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('@') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        if end == 0 {
            out.push('@');
            rest = after;
            continue;
        }
        out.push_str(&names.module(&after[..end]));
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

// ---- the template

/// One template (the element's, a list row's, a branch's): its markup, the setup that finds its
/// nodes, and the updates that keep them current.
struct Block {
    root: String,
    /// The indentation of this block's lines (its updates are one level deeper).
    indent: String,
    markup: String,
    svg: bool,
    /// Statements run once: node lookups, listeners, refs.
    lines: Vec<String>,
    /// Expressions, each an update function.
    updates: Vec<String>,
    /// Names in scope (a row's item and index, `let:` names), with the JavaScript that reads them.
    scopes: Vec<(String, String)>,
    frames: Vec<Frame>,
}

/// An element being written (or the block's root), for finding its children.
struct Frame {
    var: Option<String>,
    /// From the parent's expression to this node (`.children[2]`).
    access: String,
    hint: String,
    /// Element children so far, and child nodes (as the HTML parser makes them).
    elements: usize,
    nodes: usize,
    last_text: bool,
    /// `<pre>`, `<textarea>`, `<listing>`: the parser drops a newline right after the start tag.
    drops_newline: bool,
}

impl Block {
    fn new(root: &str, indent: &str, svg: bool, scopes: Vec<(String, String)>) -> Self {
        Self {
            root: root.to_owned(),
            indent: indent.to_owned(),
            markup: String::new(),
            svg,
            lines: Vec::new(),
            updates: Vec::new(),
            scopes,
            frames: vec![Frame {
                var: Some(root.to_owned()),
                access: String::new(),
                hint: root.to_owned(),
                elements: 0,
                nodes: 0,
                last_text: false,
                drops_newline: false,
            }],
        }
    }

    fn top(&mut self) -> &mut Frame {
        self.frames.last_mut().expect("a frame")
    }

    /// The expression for frame `i`'s node.
    fn expr(&self, i: usize) -> String {
        match &self.frames[i].var {
            Some(var) => var.clone(),
            None => format!("{}{}", self.expr(i - 1), self.frames[i].access),
        }
    }

    /// Frame `i`'s node as a named constant.
    fn var(&mut self, i: usize, names: &mut Names) -> String {
        if let Some(var) = &self.frames[i].var {
            return var.clone();
        }
        let expr = self.expr(i);
        let name = names.local(&self.frames[i].hint.clone());
        self.line(format!("const {name} = {expr};"));
        self.frames[i].var = Some(name.clone());
        name
    }

    /// The node being written's own variable (the innermost element).
    fn current(&mut self, names: &mut Names) -> String {
        let i = self.frames.len() - 1;
        self.var(i, names)
    }

    /// A statement, at this block's indentation.
    fn line(&mut self, text: String) {
        self.lines.push(format!("{}{text}", self.indent));
    }

    /// Where an update's continuation lines go.
    fn update_indent(&self) -> String {
        format!("{}  ", self.indent)
    }

    /// Text in the markup at this position.
    fn text(&mut self, text: &str) {
        self.markup.push_str(text);
        let frame = self.top();
        let mut empty = text.is_empty();
        if frame.drops_newline && frame.nodes == 0 && !frame.last_text {
            empty = text == "\n" || text == "\r\n";
        }
        if !empty && !frame.last_text {
            frame.nodes += 1;
            frame.last_text = true;
        }
    }

    /// A comment marker in the markup: the expression that finds it.
    fn marker(&mut self, data: &str) -> String {
        self.markup.push_str(&format!("<!--{data}-->"));
        let parent = self.frames.len() - 1;
        let index = self.top().nodes;
        let frame = self.top();
        frame.nodes += 1;
        frame.last_text = false;
        format!("{}.childNodes[{index}]", self.expr(parent))
    }
}

struct Emitter<'a, 'n> {
    interface: &'a Interface,
    children: &'a [(String, ChildInfo)],
    state: &'a [String],
    derived: &'a [String],
    signals: &'a [String],
    /// The script's functions, classes and imports: stable values, passed to listeners as they are.
    functions: &'a [String],
    receiver: String,
    lowering: Lowering<'a>,
    names: &'n mut Names,
    /// Helper sections the module needs.
    uses: BTreeSet<&'static str>,
    /// Class members the module needs (effects, mounted…).
    members: BTreeSet<&'static str>,
    slots: bool,
}

impl Emitter<'_, '_> {
    /// A helper's name, and the note that the module needs it.
    fn helper(&mut self, section: &str) -> String {
        let section: &'static str = match section {
            "bind" => "bind",
            "attribute" => "attribute",
            "isSafeUrl" => "isSafeUrl",
            "isSafeSrcset" => "isSafeSrcset",
            "urlAttribute" => "urlAttribute",
            "setValue" => "setValue",
            "setStyle" => "setStyle",
            "swapClasses" => "swapClasses",
            "setProperty" => "setProperty",
            "insert" => "insert",
            "list" => "list",
            "when" => "when",
            "leave" => "leave",
            "glide" => "glide",
            "clone" => "clone",
            "cloneSvg" => "cloneSvg",
            "fromJson" => "fromJson",
            "reads" => "reads",
            "createState" => "createState",
            "createComputed" => "createComputed",
            "live" => "live",
            "ids" => "ids",
            "apple" => "apple",
            "slotted" => "slotted",
            other => panic!("no helper `{other}`"),
        };
        self.uses.insert(section);
        self.names.module(section)
    }

    /// `clone(\`markup\`)` for a block.
    fn clone_call(&mut self, block: &Block) -> String {
        let clone = self.helper(if block.svg { "cloneSvg" } else { "clone" });
        format!("{clone}({})", template_literal(&block.markup))
    }

    /// A template expression as JavaScript: props as `element.name`, state as `name.value`.
    fn js(&self, block: &Block, expression: &Expression) -> String {
        let runtime = expression.is_runtime();
        let rewritten = match expression {
            Expression::Runtime { source, .. }
                if !(self.state.is_empty()
                    && self.derived.is_empty()
                    && self.signals.is_empty()) =>
            {
                crate::reactive::rewrite_template_expression_with(
                    source,
                    self.state,
                    self.derived,
                    self.signals,
                    self.lowering,
                )
                .ok()
                .flatten()
                .and_then(|text| {
                    crate::runtime_expression::parse(&text)
                        .ok()
                        .map(|names| Expression::Runtime {
                            source: text,
                            names,
                        })
                })
            }
            _ => None,
        };
        let expression = rewritten.as_ref().unwrap_or(expression);
        // A two-way prop the expression assigns (`value++`): through `#value`, which fires `valuechange`.
        let written = expression.written_names();
        let js = expression.to_js_with(&|name| {
            if let Some((_, js)) = block.scopes.iter().rev().find(|(scope, _)| scope == name) {
                js.clone()
            } else if self.interface.props.iter().any(|prop| prop.name == name) {
                let private = self
                    .interface
                    .props
                    .iter()
                    .any(|prop| prop.name == name && prop.model)
                    && written.contains(&name);
                format!("{}.{}{name}", self.receiver, if private { "#" } else { "" })
            } else if !runtime
                && (self.state.iter().any(|state| state == name)
                    || self.derived.iter().any(|derived| derived == name)
                    || self.signals.iter().any(|signal| signal == name))
            {
                format!("{name}.value")
            } else {
                name.to_owned()
            }
        });
        unparen(&js)
    }

    /// Text parts as one string expression (a template literal when it mixes text and values).
    fn text_js(&self, block: &Block, parts: &[Part]) -> String {
        let pieces: Vec<Result<String, String>> = parts
            .iter()
            .filter_map(|part| match part {
                Part::Literal(text) if text.is_empty() => None,
                Part::Literal(text) => {
                    Some(Ok(html_escape::decode_html_entities(text).into_owned()))
                }
                Part::Expression { expression, .. } => Some(Err(self.js(block, expression))),
            })
            .collect();
        match pieces.as_slice() {
            [] => "\"\"".to_owned(),
            [Ok(text)] => json(text),
            [Err(js)] => nullish(js),
            _ => {
                let mut out = String::from("`");
                for piece in &pieces {
                    match piece {
                        Ok(text) => out.push_str(&escape_template(text)),
                        Err(js) => out.push_str(&format!("${{{}}}", nullish(js))),
                    }
                }
                out.push('`');
                out
            }
        }
    }

    /// `bind(read, write)`.
    fn bind(&mut self, read: &str, write: &str) -> String {
        let bind = self.helper("bind");
        format!("{bind}(() => {read}, (value) => {write})")
    }

    fn nodes(
        &mut self,
        block: &mut Block,
        nodes: &[Node],
        block_top: bool,
    ) -> Result<(), Diagnostic> {
        for node in nodes {
            match node {
                Node::Text(parts) => {
                    let dynamic = parts
                        .iter()
                        .any(|part| matches!(part, Part::Expression { .. }));
                    if !dynamic {
                        let mut text = String::new();
                        for part in parts {
                            if let Part::Literal(literal) = part {
                                text.push_str(literal);
                            }
                        }
                        block.text(&text);
                    } else if needs_text_anchor(nodes, node, block_top) {
                        // Text beside other nodes: a marker in the markup, swapped for a text node.
                        let marker = block.marker("text");
                        let hint = text_hint(parts);
                        let name = self.names.local(&hint);
                        block.line(format!("const {name} = new Text();"));
                        block.line(format!("{marker}.replaceWith({name});"));
                        let read = self.text_js(block, parts);
                        let write = format!("({name}.data = value)");
                        let update = self.bind(&read, &write);
                        block.updates.push(update);
                    } else {
                        // The element's only child: its textContent.
                        let element = block.current(self.names);
                        let read = self.text_js(block, parts);
                        let update = self.bind(&read, &format!("({element}.textContent = value)"));
                        block.updates.push(update);
                    }
                }
                Node::Element(element) if emit_js::is_global_listener(&element.name) => {
                    let lower = element.name.to_ascii_lowercase();
                    let target = lower.strip_prefix("zb-").unwrap_or(&lower).to_owned();
                    for attribute in &element.attributes {
                        if let AttributeValue::Expression(expression, _) = &attribute.value {
                            let lower = attribute.name.to_ascii_lowercase();
                            self.members.insert("mounted");
                            let (event, listener, options) =
                                self.listener(block, &lower, expression, &target, 1)?;
                            let options =
                                options.map_or_else(String::new, |options| format!(", {options}"));
                            let pad = &block.indent;
                            block.line(format!(
                                "// <zb-{target}>: listening while the element is on the page.\n{pad}this.#mounted.push(() => {{\n{pad}  const listener = {listener};\n{pad}  {target}.addEventListener({event}{options});\n{pad}  return () => {target}.removeEventListener({event}{options});\n{pad}}});",
                                event = format!("{}, listener", json(&event)),
                            ));
                        }
                    }
                }
                Node::Element(element) => self.element(block, element)?,
                Node::If {
                    test,
                    consequent,
                    alternate,
                    animate,
                    ..
                } => {
                    let start = block.marker("if");
                    let end = block.marker("/if");
                    let yes = self.branch(block, consequent)?;
                    let no = if alternate.is_empty() {
                        "null".to_owned()
                    } else {
                        self.branch(block, alternate)?
                    };
                    let when = self.helper("when");
                    let source = one_line(&test.to_js_with(&|name| name.to_owned()));
                    let test = self.js(block, test);
                    let leaving = if self.slots {
                        ", (start, end) => this.#parkSlotsIn(start, end)"
                    } else if *animate {
                        ", null"
                    } else {
                        ""
                    };
                    // `animate`: the branch going away leaves (the `leave` helper) first.
                    let (exit, written) = if *animate {
                        (format!(", {}", self.helper("leave")), " animate")
                    } else {
                        (String::new(), "")
                    };
                    block.updates.push(format!(
                        "// <zb-if test={{{source}}}{written}>\n{}{when}({start}, {end}, () => {test}, [{yes}, {no}]{leaving}{exit})",
                        block.update_indent()
                    ));
                }
                Node::Each {
                    items,
                    item,
                    index,
                    key,
                    lets,
                    children,
                    animate,
                    ..
                } => {
                    let start = block.marker("each");
                    let end = block.marker("/each");
                    let index_name = match index {
                        Some(index) => index.clone(),
                        None => self.names.local("index"),
                    };
                    let row = self.row(block, item, &index_name, lets, children)?;
                    let source = format!(
                        "items={{{}}} as=\"{item}\"{}{}",
                        one_line(&items.to_js_with(&|name| name.to_owned())),
                        key.as_ref().map_or_else(String::new, |(key, _)| format!(
                            " key={{{}}}",
                            one_line(&key.to_js_with(&|name| name.to_owned()))
                        )),
                        if *animate { " animate" } else { "" }
                    );
                    let items = self.js(block, items);
                    let key = match key {
                        Some((key, _)) => {
                            let (params, scope) = self.row_scope(block, item, &index_name, lets);
                            let keyed = Block::new(
                                "",
                                "",
                                false,
                                block.scopes.iter().cloned().chain(scope).collect(),
                            );
                            format!("({params}) => {}", self.js(&keyed, key))
                        }
                        None => format!("(_, {index_name}) => {index_name}"),
                    };
                    let list = self.helper("list");
                    // `animate`: removed rows leave, and the rest glide to their new places.
                    let motion = if *animate {
                        format!(", {}, {}", self.helper("leave"), self.helper("glide"))
                    } else {
                        String::new()
                    };
                    block.updates.push(format!(
                        "// <zb-each {source}>\n{}{list}({start}, {end}, () => {items}, {key}, {row}{motion})",
                        block.update_indent()
                    ));
                }
                Node::Slot { name, fallback, .. } => {
                    let data = name.replace("--", "-");
                    let start = block.marker(&format!("slot {data}"));
                    let end = block.marker("/slot");
                    let fallback = if fallback.is_empty() {
                        "null".to_owned()
                    } else {
                        self.branch(block, fallback)?
                    };
                    block.updates.push(format!(
                        "// <zb-slot{}>\n{}this.#slotRegion({start}, {end}, {}, {fallback})",
                        if name == "default" {
                            String::new()
                        } else {
                            format!(" name=\"{name}\"")
                        },
                        block.update_indent(),
                        json(name)
                    ));
                }
                Node::Else { span, .. } => {
                    return Err(Diagnostic::new(
                        *span,
                        "zb-else is only valid as a direct child of zb-if",
                    ));
                }
                Node::Await { span, .. } => {
                    return Err(
                        Diagnostic::new(*span, "--emit element doesn't support zb-await")
                            .with_help(HINT),
                    );
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

    /// A branch (zb-if, a slot's fallback): `() => { … return { nodes, update } }`.
    fn branch(&mut self, parent: &Block, nodes: &[Node]) -> Result<String, Diagnostic> {
        let root = self.names.local("branch");
        let mut block = Block::new(
            &root,
            &format!("{}    ", parent.indent),
            parent.svg,
            parent.scopes.clone(),
        );
        self.nodes(&mut block, nodes, true)?;
        Ok(self.factory(&block, "", "", "", "", parent))
    }

    /// The parameters of a row's functions (`tag, index`), and the names its scope adds.
    fn row_scope(
        &self,
        parent: &Block,
        item: &str,
        index: &str,
        lets: &[ast::Let],
    ) -> (String, Vec<(String, String)>) {
        let mut scope: Vec<(String, String)> = Vec::new();
        if ast::is_pattern(item) {
            for (name, _) in ast::bindings(item).unwrap_or_default() {
                scope.push((name.clone(), name));
            }
        } else {
            scope.push((item.to_owned(), item.to_owned()));
        }
        scope.push((index.to_owned(), index.to_owned()));
        // `let:` names read their expression, written out where they're used.
        let mut block = Block::new(
            "",
            "",
            false,
            parent.scopes.iter().cloned().chain(scope.clone()).collect(),
        );
        for binding in lets {
            let js = format!("({})", self.js(&block, &binding.value));
            block.scopes.push((binding.name.clone(), js.clone()));
            scope.push((binding.name.clone(), js));
        }
        (format!("{item}, {index}"), scope)
    }

    /// A list row: `(tag, index) => { … return { nodes, update(next, at) } }`.
    fn row(
        &mut self,
        parent: &Block,
        item: &str,
        index: &str,
        lets: &[ast::Let],
        children: &[Node],
    ) -> Result<String, Diagnostic> {
        let pattern = ast::is_pattern(item);
        let item_name = if pattern {
            self.names.local("item")
        } else {
            item.to_owned()
        };
        let (_, scope) = self.row_scope(parent, item, index, lets);
        let root = self.names.local("row");
        let scopes = parent.scopes.iter().cloned().chain(scope).collect();
        let mut block = Block::new(&root, &format!("{}    ", parent.indent), parent.svg, scopes);
        self.nodes(&mut block, children, true)?;
        let next = self.names.local("next");
        let at = self.names.local("at");
        // The row keeps its nodes when its item changes (same key): its names take the new values.
        let (prelude, assign) = if pattern {
            (
                format!("let {item} = {item_name};"),
                format!("({item} = {next}); {index} = {at};"),
            )
        } else {
            (
                String::new(),
                format!("{item_name} = {next}; {index} = {at};"),
            )
        };
        Ok(self.factory(
            &block,
            &format!("{item_name}, {index}"),
            &prelude,
            &format!("{next}, {at}"),
            &assign,
            parent,
        ))
    }

    /// A block as the function that makes it: its nodes, and its update.
    fn factory(
        &mut self,
        block: &Block,
        params: &str,
        prelude: &str,
        update_params: &str,
        assign: &str,
        parent: &Block,
    ) -> String {
        let close = parent.update_indent();
        let inner = &block.indent;
        let mut out = format!("({params}) => {{\n");
        if !prelude.is_empty() {
            out.push_str(&format!("{inner}{prelude}\n"));
        }
        let clone = self.clone_call(block);
        out.push_str(&format!("{inner}const {} = {clone};\n", block.root));
        for line in &block.lines {
            out.push_str(line);
            out.push('\n');
        }
        let run = if block.updates.is_empty() {
            String::new()
        } else {
            let updates = self.names.local("updates");
            out.push_str(&format!("{inner}const {updates} = [\n"));
            for update in &block.updates {
                out.push_str(&format!("{inner}  {update},\n"));
            }
            out.push_str(&format!("{inner}];\n"));
            format!(" for (const update of {updates}) update();")
        };
        let assign = if assign.is_empty() {
            String::new()
        } else {
            format!(" {assign}")
        };
        out.push_str(&format!(
            "{inner}return {{ nodes: {}, update({update_params}) {{{assign}{run} }} }};\n{close}}}",
            block.root
        ));
        out
    }

    fn element(&mut self, block: &mut Block, element: &ast::Element) -> Result<(), Diagnostic> {
        let child = self
            .children
            .iter()
            .find(|(tag, _)| tag.eq_ignore_ascii_case(&element.name))
            .map(|(_, info)| info);
        if let Some(info) = child {
            emit_js::check_child(element, info)?;
        }
        let custom = element.name.contains('-');
        let lower_name = element.name.to_ascii_lowercase();
        // This element's place in its parent.
        let index = {
            let frame = block.top();
            let index = frame.elements;
            frame.elements += 1;
            frame.nodes += 1;
            frame.last_text = false;
            index
        };
        let svg = block.svg || lower_name == "svg";
        block.frames.push(Frame {
            var: None,
            access: format!(".children[{index}]"),
            hint: element_hint(element),
            elements: 0,
            nodes: 0,
            last_text: false,
            drops_newline: matches!(lower_name.as_str(), "pre" | "textarea" | "listing"),
        });
        let was_svg = block.svg;
        block.markup.push('<');
        block.markup.push_str(&element.name);
        let has_toggles = element
            .attributes
            .iter()
            .any(|other| other.name.to_ascii_lowercase().starts_with("class:"));
        for attribute in &element.attributes {
            let lower = attribute.name.to_ascii_lowercase();
            let prop = validate::camel(&lower);
            // A prop of a known child component: always a property.
            if child.is_some_and(|child| child.props.contains(&prop)) {
                let value = match &attribute.value {
                    AttributeValue::None => "true".to_owned(),
                    AttributeValue::Text(parts) => self.text_js(block, parts),
                    AttributeValue::Expression(expression, _) => self.js(block, expression),
                };
                let node = block.current(self.names);
                let update = self.bind(&value, &format!("({node}.{prop} = value)"));
                block.updates.push(update);
                continue;
            }
            match &attribute.value {
                AttributeValue::None => {
                    block.markup.push(' ');
                    block.markup.push_str(&attribute.name);
                }
                AttributeValue::Text(parts)
                    if parts.iter().all(|part| matches!(part, Part::Literal(_))) =>
                {
                    block.markup.push(' ');
                    block.markup.push_str(&attribute.name);
                    block.markup.push_str("=\"");
                    for part in parts {
                        if let Part::Literal(text) = part {
                            block.markup.push_str(text);
                        }
                    }
                    block.markup.push('"');
                }
                AttributeValue::Expression(expression, _) if is_event_attribute(&lower) => {
                    let node = block.current(self.names);
                    let (event, listener, options) =
                        self.listener(block, &lower, expression, &node, 0)?;
                    let options =
                        options.map_or_else(String::new, |options| format!(", {options}"));
                    block.line(format!(
                        "{node}.addEventListener({}, {listener}{options});",
                        json(&event)
                    ));
                }
                AttributeValue::Expression(expression, _) if lower.starts_with("class:") => {
                    let node = block.current(self.names);
                    let read = self.js(block, expression);
                    let update = self.bind(
                        &read,
                        &format!(
                            "{node}.classList.toggle({}, Boolean(value))",
                            json(&attribute.name[6..])
                        ),
                    );
                    block.updates.push(update);
                }
                AttributeValue::Expression(expression, _) if lower.starts_with("style:") => {
                    let node = block.current(self.names);
                    let read = self.js(block, expression);
                    let set_style = self.helper("setStyle");
                    let update = self.bind(
                        &read,
                        &format!("{set_style}({node}, {}, value)", json(&attribute.name[6..])),
                    );
                    block.updates.push(update);
                }
                AttributeValue::Expression(expression, _) if lower == "ref" => {
                    let node = block.current(self.names);
                    let js = self.js(block, expression);
                    block.line(ref_line(&js, &node));
                }
                value if lower == "class" && has_toggles => {
                    let node = block.current(self.names);
                    let read = match value {
                        AttributeValue::Text(parts) => self.text_js(block, parts),
                        AttributeValue::Expression(expression, _) => self.js(block, expression),
                        AttributeValue::None => unreachable!("handled above"),
                    };
                    let swap = self.helper("swapClasses");
                    let bind = self.helper("bind");
                    block.updates.push(format!(
                        "{bind}(() => {read}, (value, previous) => {swap}({node}, previous, value))"
                    ));
                }
                value => {
                    let node = block.current(self.names);
                    let (read, string) = match value {
                        AttributeValue::Text(parts) => (self.text_js(block, parts), true),
                        AttributeValue::Expression(expression, _) => {
                            (self.js(block, expression), false)
                        }
                        AttributeValue::None => unreachable!("handled above"),
                    };
                    let name = json(&attribute.name);
                    let write = if BOOLEAN_ATTRIBUTES.contains(&lower.as_str()) {
                        format!("{node}.toggleAttribute({name}, Boolean(value))")
                    } else if URL_ATTRIBUTES.contains(&lower.as_str()) || lower == "srcset" {
                        let check = self.helper(if lower == "srcset" {
                            "isSafeSrcset"
                        } else {
                            "isSafeUrl"
                        });
                        let url = self.helper("urlAttribute");
                        format!("{url}({node}, {name}, value, {check})")
                    } else if custom && child.is_none() && !string {
                        let set = self.helper("setProperty");
                        format!("{set}({node}, {}, {name}, value)", json(&prop))
                    } else if lower == "value" && VALUE_PROPERTY.contains(&lower_name.as_str()) {
                        let set = self.helper("setValue");
                        format!("{set}({node}, value)")
                    } else if string {
                        format!("{node}.setAttribute({name}, value)")
                    } else {
                        let attribute_helper = self.helper("attribute");
                        format!("{attribute_helper}({node}, {name}, value)")
                    };
                    let update = self.bind(&read, &write);
                    block.updates.push(update);
                }
            }
        }
        block.markup.push('>');
        if emit_js::VOID_ELEMENTS.contains(&lower_name.as_str()) {
            block.frames.pop();
            return Ok(());
        }
        block.svg = svg && lower_name != "foreignobject";
        self.nodes(block, &element.children, false)?;
        block.svg = was_svg;
        block.markup.push_str("</");
        block.markup.push_str(&element.name);
        block.markup.push('>');
        block.frames.pop();
        Ok(())
    }

    /// An event attribute: (event name, listener, options).
    fn listener(
        &mut self,
        block: &Block,
        lower: &str,
        expression: &Expression,
        node: &str,
        depth: usize,
    ) -> Result<(String, String, Option<String>), Diagnostic> {
        let (event, modifiers) = crate::parser::event_parts(lower).unwrap_or_default();
        let handler = self.js(block, expression);
        let stable = is_function_literal(&handler)
            || matches!(expression, Expression::Identifier(name)
                if self.functions.contains(name)
                    && !block.scopes.iter().any(|(scope, _)| scope == name)
                    && !self.interface.props.iter().any(|prop| &prop.name == name)
                    && !self.state.contains(name) && !self.derived.contains(name) && !self.signals.contains(name));
        let options = (modifiers.once || modifiers.capture || modifiers.passive).then(|| {
            let mut flags = Vec::new();
            for (on, name) in [
                (modifiers.once, "once"),
                (modifiers.capture, "capture"),
                (modifiers.passive, "passive"),
            ] {
                if on {
                    flags.push(format!("{name}: true"));
                }
            }
            format!("{{ {} }}", flags.join(", "))
        });
        let mut checks: Vec<String> = Vec::new();
        if modifiers.self_only {
            checks.push(format!("if (event.target !== {node}) return; // .self"));
        }
        let apple = if modifiers.primary {
            Some(self.helper("apple"))
        } else {
            None
        };
        let ctrl = if modifiers.ctrl {
            Some("true".to_owned())
        } else {
            apple.as_ref().map(|apple| format!("!{apple}"))
        };
        let meta = if modifiers.meta {
            Some("true".to_owned())
        } else {
            apple.clone()
        };
        if !modifiers.keys.is_empty() {
            let keys: Vec<String> = modifiers
                .keys
                .iter()
                .map(|key| {
                    if key.chars().count() == 1 {
                        format!("event.key?.toLowerCase() === {}", json(key))
                    } else {
                        format!("event.key === {}", json(key))
                    }
                })
                .collect();
            checks.push(format!("if (!({})) return; // the key", keys.join(" || ")));
            // With a key, the modifier keys named must be held and the others not.
            let exact = |held: &str, wanted: Option<&String>| match wanted.map(String::as_str) {
                None => format!("event.{held}"),
                Some("true") => format!("!event.{held}"),
                Some(other) => format!("event.{held} !== ({other})"),
            };
            checks.push(format!(
                "if ({} || {} || {} || {}) return; // the modifier keys",
                exact(
                    "shiftKey",
                    modifiers.shift.then(|| "true".to_owned()).as_ref()
                ),
                exact("ctrlKey", ctrl.as_ref()),
                exact("altKey", modifiers.alt.then(|| "true".to_owned()).as_ref()),
                exact("metaKey", meta.as_ref())
            ));
        } else {
            let mut held = Vec::new();
            for (key, wanted) in [
                ("shiftKey", modifiers.shift.then(|| "true".to_owned())),
                ("ctrlKey", ctrl.clone()),
                ("altKey", modifiers.alt.then(|| "true".to_owned())),
                ("metaKey", meta.clone()),
            ] {
                match wanted.as_deref() {
                    None => {}
                    Some("true") => held.push(format!("!event.{key}")),
                    Some(other) => held.push(format!("(({other}) && !event.{key})")),
                }
            }
            if !held.is_empty() {
                checks.push(format!(
                    "if ({}) return; // the modifier keys",
                    held.join(" || ")
                ));
            }
        }
        if modifiers.prevent {
            checks.push("event.preventDefault();".to_owned());
        }
        if modifiers.stop {
            checks.push("event.stopPropagation();".to_owned());
        }
        let wrapped = !checks.is_empty() || modifiers.submit;
        if stable && !wrapped {
            return Ok((event, handler, options));
        }
        let call = if stable && !is_function_literal(&handler) {
            format!("{handler}(event);")
        } else {
            format!("const handler = {handler};\n  if (typeof handler === \"function\") handler.call({node}, event);")
        };
        let mut body = String::new();
        for check in &checks {
            body.push_str(&format!("  {check}\n"));
        }
        body.push_str(&format!("  {call}\n"));
        if modifiers.submit {
            body.push_str(&format!(
                "  ({node}.form ?? {node}.closest(\"form\"))?.requestSubmit(); // .submit\n"
            ));
        }
        let pad = format!("{}{}", block.indent, "  ".repeat(depth));
        let body = body
            .lines()
            .map(|line| format!("{pad}{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        Ok((event, format!("(event) => {{\n{body}\n{pad}}}"), options))
    }
}

/// `ref={name}` is `($el) => (name.value = $el)`: written out as `name.value = node;`.
fn ref_line(js: &str, node: &str) -> String {
    let trimmed = js.trim();
    if let Some(body) = trimmed.strip_prefix("($el) => ") {
        let body = body.trim();
        let body = body
            .strip_prefix('(')
            .and_then(|inner| inner.strip_suffix(')'))
            .filter(|inner| balanced(inner))
            .unwrap_or(body);
        if !body.contains("$el") || body.matches("$el").count() == 1 {
            return format!("{};", body.replace("$el", node));
        }
    }
    format!("({js})({node});")
}

fn balanced(text: &str) -> bool {
    let mut depth = 0i32;
    for c in text.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

fn is_function_literal(source: &str) -> bool {
    let allocator = oxc_allocator::Allocator::default();
    let parsed =
        oxc_parser::Parser::new(&allocator, source, oxc_span::SourceType::mjs()).parse_expression();
    matches!(
        parsed
            .as_ref()
            .map(|expression| expression.without_parentheses()),
        Ok(JsExpression::ArrowFunctionExpression(_) | JsExpression::FunctionExpression(_))
    )
}

/// A name for an element's variable: its id, its first class, or its tag.
fn element_hint(element: &ast::Element) -> String {
    let literal = |name: &str| {
        element
            .attributes
            .iter()
            .find(|attribute| attribute.name.eq_ignore_ascii_case(name))
            .and_then(|attribute| match &attribute.value {
                AttributeValue::Text(parts) => match parts.as_slice() {
                    [Part::Literal(text)] => Some(text.clone()),
                    _ => None,
                },
                _ => None,
            })
    };
    if let Some(class) =
        literal("class").and_then(|class| class.split_whitespace().next().map(str::to_owned))
    {
        if class.chars().any(|c| c.is_ascii_alphabetic()) {
            return class;
        }
    }
    if let Some(id) = literal("id") {
        if id.chars().any(|c| c.is_ascii_alphabetic()) {
            return id;
        }
    }
    element.name.to_ascii_lowercase()
}

/// A name for a text node: `{count}` → `countText`.
fn text_hint(parts: &[Part]) -> String {
    for part in parts {
        if let Part::Expression { expression, .. } = part {
            let mut first = None;
            expression.for_each_identifier(&mut |name| {
                first.get_or_insert_with(|| name.to_owned());
            });
            if let Some(name) = first {
                return format!("{name}Text");
            }
        }
    }
    "text".to_owned()
}

/// Source for a comment: on one line, and short.
fn one_line(source: &str) -> String {
    let text = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = unparen(&text);
    if text.chars().count() > 60 {
        format!("{}…", text.chars().take(59).collect::<String>())
    } else {
        text
    }
}

/// `(x)` → `x`, when the parentheses are a pair around the whole (an object literal keeps them).
fn unparen(js: &str) -> String {
    let trimmed = js.trim();
    if let Some(inner) = trimmed
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
        if balanced(inner) && !inner.trim_start().starts_with('{') {
            return inner.trim().to_owned();
        }
    }
    trimmed.to_owned()
}

/// `value ?? ""`, parenthesized when it needs to be.
fn nullish(js: &str) -> String {
    let simple = js
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.');
    if simple {
        format!("{js} ?? \"\"")
    } else {
        format!("({js}) ?? \"\"")
    }
}

fn escape_template(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${")
}

fn template_literal(text: &str) -> String {
    format!("`{}`", escape_template(text))
}

fn json(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize")
}

/// A prop name as an object key.
fn property_key(name: &str) -> String {
    if crate::parser::is_identifier(name) {
        name.to_owned()
    } else {
        json(name)
    }
}

/// The script, its shallowest lines at `pad` (as written in a `.zb` file, or at the margin, as
/// the JSX front end lowers it), except lines inside template literals, which are text.
fn indent_script(body: &str, pad: &str) -> String {
    // Byte ranges inside template literals: their lines are text, not code.
    let mut literal_ranges: Vec<(usize, usize)> = Vec::new();
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, body, oxc_span::SourceType::mjs()).parse();
    struct Literals<'r> {
        ranges: &'r mut Vec<(usize, usize)>,
    }
    impl<'a> oxc_ast_visit::Visit<'a> for Literals<'_> {
        fn visit_template_literal(&mut self, literal: &oxc_ast::ast::TemplateLiteral<'a>) {
            self.ranges
                .push((literal.span.start as usize, literal.span.end as usize));
            oxc_ast_visit::walk::walk_template_literal(self, literal);
        }
    }
    let mut visitor = Literals {
        ranges: &mut literal_ranges,
    };
    oxc_ast_visit::Visit::visit_program(&mut visitor, &parsed.program);
    let mut lines: Vec<(&str, bool)> = Vec::new();
    let mut offset = 0;
    for line in body.split('\n') {
        let inside = literal_ranges
            .iter()
            .any(|(start, end)| offset > *start && offset < *end);
        offset += line.len() + 1;
        lines.push((line, inside));
    }
    let shallowest = lines
        .iter()
        .filter(|(line, inside)| !inside && !line.trim().is_empty())
        .map(|(line, _)| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    let mut out = String::new();
    for (line, inside) in lines {
        if inside {
            out.push_str(line);
        } else if line.trim().is_empty() {
            // (where the imports were, and blank lines)
            if out.is_empty() {
                continue;
            }
        } else {
            out.push_str(pad);
            let lead = line.len() - line.trim_start().len();
            out.push_str(&line[lead.min(shallowest)..]);
        }
        out.push('\n');
    }
    // At most one blank line in a row.
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    out.trim_end().to_owned()
}

/// `import { a, b as c } from …` → [(a, a), (b, c)] (type-only names left out).
fn named_imports(text: &str) -> Vec<(String, String)> {
    let names = text
        .split_once('{')
        .and_then(|(_, rest)| rest.split_once('}'))
        .map_or("", |(names, _)| names);
    names
        .split(',')
        .filter_map(|name| {
            let mut words = name.split_whitespace().peekable();
            if words.peek() == Some(&"type") {
                return None;
            }
            let imported = words.next()?.to_owned();
            let local = match (words.next(), words.next()) {
                (Some("as"), Some(local)) => local.to_owned(),
                _ => imported.clone(),
            };
            Some((imported, local))
        })
        .collect()
}
