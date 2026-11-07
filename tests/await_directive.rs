//! `<mnx-await>`: pending content, then `mnx-then` / `mnx-catch`.

use mnx_compiler::{compile, compile_js};

#[test]
fn renders_the_pending_content_and_emits_three_blocks() {
    let source = "<script>const data = fetch('/x')</script>\n<mnx-x label=\"x\"><mnx-await value={data}><p>{label}…</p><mnx-then as=\"user\"><b>{user.name}</b></mnx-then><mnx-catch as=\"e\"><i>{e.message}</i></mnx-catch></mnx-await></mnx-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-x><!--[?--><p>x…</p><!--]--></mnx-x>"
    );
    let js = compile_js(source, "@mnx/runtime", "x.mnx").unwrap();
    assert!(js.contains(r#"await: () => $r(data), blocks: [{ template: "<p></p>", parts: () => [{ path: [0], text: () => $t($p.label) + "…" }] }, { template: "<b></b>", parts: (user) => [{ path: [0], text: () => $t($r(user).name) }] }, { template: "<i></i>", parts: (e) => [{ path: [0], text: () => $t($r(e).message) }] }]"#), "{js}");
    let without = compile_js(
        "<mnx-x v={1}><mnx-await value={v}><mnx-then><b>ok</b></mnx-then></mnx-await></mnx-x>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap();
    assert!(without.contains(r#"blocks: [{ template: "", parts: () => [] }, { template: "<b>ok</b>", parts: ($value) => [] }, null]"#), "{without}");
}

#[test]
fn names_are_scoped_to_their_branch_and_the_shape_is_checked() {
    let error = |source: &str| {
        compile_js(source, "@mnx/runtime", "x.mnx")
            .unwrap_err()
            .message
    };
    assert_eq!(
        error("<mnx-x v={1}><mnx-await value={v}><p>{user}</p><mnx-then as=\"user\"></mnx-then></mnx-await></mnx-x>"),
        "unknown reference `user`"
    );
    assert!(error("<mnx-x v={1}><mnx-await value={v}><mnx-then></mnx-then><mnx-then></mnx-then></mnx-await></mnx-x>").contains("only one mnx-then"));
    assert!(error(
        "<mnx-x v={1}><mnx-await value={v}><mnx-then></mnx-then><p>late</p></mnx-await></mnx-x>"
    )
    .contains("pending content comes first"));
    assert!(error("<mnx-x><mnx-then></mnx-then></mnx-x>")
        .contains("mnx-then is only valid as a direct child of mnx-await"));
    assert!(error(
        "<mnx-x v={1}><mnx-await value={v}><mnx-catch as=\"1x\"></mnx-catch></mnx-await></mnx-x>"
    )
    .contains("valid identifier"));
    assert!(error("<mnx-x><mnx-await><p></p></mnx-await></mnx-x>").contains("value"));
}

#[test]
fn a_value_known_at_build_time_renders_mnx_then() {
    assert_eq!(
        compile("<mnx-x user={{ name: \"Ada\" }}><mnx-await value={user}><p>…</p><mnx-then as=\"u\"><b>{u.name}</b></mnx-then></mnx-await></mnx-x>", "{}").unwrap(),
        "<mnx-x><!--[--><b>Ada</b><!--]--></mnx-x>"
    );
    assert_eq!(
        compile("<mnx-x user={{ name: \"Ada\" }}><mnx-await value={user}><p>…</p><mnx-then as=\"u\"><b>{u.name}</b></mnx-then></mnx-await></mnx-x>", r#"{"user":{"name":"Grace"}}"#).unwrap(),
        "<mnx-x user=\"{&quot;name&quot;:&quot;Grace&quot;}\"><!--[--><b>Grace</b><!--]--></mnx-x>"
    );
}
