//! What tools need to know about a component, without running it:
//!
//! - a [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest)
//!   (`custom-elements.json`), the community format editors, Storybook and documentation tools
//!   read — tag, props as attributes and fields with types and defaults, slots, description;
//! - TypeScript declarations: the element class with typed properties, registered in
//!   `HTMLElementTagNameMap` so `document.querySelector("mnx-header")` is typed.
//!
//! Types come from prop defaults (`{ sample: "…" }` → `{ sample: string }`); a required prop
//! with no default is `unknown`. Both outputs come from the same analysis as the JavaScript
//! backend, so they can't drift from what the element actually accepts.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::{
    ast::ComponentAst,
    diagnostic::Diagnostic,
    events::EventInterface,
    validate::{self, PropInterface},
};

/// `mnx-header` → `MnxHeader`.
pub fn class_name(tag: &str) -> String {
    tag.split(['-', '.'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_ascii_uppercase().to_string() + chars.as_str()
            })
        })
        .collect()
}

/// A TypeScript type describing `value` (and values shaped like it).
pub fn ts_type(value: &Value) -> String {
    match value {
        Value::Null => "unknown".to_owned(),
        Value::Bool(_) => "boolean".to_owned(),
        Value::Number(_) => "number".to_owned(),
        Value::String(_) => "string".to_owned(),
        Value::Array(items) => {
            let mut seen = Vec::new();
            for item in items {
                let item_type = ts_type(item);
                if !seen.contains(&item_type) {
                    seen.push(item_type);
                }
            }
            match seen.as_slice() {
                [] => "unknown[]".to_owned(),
                // Element types are never unions here, so only multiple types need parentheses.
                [only] => format!("{only}[]"),
                _ => format!("({})[]", seen.join(" | ")),
            }
        }
        Value::Object(fields) => {
            if fields.is_empty() {
                return "Record<string, unknown>".to_owned();
            }
            let members: Vec<String> = fields
                .iter()
                .map(|(key, value)| format!("{}: {}", property_key(key), ts_type(value)))
                .collect();
            format!("{{ {} }}", members.join("; "))
        }
    }
}

pub fn property_key(key: &str) -> String {
    let identifier = key
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '$'
        });
    if identifier {
        key.to_owned()
    } else {
        serde_json::to_string(key).expect("strings serialize")
    }
}

pub(crate) fn prop_type(prop: &PropInterface) -> String {
    if let Some(declared) = &prop.declared {
        return declared.clone();
    }
    prop.default
        .as_ref()
        .map_or_else(|| "unknown".to_owned(), ts_type)
}

fn sorted_slots(component: &ComponentAst) -> Vec<String> {
    let mut names = HashSet::new();
    validate::collect_slots(&component.nodes, &mut names);
    let mut names: Vec<String> = names.into_iter().collect();
    // The default slot first, then named slots alphabetically.
    names.sort_by_key(|name| (name != "default", name.clone()));
    names
}

/// A Custom Elements Manifest with one module, `module_path`, holding this component.
/// The component as servers need it (`emit: "interface"`): its tag, whether it renders into a
/// shadow root and is a form control, and its props (attribute, type, default, two-way).
/// `@mnx/server` uses it to read props back from a framework's HTML.
pub fn server_interface(component: &ComponentAst) -> Result<String, Diagnostic> {
    let interface = validate::analyze(component)?;
    let props: Vec<Value> = interface
        .props
        .iter()
        .map(|prop| {
            json!({
                "name": prop.name,
                "attribute": prop.attribute,
                "type": prop_type(prop),
                "default": prop.default,
                "model": prop.model,
                "required": prop.required(),
            })
        })
        .collect();
    let events: Vec<&str> = interface
        .events
        .iter()
        .map(|event| event.name.as_str())
        .collect();
    Ok(serde_json::to_string_pretty(&json!({
        "tag": component.tag,
        "shadow": component.shadow,
        "form": component.form_associated,
        "props": props,
        "events": events,
    }))
    .expect("JSON serializes"))
}

pub fn manifest(component: &ComponentAst, module_path: &str) -> Result<String, Diagnostic> {
    let interface = validate::analyze(component)?;
    let class = class_name(&component.tag);
    let mut attributes = Vec::new();
    let mut members = Vec::new();
    for prop in &interface.props {
        let type_ = json!({ "text": prop_type(prop) });
        let default = prop.default.as_ref().map(Value::to_string);
        let mut attribute = Map::new();
        attribute.insert("name".into(), json!(prop.attribute));
        attribute.insert("fieldName".into(), json!(prop.name));
        attribute.insert("type".into(), type_.clone());
        if let Some(default) = &default {
            attribute.insert("default".into(), json!(default));
        }
        if matches!(prop.default, Some(Value::Array(_) | Value::Object(_))) {
            attribute.insert("description".into(), json!("JSON"));
        }
        attributes.push(Value::Object(attribute));

        let mut field = Map::new();
        field.insert("kind".into(), json!("field"));
        field.insert("name".into(), json!(prop.name));
        field.insert("type".into(), type_);
        if let Some(default) = default {
            field.insert("default".into(), json!(default));
        }
        field.insert("attribute".into(), json!(prop.attribute));
        members.push(Value::Object(field));
    }
    // The manifest names the default slot "".
    let slots: Vec<Value> = sorted_slots(component)
        .into_iter()
        .map(|name| json!({ "name": if name == "default" { String::new() } else { name } }))
        .collect();

    let mut declaration = Map::new();
    declaration.insert("kind".into(), json!("class"));
    declaration.insert("name".into(), json!(class));
    declaration.insert("tagName".into(), json!(component.tag));
    declaration.insert("customElement".into(), json!(true));
    if let Some(description) = &interface.description {
        declaration.insert("description".into(), json!(description));
    }
    declaration.insert(
        "superclass".into(),
        json!({ "name": "HTMLElement", "package": "global:" }),
    );
    declaration.insert("attributes".into(), Value::Array(attributes));
    declaration.insert("members".into(), Value::Array(members));
    if !interface.events.is_empty() {
        let events = interface
            .events
            .iter()
            .map(|event| {
                let mut entry = Map::new();
                entry.insert("name".into(), json!(event.name));
                entry.insert(
                    "type".into(),
                    json!({ "text": format!("CustomEvent<{}>", event.detail) }),
                );
                if let Some(description) = &event.description {
                    entry.insert("description".into(), json!(description));
                }
                Value::Object(entry)
            })
            .collect();
        declaration.insert("events".into(), Value::Array(events));
    }
    if !slots.is_empty() {
        declaration.insert("slots".into(), Value::Array(slots));
    }

    let reference = json!({ "name": class, "module": module_path });
    let manifest = json!({
        "schemaVersion": "2.1.0",
        "modules": [{
            "kind": "javascript-module",
            "path": module_path,
            "declarations": [Value::Object(declaration)],
            "exports": [
                { "kind": "js", "name": "default", "declaration": reference },
                { "kind": "custom-element-definition", "name": component.tag, "declaration": reference },
            ],
        }],
    });
    Ok(serde_json::to_string_pretty(&manifest).expect("JSON serializes") + "\n")
}

/// HTML custom data (the format VS Code and other editors read for completions in `.html`
/// files): the tag, its description, each prop as an attribute, and `on<event>` attributes.
pub fn html_data(component: &ComponentAst) -> Result<String, Diagnostic> {
    let interface = validate::analyze(component)?;
    let mut attributes = Vec::new();
    for prop in &interface.props {
        let mut description = format!("Type: `{}`.", prop_type(prop));
        match (&prop.default, prop.runtime_default.is_some()) {
            (Some(default), _) => description.push_str(&format!(" Default: `{default}`.")),
            (None, true) => description.push_str(" Default: computed by the component."),
            (None, false) => description.push_str(" Required."),
        }
        if matches!(prop.default, Some(Value::Array(_) | Value::Object(_))) {
            description.push_str(" JSON in HTML.");
        }
        let mut attribute = Map::new();
        attribute.insert("name".into(), json!(prop.attribute));
        attribute.insert("description".into(), json!(description));
        if matches!(prop.default, Some(Value::Bool(_))) {
            attribute.insert("valueSet".into(), json!("v"));
        }
        attributes.push(Value::Object(attribute));
    }
    for event in &interface.events {
        let description = event
            .description
            .clone()
            .unwrap_or_else(|| format!("The `{}` event.", event.name));
        attributes.push(json!({
            "name": format!("on{}", event.name),
            "description": format!("{description} `event.detail`: `{}`.", event.detail),
        }));
    }
    let mut tag = Map::new();
    tag.insert("name".into(), json!(component.tag));
    if let Some(description) = &interface.description {
        tag.insert("description".into(), json!(description));
    }
    tag.insert("attributes".into(), Value::Array(attributes));
    let data = json!({ "version": 1.1, "tags": [Value::Object(tag)] });
    Ok(serde_json::to_string_pretty(&data).expect("JSON serializes") + "\n")
}

/// TypeScript declarations for the module the JavaScript backend writes.
/// Which framework's component the module's default export is: the element class itself, or the
/// React or Vue wrapper the build plugin gives files of that framework.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Framework {
    None,
    React,
    Vue,
    /// The element itself, typed for Svelte templates (`svelte/elements`).
    Svelte,
    /// The element itself, typed for Solid's JSX (`prop:` / `on:`).
    Solid,
}

/// `<prop>` + `<prop>change` pairs: the component's two-way bindings (as the adapters find them).
fn models(interface: &validate::Interface) -> Vec<(&PropInterface, &EventInterface)> {
    interface
        .props
        .iter()
        .filter_map(|prop| {
            let name = format!("{}change", prop.name.to_ascii_lowercase());
            interface
                .events
                .iter()
                .find(|event| event.name == name)
                .map(|event| (prop, event))
        })
        .collect()
}

fn capitalized(name: &str) -> String {
    let mut chars = name.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_ascii_uppercase().to_string() + chars.as_str()
    })
}

pub fn declarations(
    component: &ComponentAst,
    source_name: &str,
    framework: Framework,
) -> Result<String, Diagnostic> {
    let interface = validate::analyze(component)?;
    let class = class_name(&component.tag);
    let mut out = format!("// Generated by mnx from {source_name}. Do not edit.\n\n");
    match framework {
        Framework::None => {}
        Framework::React => out.push_str("import type * as React from \"react\";\n\n"),
        Framework::Vue => out.push_str("import type { DefineComponent } from \"vue\";\n\n"),
        Framework::Svelte => {
            out.push_str("import type { HTMLAttributes } from \"svelte/elements\";\n\n")
        }
        Framework::Solid => out.push_str("import type { JSX } from \"solid-js\";\n\n"),
    }
    // A TypeScript script's own types, which the interface may mention.
    for import in &component.script.type_imports {
        out.push_str(import);
        out.push('\n');
    }
    for declaration in &component.script.type_declarations {
        out.push_str(declaration);
        out.push_str("\n\n");
    }
    if !component.script.type_imports.is_empty() && component.script.type_declarations.is_empty() {
        out.push('\n');
    }
    if let Some(description) = &interface.description {
        out.push_str("/**\n");
        for line in description.lines() {
            out.push_str(&format!(" * {line}\n").replace(" * \n", " *\n"));
        }
        out.push_str(" */\n");
    }
    out.push_str(&format!(
        "export declare class {class} extends HTMLElement {{\n"
    ));
    for prop in &interface.props {
        if let Some(default) = &prop.default {
            out.push_str(&format!(
                "  /** Attribute `{}`. Default: `{default}`. */\n",
                prop.attribute
            ));
        } else if prop.runtime_default.is_some() {
            out.push_str(&format!(
                "  /** Attribute `{}`. Default: computed by the component. */\n",
                prop.attribute
            ));
        } else {
            out.push_str(&format!(
                "  /** Attribute `{}`. Required. */\n",
                prop.attribute
            ));
        }
        out.push_str(&format!(
            "  {}: {};\n",
            property_key(&prop.name),
            prop_type(prop)
        ));
    }
    if component.form_associated {
        out.push_str("  /** The form this control belongs to, as for native controls. */\n");
        out.push_str("  readonly form: HTMLFormElement | null;\n");
        if !interface.props.iter().any(|prop| prop.name == "name") {
            out.push_str("  /** The `name` attribute: the key this control submits under. */\n  name: string | null;\n");
        }
        out.push_str("  readonly validity: ValidityState;\n  readonly validationMessage: string;\n  readonly willValidate: boolean;\n");
        out.push_str("  checkValidity(): boolean;\n  reportValidity(): boolean;\n");
    }
    out.push_str("  /** Resolves once pending prop changes have reached the DOM. */\n");
    out.push_str("  readonly updateComplete: Promise<void>;\n");
    if !interface.events.is_empty() {
        for method in ["addEventListener", "removeEventListener"] {
            let options = if method == "addEventListener" {
                "AddEventListenerOptions"
            } else {
                "EventListenerOptions"
            };
            out.push_str(&format!(
                "  {method}<K extends keyof {class}EventMap>(type: K, listener: (this: {class}, event: {class}EventMap[K]) => unknown, options?: boolean | {options}): void;\n  {method}(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | {options}): void;\n"
            ));
        }
    }
    out.push_str("}\n\n");
    if !interface.events.is_empty() {
        out.push_str(&format!(
            "/** The events `<{tag}>` fires, with their `detail`. */\nexport interface {class}EventMap extends HTMLElementEventMap {{\n",
            tag = component.tag
        ));
        for event in &interface.events {
            if let Some(description) = &event.description {
                out.push_str(&format!("  /** {description} */\n"));
            }
            out.push_str(&format!(
                "  {}: CustomEvent<{}>;\n",
                property_key(&event.name),
                event.detail
            ));
        }
        out.push_str("}\n\n");
    }
    out.push_str(&format!(
        "/** The props of `<{tag}>`, for frameworks and wrappers. */\nexport interface {class}Props {{\n",
        tag = component.tag
    ));
    for prop in &interface.props {
        let optional = if prop.required() { "" } else { "?" };
        out.push_str(&format!(
            "  {}{optional}: {};\n",
            property_key(&prop.name),
            prop_type(prop)
        ));
    }
    out.push_str("}\n\n");
    let tag = serde_json::to_string(&component.tag).expect("strings serialize");
    out.push_str(&format!("export declare const tag: {tag};\n"));
    match framework {
        Framework::None => out.push_str(&format!("export default {class};\n")),
        Framework::React => out.push_str(&react_component(component, &interface, &class)),
        Framework::Vue => out.push_str(&vue_component(component, &interface, &class)),
        Framework::Svelte | Framework::Solid => {
            out.push_str(&format!("export default {class};\n"));
            out.push_str(&intrinsic_element(component, &interface, &class, framework));
        }
    }
    out.push_str(&format!(
        "\ndeclare global {{\n  interface HTMLElementTagNameMap {{\n    {tag}: {class};\n  }}\n}}\n"
    ));
    Ok(out)
}

fn event_type(class: &str, event: &EventInterface) -> String {
    format!(
        "{class}EventMap[{}]",
        serde_json::to_string(&event.name).expect("strings serialize")
    )
}

/// The React wrapper: props, `on<Event>` handlers (`onValueChange` for a `value` pair), and the
/// element's own HTML attributes, children and ref.
fn react_component(
    component: &ComponentAst,
    interface: &validate::Interface,
    class: &str,
) -> String {
    let pairs = models(interface);
    let mut members = Vec::new();
    let mut taken = Vec::new();
    for prop in &interface.props {
        let optional = if prop.required() { "" } else { "?" };
        members.push(format!(
            "  {}{optional}: {};",
            property_key(&prop.name),
            prop_type(prop)
        ));
        taken.push(prop.name.clone());
    }
    for event in &interface.events {
        // The runtime matches any casing; this spelling uses the prop's word boundaries.
        let paired = |name: &str| {
            pairs
                .iter()
                .find(|(_, paired)| paired.name == name)
                .map(|(prop, _)| capitalized(&prop.name))
        };
        let handler = match (
            paired(&event.name),
            event.name.strip_prefix("before").and_then(paired),
        ) {
            (Some(prop), _) => format!("on{prop}Change"),
            (None, Some(prop)) => format!("onBefore{prop}Change"),
            (None, None) => format!("on{}", capitalized(&event.name)),
        };
        if let Some(description) = &event.description {
            members.push(format!("  /** {description} */"));
        }
        members.push(format!(
            "  {handler}?: (event: {}) => void;",
            event_type(class, event)
        ));
        taken.push(handler);
    }
    let omitted = taken
        .iter()
        .map(|name| serde_json::to_string(name).expect("strings serialize"))
        .collect::<Vec<_>>()
        .join(" | ");
    let base = if omitted.is_empty() {
        format!("React.HTMLAttributes<{class}>")
    } else {
        format!("Omit<React.HTMLAttributes<{class}>, {omitted}>")
    };
    format!(
        "\n/** `<{tag}>` as a React component (what `.jsx`/`.tsx` files get from the build plugin). */\nexport interface {class}ReactProps extends {base} {{\n{}\n  children?: React.ReactNode;\n}}\ndeclare const {class}React: React.ForwardRefExoticComponent<{class}ReactProps & React.RefAttributes<{class}>>;\nexport default {class}React;\n",
        members.join("\n"),
        tag = component.tag
    )
}

/// Svelte and Solid use the element directly: declare it among their template elements, with
/// its props and events (`onvaluechange` in Svelte; `prop:value` / `on:valuechange` in Solid).
fn intrinsic_element(
    component: &ComponentAst,
    interface: &validate::Interface,
    class: &str,
    framework: Framework,
) -> String {
    let tag = serde_json::to_string(&component.tag).expect("strings serialize");
    let mut members = Vec::new();
    for prop in &interface.props {
        let optional = if prop.required() { "" } else { "?" };
        let key = property_key(&prop.name);
        members.push(format!("{key}{optional}: {}", prop_type(prop)));
        if framework == Framework::Solid {
            members.push(format!("\"prop:{}\"?: {}", prop.name, prop_type(prop)));
        }
    }
    for event in &interface.events {
        let handler = match framework {
            Framework::Solid => format!("\"on:{}\"", event.name),
            _ => format!("on{}", event.name),
        };
        members.push(format!(
            "{handler}?: (event: {}) => void",
            event_type(class, event)
        ));
    }
    let own = format!("{{ {} }}", members.join("; "));
    match framework {
        Framework::Svelte => format!(
            "\ndeclare module \"svelte/elements\" {{\n  interface SvelteHTMLElements {{\n    {tag}: Omit<HTMLAttributes<{class}>, keyof {own}> & {own};\n  }}\n}}\n"
        ),
        _ => format!(
            "\ndeclare module \"solid-js\" {{\n  namespace JSX {{\n    interface IntrinsicElements {{\n      {tag}: Omit<JSX.HTMLAttributes<{class}>, keyof {own}> & {own};\n    }}\n  }}\n}}\n"
        ),
    }
}

/// The Vue wrapper: props (plus `modelValue` for `v-model`), the events, and `update:` events for
/// each two-way binding.
fn vue_component(component: &ComponentAst, interface: &validate::Interface, class: &str) -> String {
    let pairs = models(interface);
    let primary = pairs
        .iter()
        .find(|(prop, _)| prop.name == "value")
        .or_else(|| (pairs.len() == 1).then(|| &pairs[0]));
    let mut props: Vec<String> = interface
        .props
        .iter()
        .map(|prop| format!("{}?: {}", property_key(&prop.name), prop_type(prop)))
        .collect();
    let mut emits: Vec<String> = interface
        .events
        .iter()
        .map(|event| {
            format!(
                "{}: (event: {}) => true",
                property_key(&event.name),
                event_type(class, event)
            )
        })
        .collect();
    for (prop, _) in &pairs {
        emits.push(format!(
            "\"update:{}\": (value: {}) => true",
            prop.name,
            prop_type(prop)
        ));
    }
    if let Some((prop, _)) = primary {
        props.push(format!("modelValue?: {}", prop_type(prop)));
        emits.push(format!(
            "\"update:modelValue\": (value: {}) => true",
            prop_type(prop)
        ));
    }
    format!(
        "\n/** `<{tag}>` as a Vue component (what `.vue` files get from the build plugin). */\ndeclare const {class}Vue: DefineComponent<{{ {} }}, {{}}, {{}}, {{}}, {{}}, {{}}, {{}}, {{ {} }}>;\nexport default {class}Vue;\n",
        props.join("; "),
        emits.join("; "),
        tag = component.tag
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_types_from_defaults() {
        assert_eq!(ts_type(&json!("x")), "string");
        assert_eq!(ts_type(&json!([1, 2])), "number[]");
        assert_eq!(ts_type(&json!([1, "a"])), "(number | string)[]");
        assert_eq!(ts_type(&json!([])), "unknown[]");
        assert_eq!(ts_type(&json!({})), "Record<string, unknown>");
        assert_eq!(
            ts_type(&json!({ "a": true, "b-c": [{ "d": null }] })),
            "{ a: boolean; \"b-c\": { d: unknown }[] }"
        );
    }

    #[test]
    fn derives_class_names_from_tags() {
        assert_eq!(class_name("mnx-header"), "MnxHeader");
        assert_eq!(class_name("my-cool-element"), "MyCoolElement");
    }
}
