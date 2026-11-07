//! 2.2's template sugar: class and style directives, event modifiers, ref, <mnx-window> and
//! <mnx-document>, and <mnx-else-if>.

use mnx_compiler::{compile, compile_js};

fn html(source: &str) -> String {
    compile(source, "{}").unwrap_or_else(|error| panic!("{}", error.message))
}

fn js(source: &str) -> String {
    compile_js(source, "@mnx/runtime", "x.mnx").unwrap_or_else(|error| panic!("{}", error.message))
}

fn error(source: &str) -> String {
    let html = compile(source, "{}")
        .err()
        .map(|error| format!("{} {}", error.message, error.help.unwrap_or_default()));
    let js = compile_js(source, "@mnx/runtime", "x.mnx")
        .err()
        .map(|error| format!("{} {}", error.message, error.help.unwrap_or_default()));
    html.or(js)
        .unwrap_or_else(|| panic!("expected an error for {source}"))
}

#[test]
fn class_and_style_directives_render_merged_and_bind_one_by_one() {
    let source = r#"<mnx-x on={true} off={false} size={12} tone="red">
  <p class="base" class:on class:off class:big={size > 10} style="margin: 0" style:font-size={size + "px"} style:--tone={tone} style:color={null}>x</p>
  <span class={{ a: on, b: off }} style={{ backgroundColor: tone, "--gap": size }}>y</span>
</mnx-x>"#;
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
    let source = r#"<mnx-x tone="t1" on={true}><p class="base {tone}" class:on>x</p><i class={tone}>y</i></mnx-x>"#;
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
            "<mnx-x tone={{{}}}><p style:color={{tone}}>x</p></mnx-x>",
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
            r#"<mnx-x c="a"><p style="color: {c}">x</p></mnx-x>"#,
            "can't interpolate",
        ),
        (
            r#"<mnx-x c="a"><p style={c}>x</p></mnx-x>"#,
            "object literal",
        ),
        (
            r#"<mnx-x><p class:on="yes">x</p></mnx-x>"#,
            "takes an expression",
        ),
        (r#"<mnx-x><p style:Color={1}>x</p></mnx-x>"#, "CSS property"),
        (r#"<mnx-x><p style:--a>x</p></mnx-x>"#, "isn't a valid name"),
        (
            r#"<script>const f = () => 1</script><mnx-x><p onclick.prevnt={f}>x</p></mnx-x>"#,
            "did you mean `.prevent`",
        ),
        (
            r#"<script>const f = () => 1</script><mnx-x><p onclick.enter={f}>x</p></mnx-x>"#,
            "only goes on keydown",
        ),
        (
            r#"<script>const f = () => 1</script><mnx-x><p onwheel.passive.prevent={f}>x</p></mnx-x>"#,
            "contradict",
        ),
        (r#"<mnx-x><p ref="x">x</p></mnx-x>"#, "ref takes a `let`"),
        (
            r#"<mnx-x><mnx-window title="x"></mnx-window></mnx-x>"#,
            "event listeners only",
        ),
        (
            r#"<script>const f = () => 1</script><mnx-x><mnx-document onkeydown={f}><p>x</p></mnx-document></mnx-x>"#,
            "can't have content",
        ),
        (
            r#"<mnx-x a={true}><mnx-if test={a}>A<mnx-else>B</mnx-else><mnx-else-if test={a}>C</mnx-else-if></mnx-if></mnx-x>"#,
            "must come before mnx-else",
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
    let code = js(r#"<script>const f = () => 1</script><mnx-x>
  <form onsubmit.prevent.stop={f}><input onkeydown.ctrl.shift.enter={f} onkeyup.a.b={f}></form>
  <div onclick.self.once.capture={f} onscroll.passive={f}></div>
</mnx-x>"#);
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
        r#"<script>const f = () => 1</script><mnx-x><form onsubmit.prevent={f}></form></mnx-x>"#,
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
<mnx-x>
  <mnx-window onresize={key}></mnx-window>
  <div ref={box}></div>
  <mnx-if test={mode === "a"}>A<mnx-else-if test={mode === "b"}>B</mnx-else-if><mnx-else-if test={mode === "c"}>C</mnx-else-if><mnx-else>D</mnx-else></mnx-if>
</mnx-x>"#;
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
        code.contains(r#"{ path: [1], ref: () => (($el) => (__mnxAssign(box, $el))) }"#),
        "{code}"
    );
}
