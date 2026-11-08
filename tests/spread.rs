//! `{...object}` in a start tag: parsing, the HTML output, the JavaScript output's part, JSX, and
//! where a spread isn't allowed.
use mnx_compiler::{compile, compile_js};

fn js(source: &str) -> String {
    compile_js(source, "@mnx/runtime", "x.mnx").unwrap()
}

#[test]
fn a_known_spread_renders_its_attributes_and_the_element_s_own_win() {
    let source = r#"<script>
  const attrs = { href: "/a", title: "theirs", "aria-expanded": false, hidden: true, disabled: false, className: "b", style: { color: "red", fontSize: "2px" }, onClick: null }
</script>
<x-link><a class="a" title="own" {...attrs}>go</a></x-link>"#;
    let html = compile(source, "{}").unwrap();
    assert!(
        html.contains(r#"<a class="a b" title="own" href="/a" aria-expanded="false" hidden style="color: red; font-size: 2px">go</a>"#),
        "{html}"
    );
}

#[test]
fn a_spread_known_only_in_the_browser_is_left_for_the_element() {
    let source = r#"<script>
  function attrs() { return { href: "/a" } }
</script>
<x-link><a class="a" {...attrs()}>go</a></x-link>"#;
    let html = mnx_compiler::compile_html_with_options(
        source,
        "x.mnx",
        "{}",
        "{}",
        mnx_compiler::HtmlOptions {
            slot_source: mnx_compiler::SlotSource::Template,
            partial: true,
            pending: Vec::new(),
        },
        &mnx_compiler::filesystem,
    )
    .unwrap();
    assert!(html.contains(r#"<a class="a">go</a>"#), "{html}");
    let output = js(source);
    assert!(
        output.contains(r#"{ path: [0], spread: () => (attrs()), own: ["class"], bind: $spread }"#),
        "{output}"
    );
}

#[test]
fn what_an_attribute_couldn_t_do_a_known_spread_can_t() {
    for (attrs, message) in [
        (r#"{ href: "javascript:alert(1)" }"#, "unsafe URL"),
        (r#"{ onclick: "alert(1)" }"#, "a handler as text"),
        (r#"{ innerHTML: "<b>x</b>" }"#, "can't set `innerHTML`"),
        (r#"{ style: "color: red" }"#, "must be an object"),
        (
            r#"{ style: { color: "red; background: url(x)" } }"#,
            "isn't a single CSS value",
        ),
        (r#"[1, 2]"#, "spreads an object"),
    ] {
        let source = format!(
            "<script>\n  const attrs = {attrs}\n</script>\n<x-a><a {{...attrs}}>go</a></x-a>"
        );
        let error = compile(&source, "{}").unwrap_err();
        assert!(
            error.message.contains(message),
            "{attrs}: {}",
            error.message
        );
    }
}

#[test]
fn a_spread_isn_t_allowed_on_the_host_a_directive_or_an_mnx_component() {
    let host = mnx_compiler::compile_js("<x-a {...attrs}><p>hi</p></x-a>", "@mnx/runtime", "x.mnx")
        .unwrap_err();
    assert!(
        host.message
            .contains("the host tag declares the component's props"),
        "{}",
        host.message
    );
    let directive = compile_js(
        "<script>const x = {}</script><x-a><mnx-if test={true} {...x}><p>hi</p></mnx-if></x-a>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap_err();
    assert!(
        directive.message.contains("is a directive"),
        "{}",
        directive.message
    );
    let bare = compile_js(
        "<script>const x = {}</script><x-a><p {x}>hi</p></x-a>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap_err();
    assert!(
        bare.message.contains("must spread an object"),
        "{}",
        bare.message
    );
}

#[test]
fn every_name_in_a_spread_is_checked() {
    let error = compile_js("<x-a><p {...atrs}>hi</p></x-a>", "@mnx/runtime", "x.mnx").unwrap_err();
    assert!(error.message.contains("atrs"), "{}", error.message);
}

#[test]
fn jsx_spreads_onto_elements_and_not_onto_components() {
    let source = "export default function XPill({ attrs = {} }) {\n  return <button type=\"button\" {...attrs} className=\"pill\">x</button>;\n}\n";
    let output = compile_js(source, "@mnx/runtime", "x-pill.mnx.jsx").unwrap();
    assert!(
        output.contains(r#"spread: () => $p.attrs, own: ["type", "class"], bind: $spread"#),
        "{output}"
    );
    let component = "import Badge from './badge.mnx';\nexport default function XWrap({ attrs = {} }) {\n  return <Badge {...attrs} />;\n}\n";
    let error = compile_js(component, "@mnx/runtime", "x-wrap.mnx.jsx").unwrap_err();
    assert!(
        error.message.contains("spreading onto an mnx component"),
        "{}",
        error.message
    );
}
