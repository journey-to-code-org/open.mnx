//! `id()` on the server: the ids are in the HTML, with a base on each host the element uses.

use zubra::{compile, compile_html_with};

const FIELD: &str = "<script>\n  import { id } from '@zubra/runtime'\n  const inputId = id()\n  const hintId = id()\n</script>\n<zb-field label=\"x\">\n  <label for={inputId}>{label}</label><input id={inputId} aria-describedby={hintId} />\n</zb-field>";

fn page(body: &str) -> String {
    let source = format!("<script>\n  import './field.zb'\n</script>\n<zb-page>{body}</zb-page>");
    let loader = |specifier: &str, _from: &str| {
        (specifier == "./field.zb")
            .then(|| ("field.zb".to_owned(), FIELD.to_owned()))
            .ok_or_else(|| "not found".to_owned())
    };
    compile_html_with(&source, "page.zb", "{}", "{}", &loader).unwrap()
}

#[test]
fn each_host_gets_a_base_and_each_call_its_number() {
    let html = compile(FIELD, "{}").unwrap();
    assert!(html.contains("data-zb-id=\"zb-field-s1\""), "{html}");
    assert!(html.contains("<label for=\"zb-field-s1-1\">"), "{html}");
    assert!(
        html.contains("aria-describedby=\"zb-field-s1-2\""),
        "{html}"
    );
    let html = page("<zb-field></zb-field><zb-field></zb-field><zb-field id=\"mine\"></zb-field>");
    assert!(html.contains("<input id=\"zb-field-s1-1\""), "{html}");
    assert!(html.contains("<input id=\"zb-field-s2-1\""), "{html}");
    assert!(
        html.contains("<input id=\"mine-1\""),
        "a host's own id is the base: {html}"
    );
    assert_eq!(
        html.matches("data-zb-id").count(),
        2,
        "not written where the host has an id: {html}"
    );
    // A second render numbers from 1 again (a page gives each render a prefix).
    assert!(page("<zb-field></zb-field>").contains("zb-field-s1-1"));
}

#[test]
fn ids_used_any_other_way_are_left_to_the_browser() {
    for script in [
        "const inputId = id()\n  const more = [1, 2].map(() => id())",
        "const inputId = id()\n  function later() { return id() }",
        "let inputId = id()",
    ] {
        let source = format!("<script>\n  import {{ id }} from '@zubra/runtime'\n  {script}\n</script>\n<zb-x>\n  <input id={{inputId}} />\n</zb-x>");
        let error = compile(&source, "{}").unwrap_err();
        assert!(
            error.message.contains("`inputId` only exists at runtime"),
            "{script}: {}",
            error.message
        );
    }
}

#[test]
fn a_render_can_prefix_its_bases() {
    let response: serde_json::Value = serde_json::from_str(&zubra::handle_request(
        &serde_json::json!({ "path": "/f.zb", "files": { "/f.zb": FIELD }, "emit": "html", "idPrefix": "r2-" }).to_string(),
    ))
    .unwrap();
    let html = response["output"].as_str().unwrap();
    assert!(
        html.contains("data-zb-id=\"r2-zb-field-s1\"") && html.contains("for=\"r2-zb-field-s1-1\""),
        "{html}"
    );
    let refused: serde_json::Value = serde_json::from_str(&zubra::handle_request(
        &serde_json::json!({ "path": "/f.zb", "files": { "/f.zb": FIELD }, "emit": "html", "idPrefix": "a\"b" }).to_string(),
    ))
    .unwrap();
    assert_eq!(refused["ok"], false);
}
