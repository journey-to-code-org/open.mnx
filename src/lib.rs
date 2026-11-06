mod ast;
mod diagnostic;
mod emit_interface;
mod emit_js;
mod expression;
mod ir;
mod parser;
mod render;
mod scanner;
mod script;
mod validate;

pub use diagnostic::{Diagnostic, Span};

pub fn compile(source: &str, props_json: &str) -> Result<String, Diagnostic> {
    let props: serde_json::Value = serde_json::from_str(props_json).map_err(|error| {
        Diagnostic::new(
            Span::new(error.line(), error.column()),
            format!("invalid props JSON: {:?}", error.classify()),
        )
    })?;
    compile_value(source, &props)
}

pub fn compile_with_slots(
    source: &str,
    props_json: &str,
    slots_json: &str,
) -> Result<String, Diagnostic> {
    let props: serde_json::Value = serde_json::from_str(props_json).map_err(|error| {
        Diagnostic::new(
            Span::new(error.line(), error.column()),
            format!("invalid props JSON: {:?}", error.classify()),
        )
    })?;
    let slots: serde_json::Value = serde_json::from_str(slots_json).map_err(|error| {
        Diagnostic::new(
            Span::new(error.line(), error.column()),
            format!("invalid slots JSON: {:?}", error.classify()),
        )
    })?;
    compile_value_with_slots(source, &props, &slots)
}

pub fn compile_value(source: &str, props: &serde_json::Value) -> Result<String, Diagnostic> {
    compile_value_with_slots(source, props, &serde_json::json!({}))
}

pub fn compile_value_with_slots(
    source: &str,
    props: &serde_json::Value,
    slots: &serde_json::Value,
) -> Result<String, Diagnostic> {
    let component = parser::parse(source)?;
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

/// Compile a component to a JavaScript module that defines its custom element.
///
/// `runtime` is the module specifier the output imports the runtime from (usually
/// `"@mnx/runtime"`); `source_name` appears in the generated header.
pub fn compile_js(source: &str, runtime: &str, source_name: &str) -> Result<String, Diagnostic> {
    let component = parser::parse(source)?;
    emit_js::emit(
        &component,
        &emit_js::Options {
            runtime,
            source_name,
        },
    )
}

/// A Custom Elements Manifest (`custom-elements.json`) describing the component, as the module
/// at `module_path` (the path the JavaScript output is published at).
pub fn compile_manifest(source: &str, module_path: &str) -> Result<String, Diagnostic> {
    emit_interface::manifest(&parser::parse(source)?, module_path)
}

/// TypeScript declarations (`.d.ts`) for the JavaScript output.
pub fn compile_declarations(source: &str, source_name: &str) -> Result<String, Diagnostic> {
    emit_interface::declarations(&parser::parse(source)?, source_name)
}
