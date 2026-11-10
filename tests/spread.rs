//! `{...object}` in a start tag: parsing, the HTML output, the JavaScript output's part, JSX, and
//! where a spread isn't allowed.
use zubra::{
    compile, compile_html_with, compile_html_with_options, compile_js, compile_js_with, Diagnostic,
};

fn js(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "x.zb").unwrap()
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
    let html = zubra::compile_html_with_options(
        source,
        "x.zb",
        "{}",
        "{}",
        zubra::HtmlOptions {
            slot_source: zubra::SlotSource::Template,
            partial: true,
            pending: Vec::new(),
        },
        &zubra::filesystem,
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
fn a_spread_isn_t_allowed_on_the_host_or_a_directive() {
    let host =
        zubra::compile_js("<x-a {...attrs}><p>hi</p></x-a>", "@zubra/runtime", "x.zb").unwrap_err();
    assert!(
        host.message
            .contains("the host tag declares the component's props"),
        "{}",
        host.message
    );
    let directive = compile_js(
        "<script>const x = {}</script><x-a><zb-if test={true} {...x}><p>hi</p></zb-if></x-a>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert!(
        directive.message.contains("is a directive"),
        "{}",
        directive.message
    );
    let bare = compile_js(
        "<script>const x = {}</script><x-a><p {x}>hi</p></x-a>",
        "@zubra/runtime",
        "x.zb",
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
    let error = compile_js("<x-a><p {...atrs}>hi</p></x-a>", "@zubra/runtime", "x.zb").unwrap_err();
    assert!(error.message.contains("atrs"), "{}", error.message);
}

#[test]
fn jsx_spreads_onto_elements_and_components() {
    let source = "export default function XPill({ attrs = {} }) {\n  return <button type=\"button\" {...attrs} className=\"pill\">x</button>;\n}\n";
    let output = compile_js(source, "@zubra/runtime", "x-pill.zb.jsx").unwrap();
    assert!(
        output.contains(r#"spread: () => $p.attrs, own: ["type", "class"], bind: $spread"#),
        "{output}"
    );
    let component = "import Badge from './badge.zb';\nexport default function XWrap({ attrs = {} }) {\n  return <Badge {...attrs} />;\n}\n";
    let output = compile_js_with(
        component,
        "x-wrap.zb.jsx",
        "@zubra/runtime",
        None,
        &|specifier: &str, _from: &str| {
            assert_eq!(specifier, "./badge.zb");
            Ok(("badge.zb".to_owned(), BADGE.to_owned()))
        },
    )
    .unwrap();
    assert!(
        output.contains(r#"own: [], props: ["count", "label"], bind: $spread"#),
        "{output}"
    );
}

// ---- a spread onto a zubra component ------------------------------------------------------

const BADGE: &str = r#"<zb-badge label="new" count={0}>
  <b>{label}</b> <i>{count}</i>
</zb-badge>"#;

fn loader(specifier: &str, _from: &str) -> Result<(String, String), String> {
    match specifier {
        "./badge.zb" => Ok(("badge.zb".to_owned(), BADGE.to_owned())),
        _ => Err("not found".to_owned()),
    }
}

fn parent(spread: &str, extra: &str) -> String {
    format!(
        "<script>\n  import './badge.zb'\n  const rest = {spread}\n</script>\n<zb-page><zb-badge {extra} {{...rest}}></zb-badge></zb-page>"
    )
}

fn html(source: &str) -> Result<String, Diagnostic> {
    compile_html_with(source, "page.zb", "{}", "{}", &loader)
}

#[test]
fn a_known_spread_onto_a_component_passes_its_props_and_the_rest_to_the_host() {
    let output = html(&parent(
        r#"{ label: "sale", count: 3, title: "hi", "data-x": "1" }"#,
        "",
    ))
    .unwrap();
    assert!(output.contains("<b>sale</b>"), "{output}");
    assert!(output.contains("<i>3</i>"), "{output}");
    assert!(output.contains(r#"title="hi""#), "{output}");
    assert!(output.contains(r#"data-x="1""#), "{output}");
    // The same page as the props written out, with the other entries as attributes.
    let written = "<script>\n  import './badge.zb'\n</script>\n<zb-page><zb-badge label=\"sale\" count={3} title=\"hi\" data-x=\"1\"></zb-badge></zb-page>";
    let written = html(written).unwrap();
    for part in [
        "<b>sale</b> <i>3</i>",
        "title=\"hi\"",
        "data-x=\"1\"",
        "label=\"sale\"",
        "count=\"3\"",
    ] {
        assert_eq!(
            output.matches(part).count(),
            written.matches(part).count(),
            "{part}: {output} vs {written}"
        );
    }
    assert_eq!(
        output.matches("label=").count(),
        1,
        "a prop is not also a second attribute: {output}"
    );
}

#[test]
fn an_explicit_prop_wins_over_the_spread_in_either_order() {
    let output = html(&parent(
        r#"{ label: "from spread", count: 3 }"#,
        r#"label="own""#,
    ))
    .unwrap();
    assert!(output.contains("<b>own</b>"), "{output}");
    assert!(output.contains("<i>3</i>"), "{output}");
    let before = "<script>\n  import './badge.zb'\n  const rest = { label: \"from spread\" }\n</script>\n<zb-page><zb-badge {...rest} label=\"own\"></zb-badge></zb-page>";
    assert!(html(before).unwrap().contains("<b>own</b>"));
}

#[test]
fn an_explicit_prop_only_known_in_the_browser_still_wins_over_a_known_spread() {
    let source = "<script>\n  import './badge.zb'\n  const rest = { label: \"from spread\" }\n  function later() { return \"r\" }\n</script>\n<zb-page><zb-badge label={later()} {...rest}></zb-badge></zb-page>";
    let output = compile_html_with_options(
        source,
        "page.zb",
        "{}",
        "{}",
        zubra::HtmlOptions {
            slot_source: zubra::SlotSource::Template,
            partial: true,
            pending: Vec::new(),
        },
        &loader,
    )
    .unwrap();
    // The browser sets the prop; the server doesn't guess it from the spread.
    assert!(output.contains("<b>new</b>"), "{output}");
    assert!(!output.contains("from spread"), "{output}");
}

#[test]
fn a_spread_prop_is_type_checked_like_a_written_one() {
    let error = html(&parent(r#"{ count: "three" }"#, "")).unwrap_err();
    assert!(
        error.message.contains("prop `count` must be"),
        "{}",
        error.message
    );
}

#[test]
fn kebab_case_keys_name_props_too_and_null_is_the_default() {
    let source = "<script>\n  import './chip.zb'\n  const rest = { \"is-open\": true, count: null }\n</script>\n<zb-page><zb-chip {...rest}></zb-chip></zb-page>";
    let chip = "<zb-chip is-open={false} count={7}><p>{isOpen} {count}</p></zb-chip>";
    let output = compile_html_with(source, "page.zb", "{}", "{}", &|_: &str, _: &str| {
        Ok(("chip.zb".to_owned(), chip.to_owned()))
    })
    .unwrap();
    assert!(output.contains("<p>true 7</p>"), "{output}");
}

#[test]
fn a_spread_known_only_in_the_browser_names_the_props_for_the_binder() {
    let source = "<script>\n  import './badge.zb'\n  function rest() { return { label: \"x\" } }\n</script>\n<zb-page><zb-badge class=\"a\" {...rest()}></zb-badge></zb-page>";
    let output = compile_js_with(source, "page.zb", "@zubra/runtime", None, &loader).unwrap();
    assert!(
        output.contains(
            r#"spread: () => (rest()), own: ["class"], props: ["count", "label"], bind: $spread"#
        ),
        "{output}"
    );
    // The server leaves it to the browser: the child renders its defaults, with no error for
    // a required prop the spread may carry.
    let output = compile_html_with_options(
        source,
        "page.zb",
        "{}",
        "{}",
        zubra::HtmlOptions {
            slot_source: zubra::SlotSource::Template,
            partial: true,
            pending: Vec::new(),
        },
        &loader,
    )
    .unwrap();
    assert!(output.contains("<b>new</b>"), "{output}");
}
