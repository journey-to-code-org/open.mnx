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

fn prop_type(prop: &PropInterface) -> String {
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

/// TypeScript declarations for the module the JavaScript backend writes.
pub fn declarations(component: &ComponentAst, source_name: &str) -> Result<String, Diagnostic> {
    let interface = validate::analyze(component)?;
    let class = class_name(&component.tag);
    let mut out = format!("// Generated by mnx from {source_name}. Do not edit.\n\n");
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
        let optional = if prop.default.is_some() { "?" } else { "" };
        out.push_str(&format!(
            "  {}{optional}: {};\n",
            property_key(&prop.name),
            prop_type(prop)
        ));
    }
    out.push_str("}\n\n");
    out.push_str(&format!(
        "export declare const tag: {};\nexport default {class};\n\ndeclare global {{\n  interface HTMLElementTagNameMap {{\n    {}: {class};\n  }}\n}}\n",
        serde_json::to_string(&component.tag).expect("strings serialize"),
        serde_json::to_string(&component.tag).expect("strings serialize"),
    ));
    Ok(out)
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
