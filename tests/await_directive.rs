//! `<zb-await>`: pending content, then `zb-then` / `zb-catch`.

use zubra::{compile, compile_js};

#[test]
fn renders_the_pending_content_and_emits_three_blocks() {
    let source = "<script>const data = fetch('/x')</script>\n<zb-x label=\"x\"><zb-await value={data}><p>{label}…</p><zb-then as=\"user\"><b>{user.name}</b></zb-then><zb-catch as=\"e\"><i>{e.message}</i></zb-catch></zb-await></zb-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-x><?zb [??><p>x…</p><?zb ]?></zb-x>"
    );
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(js.contains(r#"await: () => $r(data), blocks: [{ template: "<p></p>", parts: () => [{ path: [0], text: () => $t($p.label) + "…" }] }, { template: "<b></b>", parts: (user) => [{ path: [0], text: () => $t($r(user).name) }] }, { template: "<i></i>", parts: (e, retry) => [{ path: [0], text: () => $t($r(e).message) }] }]"#), "{js}");
    let without = compile_js(
        "<zb-x v={1}><zb-await value={v}><zb-then><b>ok</b></zb-then></zb-await></zb-x>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap();
    assert!(without.contains(r#"blocks: [{ template: "", parts: () => [] }, { template: "<b>ok</b>", parts: ($value) => [] }, null]"#), "{without}");
}

#[test]
fn names_are_scoped_to_their_branch_and_the_shape_is_checked() {
    let error = |source: &str| {
        compile_js(source, "@zubra/runtime", "x.zb")
            .unwrap_err()
            .message
    };
    assert_eq!(
        error("<zb-x v={1}><zb-await value={v}><p>{user}</p><zb-then as=\"user\"></zb-then></zb-await></zb-x>"),
        "unknown reference `user`"
    );
    assert!(error(
        "<zb-x v={1}><zb-await value={v}><zb-then></zb-then><zb-then></zb-then></zb-await></zb-x>"
    )
    .contains("only one zb-then"));
    assert!(error(
        "<zb-x v={1}><zb-await value={v}><zb-then></zb-then><p>late</p></zb-await></zb-x>"
    )
    .contains("pending content comes first"));
    assert!(error("<zb-x><zb-then></zb-then></zb-x>")
        .contains("zb-then is only valid as a direct child of zb-await"));
    assert!(error(
        "<zb-x v={1}><zb-await value={v}><zb-catch as=\"1x\"></zb-catch></zb-await></zb-x>"
    )
    .contains("valid identifier"));
    assert!(error("<zb-x><zb-await><p></p></zb-await></zb-x>").contains("value"));
}

#[test]
fn a_value_known_at_build_time_renders_zb_then() {
    assert_eq!(
        compile("<zb-x user={{ name: \"Ada\" }}><zb-await value={user}><p>…</p><zb-then as=\"u\"><b>{u.name}</b></zb-then></zb-await></zb-x>", "{}").unwrap(),
        "<zb-x><?zb [?><b>Ada</b><?zb ]?></zb-x>"
    );
    assert_eq!(
        compile("<zb-x user={{ name: \"Ada\" }}><zb-await value={user}><p>…</p><zb-then as=\"u\"><b>{u.name}</b></zb-then></zb-await></zb-x>", r#"{"user":{"name":"Grace"}}"#).unwrap(),
        "<zb-x user=\"{&quot;name&quot;:&quot;Grace&quot;}\"><?zb [?><b>Grace</b><?zb ]?></zb-x>"
    );
}

#[test]
fn named_pending_shorthand_patterns_delay_and_keep() {
    // `<zb-pending>` and pending content written straight inside are the same thing.
    let named = compile_js("<zb-x data={null}>\n  <zb-await {data} delay={150} keep><zb-pending><p>…</p></zb-pending><zb-then as=\"{ name, tags: [first] }\"><b>{name} {first}</b></zb-then><zb-catch as=\"e\"><button onclick={retry}>{e.message}</button></zb-catch></zb-await>\n</zb-x>", "@zubra/runtime", "x.zb").unwrap();
    assert!(
        named.contains("await: () => $p.data, blocks: [{ template: \"<p>…</p>\""),
        "{named}"
    );
    assert!(named.contains("parts: ($b0_0) => [{ path: [0], text: () => $t($r($b0_0).name) + \" \" + $t($r($b0_0).tags[0]) }]"), "{named}");
    assert!(
        named.contains(
            "parts: (e, retry) => [{ path: [0], on: \"click\", handler: () => $r(retry) }"
        ),
        "{named}"
    );
    assert!(named.contains("delay: () => 150, keep: true"), "{named}");
    // A value known at build time renders zb-then, destructured.
    let html = compile("<zb-x>\n  <zb-await value={{ name: \"Ada\", tags: [\"x\"] }}><zb-pending>…</zb-pending><zb-then as=\"{ name, tags: [first] }\">{name}/{first}</zb-then></zb-await>\n</zb-x>", "{}").unwrap();
    assert!(html.contains("<?zb [?><?zb ?>Ada/x<?zb ]?>"), "{html}");
    let rows = compile("<zb-x>\n  <zb-each items={[{ id: 1, at: { city: \"Oslo\" } }]} as=\"{ id, at: { city } }\" index=\"i\" key={id}><i>{i}{id}{city}</i></zb-each>\n</zb-x>", "{}").unwrap();
    assert!(rows.contains("<i>01Oslo</i>"), "{rows}");
}

#[test]
fn await_and_pattern_errors_say_what_to_write() {
    for (source, message) in [
        ("<zb-x d={1}>\n  <zb-await value={d}><p>x</p><zb-pending>y</zb-pending></zb-await>\n</zb-x>", "one <zb-pending>, first"),
        ("<zb-x d={1}>\n  <zb-await value={d}><zb-pending>y</zb-pending><p>x</p></zb-await>\n</zb-x>", "the pending content goes inside it"),
        ("<zb-x d={1}>\n  <zb-pending>y</zb-pending>\n</zb-x>", "only valid as the first child of zb-await"),
        ("<zb-x d={1}>\n  <zb-await value={d} keep=\"yes\"><zb-then>x</zb-then></zb-await>\n</zb-x>", "`keep` takes no value"),
        ("<zb-x d={1}>\n  <zb-await value={d}><zb-then as=\"{ a = 1 }\">{a}</zb-then></zb-await>\n</zb-x>", "a default"),
        ("<zb-x d={[1]}>\n  <zb-each items={d} as=\"[a, ...rest]\">{a}</zb-each>\n</zb-x>", "a rest element"),
        ("<zb-x d={[1]}>\n  <zb-each items={d} as=\"{ a }\" index=\"a\">{a}</zb-each>\n</zb-x>", "different from `as` and the names it binds"),
        ("<zb-x d={1}>\n  <zb-await value={d}><zb-then as=\"v\"><button onclick={retry}>r</button></zb-then></zb-await>\n</zb-x>", "retry"),
    ] {
        let rendered = match compile_js(source, "@zubra/runtime", "x.zb") {
            Ok(js) => panic!("expected an error for {source}\n{js}"),
            Err(error) => error.render_in(source, "x.zb"),
        };
        assert!(rendered.contains(message), "{source}\n{rendered}");
    }
}
