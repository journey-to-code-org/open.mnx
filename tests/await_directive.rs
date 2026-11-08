//! `<zb-await>`: pending content, then `zb-then` / `zb-catch`.

use zubra::{compile, compile_js};

#[test]
fn renders_the_pending_content_and_emits_three_blocks() {
    let source = "<script>const data = fetch('/x')</script>\n<zb-x label=\"x\"><zb-await value={data}><p>{label}…</p><zb-then as=\"user\"><b>{user.name}</b></zb-then><zb-catch as=\"e\"><i>{e.message}</i></zb-catch></zb-await></zb-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-x><!--[?--><p>x…</p><!--]--></zb-x>"
    );
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(js.contains(r#"await: () => $r(data), blocks: [{ template: "<p></p>", parts: () => [{ path: [0], text: () => $t($p.label) + "…" }] }, { template: "<b></b>", parts: (user) => [{ path: [0], text: () => $t($r(user).name) }] }, { template: "<i></i>", parts: (e) => [{ path: [0], text: () => $t($r(e).message) }] }]"#), "{js}");
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
        "<zb-x><!--[--><b>Ada</b><!--]--></zb-x>"
    );
    assert_eq!(
        compile("<zb-x user={{ name: \"Ada\" }}><zb-await value={user}><p>…</p><zb-then as=\"u\"><b>{u.name}</b></zb-then></zb-await></zb-x>", r#"{"user":{"name":"Grace"}}"#).unwrap(),
        "<zb-x user=\"{&quot;name&quot;:&quot;Grace&quot;}\"><!--[--><b>Grace</b><!--]--></zb-x>"
    );
}
