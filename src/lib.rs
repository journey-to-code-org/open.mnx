mod ast;
mod diagnostic;
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

pub fn compile_value(source: &str, props: &serde_json::Value) -> Result<String, Diagnostic> {
    let component = parser::parse(source)?;
    let component = validate::validate(component, props)?;
    render::render(&component)
}
