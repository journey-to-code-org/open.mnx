use serde_json::json;
use zubra_macros::include_zb;

#[test]
fn embeds_a_component_and_its_imports() {
    let card = include_zb!("tests/components/card.zb");
    assert_eq!(card.tag().unwrap(), "x-card");
    let html = card.render(&json!({ "title": "Hello" })).unwrap();
    assert!(
        html.contains("<h2>Hello</h2>") && html.contains("<span>Hello</span>"),
        "{html}"
    );
    assert!(card.css().unwrap().contains("color: green"));
    assert!(card.module().unwrap().contains("@zubra/runtime"));
}

#[test]
fn names_files_from_the_crate_not_the_build_machine() {
    let card = include_zb!("tests/components/card.zb");
    assert_eq!(card.path(), "tests/components/card.zb");
}

#[test]
fn works_in_a_static() {
    static BADGE: std::sync::LazyLock<zubra::Component> =
        std::sync::LazyLock::new(|| include_zb!("tests/components/badge.zb"));
    assert!(BADGE
        .render(&json!({ "label": "x" }))
        .unwrap()
        .contains("<span>x</span>"));
}

#[test]
fn a_file_outside_the_crate_is_named_relative_to_it() {
    let outside = include_zb!("../examples/backends/flask-garden/components/status-pill.zb");
    assert_eq!(
        outside.path(),
        "../examples/backends/flask-garden/components/status-pill.zb"
    );
}
