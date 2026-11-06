//! Golden tests: each `examples/<name>.mnx` compiles to the committed `examples/<name>.html`.
//! Regenerate an expectation deliberately (after reviewing the diff), never by copying output blindly.
use std::fs;

fn read(name: &str) -> String {
    fs::read_to_string(format!("{}/examples/{name}", env!("CARGO_MANIFEST_DIR")))
        .unwrap_or_else(|error| panic!("examples/{name}: {error}"))
}

fn assert_golden(actual: &str, expected_file: &str) {
    let expected = read(expected_file);
    assert_eq!(
        actual.trim_end(),
        expected.trim_end(),
        "output differs from examples/{expected_file}"
    );
}

/// The sample that drives the v0.3 syntax: a `<script>` scope, a host tag whose attributes
/// declare props (defaults bound to script locals), and `{expr}` bindings with member access.
#[test]
fn header_sample_renders_with_script_defaults() {
    let html = mnix_compiler::compile(&read("header.mnx"), "{}").unwrap();
    assert_golden(&html, "header.html");
}

/// Props supplied at build time override the script defaults and are written back onto the
/// host as attributes, so a runtime can hydrate from the markup alone.
#[test]
fn header_sample_accepts_prop_overrides() {
    let html = mnix_compiler::compile(&read("header.mnx"), &read("header.props.json")).unwrap();
    assert_golden(&html, "header.override.html");
}

/// The same component compiled to a JavaScript module: template, prop interface, and the parts
/// (paths into the template) that hydration binds to.
#[test]
fn header_sample_compiles_to_a_custom_element_module() {
    let module =
        mnix_compiler::compile_js(&read("header.mnx"), "@mnx/runtime", "header.mnx").unwrap();
    assert_golden(&module, "header.js");
}

/// TypeScript declarations and the Custom Elements Manifest for the same component.
#[test]
fn header_sample_describes_itself_to_tools() {
    let source = read("header.mnx");
    assert_golden(
        &mnix_compiler::compile_declarations(&source, "header.mnx").unwrap(),
        "header.d.ts",
    );
    assert_golden(
        &mnix_compiler::compile_manifest(&source, "header.js").unwrap(),
        "header.manifest.json",
    );
}
