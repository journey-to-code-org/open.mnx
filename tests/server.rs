//! 2.8: what servers need from the compiler (the interface emit) and `host-reset`.

#[test]
fn host_reset_starts_the_host_from_nothing_and_makes_its_rules_win() {
    let css = zubra::compile_css(
        "<style>\n  :host { display: block; color: red !important }\n  :host(.on) { color: blue; }\n  p { color: green; }\n</style>\n<x-w shadow host-reset><p>x</p></x-w>\n",
    )
    .unwrap();
    assert!(css.contains(":host { all: initial !important; }"), "{css}");
    assert!(
        css.contains(":host { display: block !important; color: red !important }"),
        "{css}"
    );
    assert!(
        css.contains(":host(.on) { color: blue !important; }"),
        "{css}"
    );
    assert!(
        css.contains("p { color: green; }"),
        "only the host's rules: {css}"
    );
    // Without a <style>, just the reset.
    let css = zubra::compile_css("<x-w shadow host-reset><p>x</p></x-w>").unwrap();
    assert!(css.contains(":host { all: initial !important; }"), "{css}");
    let error = zubra::compile_css("<x-w host-reset><p>x</p></x-w>").unwrap_err();
    assert!(
        error.message.contains("add `shadow` too"),
        "{}",
        error.message
    );
}

#[test]
fn the_interface_says_what_a_server_needs_to_read_a_host_back() {
    let json: serde_json::Value = serde_json::from_str(
        &zubra::compile_interface("<x-s shadow form-associated value:model={1} label=\"n\" items={[]}><p>{value}</p></x-s>").unwrap(),
    )
    .unwrap();
    assert_eq!(json["tag"], "x-s");
    assert_eq!(json["shadow"], true);
    assert_eq!(json["form"], true);
    assert_eq!(
        json["props"][0],
        serde_json::json!({ "name": "value", "attribute": "value", "type": "number", "default": 1, "model": true, "required": false })
    );
    assert_eq!(json["props"][2]["default"], serde_json::json!([]));
    assert_eq!(json["events"], serde_json::json!(["valuechange"]));
}

#[test]
fn a_pending_prop_renders_as_an_empty_region_for_a_stream_to_fill() {
    let source = "<x-reviews reviews={[]}><h2>R</h2><zb-await value={reviews}><p>…</p><zb-then as=\"l\"><ul><zb-each items={l} as=\"r\" key={r}><li>{r}</li></zb-each></ul></zb-then></zb-await></x-reviews>";
    let options = |pending: Vec<String>| zubra::HtmlOptions {
        slot_source: zubra::SlotSource::Html,
        partial: false,
        pending,
    };
    let shell = zubra::compile_html_with_options(
        source,
        "x.zb",
        "{}",
        "{}",
        options(vec!["reviews".into()]),
        &zubra::filesystem,
    )
    .unwrap();
    assert!(shell.contains("<!--[?--><p>…</p><!--]-->"), "{shell}");
    assert!(
        !shell.contains("reviews=\""),
        "no attribute for a value not known yet: {shell}"
    );
    let resolved = zubra::compile_html_with_options(
        source,
        "x.zb",
        "{\"reviews\":[\"a\"]}",
        "{}",
        options(vec![]),
        &zubra::filesystem,
    )
    .unwrap();
    assert!(
        resolved.contains("<!--[--><ul><!--[--><!--[--><li>a</li><!--]--><!--]--></ul><!--]-->"),
        "{resolved}"
    );
    // A pending prop with a value given keeps it unknown (the stream renders again once it has it).
    let still = zubra::compile_html_with_options(
        source,
        "x.zb",
        "{\"reviews\":[\"a\"]}",
        "{}",
        options(vec!["reviews".into()]),
        &zubra::filesystem,
    )
    .unwrap();
    assert_eq!(still, shell);
}
