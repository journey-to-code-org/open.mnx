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
mod scanner;
mod script;
mod validate;

pub use components::Loader;
pub use diagnostic::{Diagnostic, Span};

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
        },
    )
}

// ---- tools ----------------------------------------------------------------------------------

/// A Custom Elements Manifest (`custom-elements.json`) describing the component, as the module
/// at `module_path` (the path the JavaScript output is published at).
pub fn compile_manifest(source: &str, module_path: &str) -> Result<String, Diagnostic> {
    emit_interface::manifest(&parser::parse(source)?, module_path)
}

/// TypeScript declarations (`.d.ts`) for the JavaScript output.
pub fn compile_declarations(source: &str, source_name: &str) -> Result<String, Diagnostic> {
    emit_interface::declarations(&parser::parse(source)?, source_name)
}
