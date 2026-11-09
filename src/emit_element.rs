//! `--emit element`: the component as a plain custom element, with no runtime to install.
//!
//! The output is the module `--emit js` writes, with its `@zubra/runtime` imports replaced by a
//! small `$define` (`element_runtime.js`, inlined) that turns the same definition into a
//! `class extends HTMLElement`: props as properties and observed attributes, the template's parts
//! bound directly to the DOM, light-DOM slots. The two outputs share one definition, so they
//! can't drift, and the same browser tests run on both.
//!
//! What the element runtime doesn't cover is refused with a reason, pointing at `--emit js`:
//! shadow DOM, spreads, zb-await, and runtime features beyond the basics (`resource`,
//! `createContext`, `@zubra/runtime/zag`…). `@zubra/runtime/primitives` stays an import: it needs
//! nothing else.

use crate::ast::ComponentAst;
use crate::diagnostic::Diagnostic;
use crate::emit_js;

/// The element runtime, inlined into every `--emit element` module.
const RUNTIME: &str = include_str!("element_runtime.js");

/// What a script may import from `@zubra/runtime` in an element: the element runtime defines these.
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

pub fn emit(
    component: &ComponentAst,
    source_name: &str,
    component_extension: Option<&str>,
) -> Result<String, Diagnostic> {
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
    // The script's runtime imports: the element runtime's names, renamed where the script aliases them.
    let mut aliases = Vec::new();
    let mut slots = std::collections::HashSet::new();
    crate::validate::collect_slots(&component.nodes, &mut slots);
    let mut uses_slots = !slots.is_empty();
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
                uses_slots |= imported == "hasSlot";
                if imported != local {
                    aliases.push(format!("const {local} = {imported};"));
                }
            }
        } else if specifier.starts_with("@zubra/runtime/") && !STANDALONE.contains(&specifier) {
            return Err(Diagnostic::new(
                component.tag_span,
                format!("--emit element can't include `{specifier}`: it needs the runtime"),
            )
            .with_help(HINT));
        }
    }
    let module = emit_js::emit(
        component,
        &emit_js::Options {
            runtime: "@zubra/runtime",
            source_name,
            component_extension,
            style_imports: None,
        },
    )?;
    if module.contains("bind: $spread") {
        return Err(Diagnostic::new(
            component.tag_span,
            "--emit element doesn't support `{...spread}` in the template",
        )
        .with_help(HINT));
    }
    if module.contains(", await: () =>") {
        return Err(Diagnostic::new(
            component.tag_span,
            "--emit element doesn't support zb-await",
        )
        .with_help(HINT));
    }

    // The module's imports, minus @zubra/runtime's, then the element runtime, then the rest.
    let mut imports = String::new();
    let mut body = String::new();
    let mut in_imports = true;
    for line in module.lines().skip(1) {
        if in_imports && line.starts_with("import ") {
            if !imports_runtime(line) {
                imports.push_str(line);
                imports.push('\n');
            }
            continue;
        }
        in_imports = false;
        body.push_str(line);
        body.push('\n');
    }
    let mut out = format!(
        "// Generated by zubra from {source_name} (--emit element): a plain custom element, with no runtime to install. Do not edit.\n"
    );
    out.push_str(&imports);
    out.push('\n');
    out.push_str(&runtime(uses_slots));
    // The compiler's own names for state() and computed() (JSX lowering may already import them).
    for (local, imported) in [
        (crate::reactive::STATE, "state"),
        (crate::reactive::COMPUTED, "computed"),
    ] {
        let declared = format!("const {local} = ");
        if module.contains(local) && !aliases.iter().any(|alias| alias.starts_with(&declared)) {
            aliases.push(format!("const {local} = {imported};"));
        }
    }
    aliases.dedup();
    for alias in aliases {
        out.push_str(&alias);
        out.push('\n');
    }
    out.push_str(&body);
    Ok(out)
}

/// The element runtime, without its light-DOM slot machinery (the `// @slots {` … `// @slots }`
/// sections) for a component that has no slots: most components, and most of the savings.
fn runtime(slots: bool) -> String {
    let mut out = String::with_capacity(RUNTIME.len());
    let mut skipping = false;
    for line in RUNTIME.lines() {
        match line {
            "// @slots {" => skipping = !slots,
            "// @slots }" => skipping = false,
            _ if !skipping => {
                out.push_str(line);
                out.push('\n');
            }
            _ => {}
        }
    }
    out
}

/// An import line of `@zubra/runtime` itself (not a subpath, not a component).
fn imports_runtime(line: &str) -> bool {
    line.trim_end_matches(';')
        .trim_end()
        .ends_with("\"@zubra/runtime\"")
        || line
            .trim_end_matches(';')
            .trim_end()
            .ends_with("'@zubra/runtime'")
}

/// `import { a, b as c } from …` → [(a, a), (b, c)].
fn named_imports(text: &str) -> Vec<(String, String)> {
    let names = text
        .split_once('{')
        .and_then(|(_, rest)| rest.split_once('}'))
        .map_or("", |(names, _)| names);
    names
        .split(',')
        .filter_map(|name| {
            let mut words = name.split_whitespace();
            let imported = words.next()?.to_owned();
            let local = match (words.next(), words.next()) {
                (Some("as"), Some(local)) => local.to_owned(),
                _ => imported.clone(),
            };
            Some((imported, local))
        })
        .collect()
}
