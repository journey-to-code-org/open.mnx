//! 2.2's template sugar: class and style directives, event modifiers, ref, <zb-window> and
//! <zb-document>, and <zb-else-if>.

use zubra::{compile, compile_js};

fn html(source: &str) -> String {
    compile(source, "{}").unwrap_or_else(|error| panic!("{}", error.message))
}

fn js(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "x.zb").unwrap_or_else(|error| panic!("{}", error.message))
}

fn error(source: &str) -> String {
    let html = compile(source, "{}")
        .err()
        .map(|error| format!("{} {}", error.message, error.help.unwrap_or_default()));
    let js = compile_js(source, "@zubra/runtime", "x.zb")
        .err()
        .map(|error| format!("{} {}", error.message, error.help.unwrap_or_default()));
    html.or(js)
        .unwrap_or_else(|| panic!("expected an error for {source}"))
}

#[test]
fn class_and_style_directives_render_merged_and_bind_one_by_one() {
    let source = r#"<zb-x on={true} off={false} size={12} tone="red">
  <p class="base" class:on class:off class:big={size > 10} style="margin: 0" style:font-size={size + "px"} style:--tone={tone} style:color={null}>x</p>
  <span class={{ a: on, b: off }} style={{ backgroundColor: tone, "--gap": size }}>y</span>
</zb-x>"#;
    let out = html(source);
    assert!(
        out.contains(
            r#"<p class="base on big" style="margin: 0; font-size: 12px; --tone: red">x</p>"#
        ),
        "{out}"
    );
    assert!(
        out.contains(r#"<span class="a" style="background-color: red; --gap: 12">y</span>"#),
        "{out}"
    );
    let code = js(source);
    for part in [
        r#"{ path: [0], toggle: "on", value: () => $p.on }"#,
        r#"{ path: [0], toggle: "big", value: () => ($p.size > 10) }"#,
        r#"{ path: [0], style: "font-size", value: () => ($p.size + "px") }"#,
        r#"{ path: [0], style: "--tone", value: () => $p.tone }"#,
        r#"{ path: [1], toggle: "a", value: () => $p.on }"#,
        r#"{ path: [1], style: "background-color", value: () => $p.tone }"#,
    ] {
        assert!(code.contains(part), "{part}\n{code}");
    }
    assert!(
        code.contains(r#"<p class=\"base\" style=\"margin: 0\">x</p>"#),
        "static parts stay in the template: {code}"
    );
}

#[test]
fn a_computed_class_beside_toggles_is_bound_token_by_token() {
    let source = r#"<zb-x tone="t1" on={true}><p class="base {tone}" class:on>x</p><i class={tone}>y</i></zb-x>"#;
    let out = html(source);
    assert!(out.contains(r#"<p class="base t1 on">x</p>"#), "{out}");
    let code = js(source);
    assert!(
        code.contains(r#"{ path: [0], classes: () => "base " + $t($p.tone) }"#),
        "{code}"
    );
    assert!(
        code.contains(r#"{ path: [1], attribute: "class", value: () => $p.tone }"#),
        "without toggles it's an attribute: {code}"
    );
}

#[test]
fn style_values_that_could_add_css_are_refused_on_the_server() {
    for value in [
        "red; background: blue",
        "url(https://x.test/a.png)",
        "a { b",
        "x\\\\61",
    ] {
        let message = error(&format!(
            "<zb-x tone={{{}}}><p style:color={{tone}}>x</p></zb-x>",
            serde_json_string(value)
        ));
        assert!(
            message.contains("isn't a single CSS value"),
            "{value}: {message}"
        );
    }
}

fn serde_json_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[test]
fn directive_mistakes_are_explained() {
    for (source, expected) in [
        (
            r#"<zb-x c="a"><p style="color: {c}">x</p></zb-x>"#,
            "can't interpolate",
        ),
        (r#"<zb-x c="a"><p style={c}>x</p></zb-x>"#, "object literal"),
        (
            r#"<zb-x><p class:on="yes">x</p></zb-x>"#,
            "takes an expression",
        ),
        (r#"<zb-x><p style:Color={1}>x</p></zb-x>"#, "CSS property"),
        (r#"<zb-x><p style:--a>x</p></zb-x>"#, "isn't a valid name"),
        (
            r#"<script>const f = () => 1</script><zb-x><p onclick.prevnt={f}>x</p></zb-x>"#,
            "did you mean `.prevent`",
        ),
        (
            r#"<script>const f = () => 1</script><zb-x><p onclick.enter={f}>x</p></zb-x>"#,
            "only goes on keydown",
        ),
        (
            r#"<script>const f = () => 1</script><zb-x><p onwheel.passive.prevent={f}>x</p></zb-x>"#,
            "contradict",
        ),
        (r#"<zb-x><p ref="x">x</p></zb-x>"#, "ref takes a `let`"),
        (
            r#"<zb-x><zb-window title="x"></zb-window></zb-x>"#,
            "event listeners only",
        ),
        (
            r#"<script>const f = () => 1</script><zb-x><zb-document onkeydown={f}><p>x</p></zb-document></zb-x>"#,
            "can't have content",
        ),
        (
            r#"<zb-x a={true}><zb-if test={a}>A<zb-else>B</zb-else><zb-else-if test={a}>C</zb-else-if></zb-if></zb-x>"#,
            "must come before zb-else",
        ),
    ] {
        let message = error(source);
        assert!(
            message.contains(expected),
            "{source}\nexpected `{expected}` in: {message}"
        );
    }
}

#[test]
fn modifiers_compile_to_listener_options_and_checks() {
    let code = js(r#"<script>const f = () => 1</script><zb-x>
  <form onsubmit.prevent.stop={f}><input onkeydown.ctrl.shift.enter={f} onkeyup.a.b={f}></form>
  <div onclick.self.once.capture={f} onscroll.passive={f}></div>
</zb-x>"#);
    for part in [
        r#"on: "submit", handler: () => $r(f), modifiers: { prevent: true, stop: true }"#,
        r#"on: "keydown", handler: () => $r(f), modifiers: { shift: true, ctrl: true, keys: ["Enter"] }"#,
        r#"on: "keyup", handler: () => $r(f), modifiers: { keys: ["a", "b"] }"#,
        r#"on: "click", handler: () => $r(f), modifiers: { once: true, self: true, capture: true }"#,
        r#"on: "scroll", handler: () => $r(f), modifiers: { passive: true }"#,
    ] {
        assert!(code.contains(part), "{part}\n{code}");
    }
    // Listeners exist only in the browser.
    let out = html(
        r#"<script>const f = () => 1</script><zb-x><form onsubmit.prevent={f}></form></zb-x>"#,
    );
    assert!(out.contains("<form></form>"), "{out}");
}

#[test]
fn ref_global_listeners_and_else_if() {
    let source = r#"<script>
  let box = null
  let mode = "b"
  const key = () => 1
</script>
<zb-x>
  <zb-window onresize={key}></zb-window>
  <div ref={box}></div>
  <zb-if test={mode === "a"}>A<zb-else-if test={mode === "b"}>B</zb-else-if><zb-else-if test={mode === "c"}>C</zb-else-if><zb-else>D</zb-else></zb-if>
</zb-x>"#;
    let out = html(source);
    assert!(
        out.contains("<!---->\n  <div></div>\n  <!--[--><!--[-->B<!--]--><!--]-->"),
        "{out}"
    );
    let code = js(source);
    assert!(
        code.contains(r#"{ path: [0], global: "window", on: "resize", handler: () => $r(key) }"#),
        "{code}"
    );
    assert!(
        code.contains(r#"{ path: [1], ref: () => (($el) => (__zubraAssign(box, $el))) }"#),
        "{code}"
    );
}
