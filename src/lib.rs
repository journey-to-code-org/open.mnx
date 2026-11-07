//! mnx: a compiler for Web Components written as HTML-first single-file components.
//!
//! Every entry point comes in two forms: one taking a source string (no `.mnx` imports
//! allowed, since there is nowhere to find them), and a `_file` / `_with` form that resolves
//! imported components — from the filesystem, or through a caller-supplied [`Loader`].

mod ast;
mod components;
mod diagnostic;
mod emit_interface;
mod emit_js;
mod events;
mod expression;
mod ir;
mod parser;
mod render;
mod request;
mod scanner;
mod script;
mod styles;
mod typescript;
mod validate;

pub use components::{filesystem, Loader};
pub use diagnostic::{Diagnostic, Span};
pub use emit_interface::Framework;
pub use emit_js::StyleImports;

fn parse_json(text: &str, what: &str) -> Result<serde_json::Value, Diagnostic> {
    serde_json::from_str(text).map_err(|error| {
        Diagnostic::new(
            Span::new(error.line(), error.column()),
            format!("invalid {what} JSON: {:?}", error.classify()),
        )
    })
}

fn load(
    source: &str,
    path: &str,
    loader: Option<Loader<'_>>,
) -> Result<ast::ComponentAst, Diagnostic> {
    let mut component = parser::parse(source)?;
    components::load(&mut component, path, loader)?;
    Ok(component)
}

fn read(path: &str) -> Result<String, Diagnostic> {
    std::fs::read_to_string(path).map_err(|error| {
        Diagnostic::new(
            Span::new(1, 1),
            format!("{path}: unable to read source: {error}"),
        )
    })
}

// ---- HTML -----------------------------------------------------------------------------------

pub fn compile(source: &str, props_json: &str) -> Result<String, Diagnostic> {
    compile_value(source, &parse_json(props_json, "props")?)
}

pub fn compile_with_slots(
    source: &str,
    props_json: &str,
    slots_json: &str,
) -> Result<String, Diagnostic> {
    compile_value_with_slots(
        source,
        &parse_json(props_json, "props")?,
        &parse_json(slots_json, "slots")?,
    )
}

pub fn compile_value(source: &str, props: &serde_json::Value) -> Result<String, Diagnostic> {
    compile_value_with_slots(source, props, &serde_json::json!({}))
}

pub fn compile_value_with_slots(
    source: &str,
    props: &serde_json::Value,
    slots: &serde_json::Value,
) -> Result<String, Diagnostic> {
    html(load(source, "component.mnx", None)?, props, slots)
}

/// Static HTML for the component at `path`, resolving its `.mnx` imports from the filesystem.
pub fn compile_file(path: &str, props_json: &str, slots_json: &str) -> Result<String, Diagnostic> {
    compile_html_with(
        &read(path)?,
        path,
        props_json,
        slots_json,
        &components::filesystem,
    )
}

/// Static HTML, resolving `.mnx` imports with `loader`.
pub fn compile_html_with(
    source: &str,
    path: &str,
    props_json: &str,
    slots_json: &str,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    let component = load(source, path, Some(loader))?;
    html(
        component,
        &parse_json(props_json, "props")?,
        &parse_json(slots_json, "slots")?,
    )
}

fn html(
    component: ast::ComponentAst,
    props: &serde_json::Value,
    slots: &serde_json::Value,
) -> Result<String, Diagnostic> {
    let slot_values = slots
        .as_object()
        .ok_or_else(|| Diagnostic::new(Span::new(1, 1), "component slots must be a JSON object"))?;
    let mut slot_nodes = std::collections::HashMap::new();
    for (name, source) in slot_values {
        let source = source.as_str().ok_or_else(|| {
            Diagnostic::new(
                Span::new(1, 1),
                format!("slot `{name}` must contain an mnx template string"),
            )
        })?;
        slot_nodes.insert(name.clone(), parser::parse_fragment(source)?);
    }
    let component = validate::validate(component, props, &slot_nodes)?;
    Ok(render::render(&component))
}

// ---- JavaScript -----------------------------------------------------------------------------

/// Compile a component to a JavaScript module that defines its custom element.
///
/// `runtime` is the module specifier the output imports the runtime from (usually
/// `"@mnx/runtime"`); `source_name` appears in the generated header.
pub fn compile_js(source: &str, runtime: &str, source_name: &str) -> Result<String, Diagnostic> {
    let component = load(source, source_name, None)?;
    emit_js::emit(
        &component,
        &emit_js::Options {
            runtime,
            source_name,
            component_extension: Some(".js"),
            style_imports: None,
        },
    )
}

/// The JavaScript module for the component at `path`; `.mnx` imports become `.js` imports.
pub fn compile_js_file(path: &str, runtime: &str) -> Result<String, Diagnostic> {
    compile_js_with(
        &read(path)?,
        path,
        runtime,
        Some(".js"),
        &components::filesystem,
    )
}

/// The JavaScript module, resolving `.mnx` imports with `loader`. `component_extension`
/// rewrites `.mnx` import specifiers (`Some(".js")`), or keeps them (`None`) for bundlers that
/// load `.mnx` files themselves.
pub fn compile_js_with(
    source: &str,
    path: &str,
    runtime: &str,
    component_extension: Option<&str>,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    let component = load(source, path, Some(loader))?;
    let source_name = std::path::Path::new(path).file_name().map_or_else(
        || path.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    emit_js::emit(
        &component,
        &emit_js::Options {
            runtime,
            source_name: &source_name,
            component_extension,
            style_imports: None,
        },
    )
}

/// The JavaScript module for a bundler plugin: `.mnx` imports are kept, and the `<style>` is
/// imported through the bundler (see [`StyleImports`]) instead of inlined.
pub fn compile_js_for_bundler(
    source: &str,
    path: &str,
    runtime: &str,
    style_imports: StyleImports<'_>,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    let component = load(source, path, Some(loader))?;
    let source_name = std::path::Path::new(path).file_name().map_or_else(
        || path.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    emit_js::emit(
        &component,
        &emit_js::Options {
            runtime,
            source_name: &source_name,
            component_extension: None,
            style_imports: Some(style_imports),
        },
    )
}

// ---- styles ---------------------------------------------------------------------------------

/// The scoped stylesheet of the component at `path` and of every component it imports, for the
/// page's `<head>` (light-DOM components; shadow ones carry their own). Empty without styles.
pub fn compile_css_file(path: &str) -> Result<String, Diagnostic> {
    let component = load(&read(path)?, path, Some(&components::filesystem))?;
    Ok(stylesheets(&component))
}

/// The scoped stylesheets of a component and what it imports, resolving imports with `loader`.
pub fn css_with(source: &str, path: &str, loader: Loader<'_>) -> Result<String, Diagnostic> {
    Ok(stylesheets(&load(source, path, Some(loader))?))
}

/// The compiler as one function: a JSON request in, a JSON response out (what the WebAssembly
/// build exposes). See [`request`](crate::request) for the format.
pub fn handle_request(request: &str) -> String {
    request::handle(request)
}

/// The scoped stylesheet of a component with no `.mnx` imports.
pub fn compile_css(source: &str) -> Result<String, Diagnostic> {
    Ok(stylesheets(&parser::parse(source)?))
}

fn stylesheets(component: &ast::ComponentAst) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out = String::new();
    collect_stylesheets(component, &mut seen, &mut out);
    out
}

fn collect_stylesheets(
    component: &ast::ComponentAst,
    seen: &mut std::collections::HashSet<String>,
    out: &mut String,
) {
    for child in &component.children {
        collect_stylesheets(&child.ast, seen, out);
    }
    if seen.insert(component.tag.clone()) {
        if let Some(css) = styles::stylesheet(component) {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("/* {} */\n{css}", component.tag));
        }
    }
}

// ---- tools ----------------------------------------------------------------------------------

/// Things that compile but may not do what was meant: a prop that shadows a built-in property
/// of every element (`hidden` hides the host; `title` also shows a tooltip).
pub fn warnings(source: &str) -> Vec<Diagnostic> {
    let Ok(component) = parser::parse(source) else {
        return Vec::new();
    };
    component
        .props
        .iter()
        .filter_map(|prop| {
            let (_, effect) = BUILT_IN_PROPERTIES
                .iter()
                .find(|(name, _)| *name == prop.name)?;
            Some(
                Diagnostic::new(
                    prop.span,
                    format!(
                        "prop `{}` is also every element's built-in `{}`: {effect}",
                        prop.name, prop.name
                    ),
                )
                .with_help(format!(
                    "rename the prop if that isn't intended (e.g. `{}-text`)",
                    prop.name
                )),
            )
        })
        .collect()
}

/// `HTMLElement` properties a prop would shadow, and what the attribute does on its own.
const BUILT_IN_PROPERTIES: &[(&str, &str)] = &[
    (
        "title",
        "the attribute also shows as a tooltip on the element",
    ),
    ("hidden", "the attribute also hides the element"),
    ("id", "the attribute is also the element's id"),
    (
        "slot",
        "the attribute also assigns the element to a slot of its parent",
    ),
    ("style", "the attribute is also the element's inline style"),
    (
        "lang",
        "the attribute also sets the language of the element's content",
    ),
    (
        "dir",
        "the attribute also sets the text direction of the element's content",
    ),
    (
        "inert",
        "the attribute also makes the element and its content inert",
    ),
    (
        "draggable",
        "the attribute also makes the element draggable",
    ),
    (
        "translate",
        "the attribute also controls translation of the element's content",
    ),
    ("popover", "the attribute also makes the element a popover"),
    (
        "autofocus",
        "the attribute also focuses the element on page load",
    ),
    ("tabIndex", "the attribute also makes the element focusable"),
    (
        "accessKey",
        "the attribute also gives the element a keyboard shortcut",
    ),
    (
        "contentEditable",
        "the attribute also makes the element's content editable",
    ),
    (
        "spellcheck",
        "the attribute also controls spell checking of the element's content",
    ),
    (
        "role",
        "the attribute also sets the element's accessibility role",
    ),
    ("className", "it is also the element's class list"),
];

/// A Custom Elements Manifest (`custom-elements.json`) describing the component, as the module
/// at `module_path` (the path the JavaScript output is published at).
pub fn compile_manifest(source: &str, module_path: &str) -> Result<String, Diagnostic> {
    emit_interface::manifest(&parser::parse(source)?, module_path)
}

/// HTML custom data for editors (VS Code's `html.customData` format).
pub fn compile_html_data(source: &str) -> Result<String, Diagnostic> {
    emit_interface::html_data(&parser::parse(source)?)
}

/// TypeScript declarations (`.d.ts`) for the JavaScript output.
pub fn compile_declarations(source: &str, source_name: &str) -> Result<String, Diagnostic> {
    emit_interface::declarations(&parser::parse(source)?, source_name, Framework::None)
}

/// TypeScript declarations where the default export is the `framework`'s wrapper component.
pub fn compile_declarations_for(
    source: &str,
    source_name: &str,
    framework: Framework,
) -> Result<String, Diagnostic> {
    emit_interface::declarations(&parser::parse(source)?, source_name, framework)
}
