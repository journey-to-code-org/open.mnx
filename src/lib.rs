mod ast;
mod diagnostic;
mod expression;
mod ir;
mod parser;
mod render;
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
                format!("slot `{name}` must contain a MNIX template string"),
            )
        })?;
        slot_nodes.insert(name.clone(), parser::parse_fragment(source)?);
    }
    let component = validate::validate(component, props, &slot_nodes)?;
    render::render(&component)
}
