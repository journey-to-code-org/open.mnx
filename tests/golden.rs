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
