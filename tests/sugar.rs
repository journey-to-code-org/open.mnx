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

#[test]
fn conditions_as_attributes_compile_to_what_the_wrapper_does() {
    let attributes = r#"<zb-x count={3} ok={true}>
  <p zb-if={count === 0}>Nothing yet.</p>
  <p zb-else-if={count < 5}>A few.</p>
  <ul zb-else><li>Many</li></ul>
  <table><tbody><tr zb-if={ok}><td>a</td></tr></tbody></table>
</zb-x>"#;
    let wrappers = r#"<zb-x count={3} ok={true}>
  <zb-if test={count === 0}><p>Nothing yet.</p><zb-else-if test={count < 5}><p>A few.</p></zb-else-if><zb-else><ul><li>Many</li></ul></zb-else></zb-if>
  <table><tbody><zb-if test={ok}><tr><td>a</td></tr></zb-if></tbody></table>
</zb-x>"#;
    assert_eq!(html(attributes), html(wrappers));
    assert_eq!(js(attributes), js(wrappers));
    // Nested, and inside a list.
    let nested = r#"<zb-x a={true} items={[1, 2]}>
  <p zb-if={a}>A<span zb-if={!a}>never</span></p>
  <zb-each items={items} as="n"><b zb-if={n > 1}>{n}</b><i zb-else>{n}</i></zb-each>
</zb-x>"#;
    assert_eq!(
        html(nested),
        "<zb-x>\n  <!--[--><p>A<!--[--><!--]--></p><!--]-->\n  <!--[--><!--[--><!--[--><i>1</i><!--]--><!--]--><!--[--><!--[--><b>2</b><!--]--><!--]--><!--]-->\n</zb-x>"
    );
}

#[test]
fn condition_attributes_are_checked_and_other_zb_attributes_are_reserved() {
    for (source, message) in [
        (
            "<zb-x a={1}>\n  <p zb-else>x</p>\n</zb-x>",
            "`zb-else` needs an element with `zb-if` or `zb-else-if` just before it",
        ),
        (
            "<zb-x a={1}>\n  <p zb-if={a}>x</p>\n  text\n  <p zb-else-if={a}>y</p>\n</zb-x>",
            "`zb-else-if` needs an element with `zb-if`",
        ),
        (
            "<zb-x a={1}>\n  <p zb-if={a}>x</p><p zb-else>y</p><p zb-else>z</p>\n</zb-x>",
            "only one `zb-else`, and it comes last",
        ),
        (
            "<zb-x a={1}>\n  <p zb-if={a}>x</p><p zb-else>y</p><p zb-else-if={a}>z</p>\n</zb-x>",
            "`zb-else-if` must come before the chain's `zb-else`",
        ),
        (
            "<zb-x a={1}>\n  <zb-each items={[1]} as=\"i\" zb-if={a}><p>{i}</p></zb-each>\n</zb-x>",
            "can't go on <zb-each>, which is a directive",
        ),
        (
            "<zb-x a={1}>\n  <p zb-if=\"a\">x</p>\n</zb-x>",
            "`zb-if` is an expression: write zb-if={…}",
        ),
        (
            "<zb-x a={1}>\n  <p zb-if>x</p>\n</zb-x>",
            "`zb-if` needs a condition",
        ),
        (
            "<zb-x a={1}>\n  <p zb-if={a}>x</p><p zb-else={a}>y</p>\n</zb-x>",
            "`zb-else` takes no value",
        ),
        (
            "<zb-x a={1}>\n  <p zb-if={a} zb-else>x</p>\n</zb-x>",
            "one of zb-if, zb-else-if and zb-else",
        ),
        (
            "<zb-x zb-if={1}>\n  <p>x</p>\n</zb-x>",
            "can't go on the host",
        ),
        (
            "<zb-x zb-size={1}>\n  <p>x</p>\n</zb-x>",
            "a prop can't start with it",
        ),
        (
            "<zb-x a={1}>\n  <p zb-iff={a}>x</p>\n</zb-x>",
            "unknown attribute `zb-iff`: the zb- prefix is reserved",
        ),
    ] {
        let rendered = error(source);
        assert!(rendered.contains(message), "{source}\n{rendered}");
    }
    assert!(error("<zb-x a={1}>\n  <p zb-iff={a}>x</p>\n</zb-x>").contains("did you mean `zb-if`?"));
    // `data-zb-*` is the author's, like any data attribute.
    assert_eq!(
        html("<zb-x>\n  <p data-zb-note=\"1\">x</p>\n</zb-x>"),
        "<zb-x>\n  <p data-zb-note=\"1\">x</p>\n</zb-x>"
    );
}

#[test]
fn markup_in_braces_compiles_to_the_directives() {
    let braces = r#"<zb-x done={true} user={null} items={[{id: 1, label: "a"}, {id: 2, label: "b"}]}>
  {done && <p class="ok">Saved</p>}
  {user ? <b>{user.name}</b> : <a href="/login">Sign in</a>}
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
</zb-x>"#;
    let directives = r#"<zb-x done={true} user={null} items={[{id: 1, label: "a"}, {id: 2, label: "b"}]}>
  <zb-if test={done}><p class="ok">Saved</p></zb-if>
  <zb-if test={user}><b>{user.name}</b><zb-else><a href="/login">Sign in</a></zb-else></zb-if>
  <ul><zb-each items={items} as="item" key={item.id}><li>{item.label}</li></zb-each></ul>
</zb-x>"#;
    assert_eq!(html(braces), html(directives));
    assert_eq!(js(braces), js(directives));
    // Parentheses, an index, text and null branches, nesting, and text that only looks like markup.
    let mixed = r#"<zb-x a={true} n={2} list={["x"]}>
  {a && (
    <p>Don't {n > 1 ? `${n} items` : null}</p>
  )}
  {list.map((x, i) => <i>{i}{x}{a && <b>!</b>}</i>)}
  {"<not markup>"}
</zb-x>"#;
    assert_eq!(
        html(mixed),
        "<zb-x>\n  <!--[--><p>Don't 2 items</p><!--]-->\n  <!--[--><!--[--><i><!---->0x<!--[--><b>!</b><!--]--></i><!--]--><!--]--><!---->\n  &lt;not markup&gt;\n</zb-x>"
    );
}

#[test]
fn markup_in_braces_outside_the_three_forms_says_what_to_write() {
    for (source, message) in [
        (
            "<zb-x f={1}>\n  {f || <p>x</p>}\n</zb-x>",
            "markup in braces takes three forms",
        ),
        (
            "<zb-x a={1}>\n  {a && <p>x</p> && <p>y</p>}\n</zb-x>",
            "the braces hold one element",
        ),
        (
            "<zb-x items={[1]}>\n  {items.map((a, b, c) => <p>{a}</p>)}\n</zb-x>",
            "and optionally its index",
        ),
        (
            "<zb-x a={1}>\n  {a && <p zb-if={a}>x</p>}\n</zb-x>",
            "the braces already decide",
        ),
        (
            "<zb-x a={1}>\n  <p title={a && <b/>}>x</p>\n</zb-x>",
            "markup can't go in an attribute's {…}",
        ),
    ] {
        let rendered = error(source);
        assert!(rendered.contains(message), "{source}\n{rendered}");
    }
}

#[test]
fn let_names_and_switch_render_and_bind() {
    let source = r#"<zb-x cart={[{id: 1, price: 3, qty: 2}, {id: 2, price: 5, qty: 1}]} status="shipped">
  <ul><zb-each items={cart} as="{ id, price, qty }" key={id} let:total={price * qty} let:big={total > 5}><li class:big={big}>{id}: {total}</li></zb-each></ul>
  <zb-switch value={status}>
    <zb-case is="paid"><p>Paid</p></zb-case>
    <zb-case is={["shipped", "delivered"]}><p>On its way</p></zb-case>
    <zb-else><p>Waiting</p></zb-else>
  </zb-switch>
</zb-x>"#;
    assert_eq!(
        html(source),
        "<zb-x>\n  <ul><!--[--><!--[--><li class=\"big\">1: 6</li><!--]--><!--[--><li>2: 5</li><!--]--><!--]--></ul>\n  <!--[--><!--[--><p>On its way</p><!--]--><!--]-->\n</zb-x>"
    );
    let code = js(source);
    assert!(
        code.contains(
            r#"text: () => $t($r($b0_0).id) + ": " + $t((($r($b0_0).price * $r($b0_0).qty)))"#
        ),
        "{code}"
    );
    assert!(
        code.contains(r#"when: () => (($p.status === "shipped") || ($p.status === "delivered"))"#),
        "{code}"
    );
    // A switch is the zb-if chain it stands for.
    let chain = r#"<zb-x status="shipped">
  <zb-if test={status === "paid"}><p>Paid</p><zb-else-if test={status === "shipped" || status === "delivered"}><p>On its way</p></zb-else-if><zb-else><p>Waiting</p></zb-else></zb-if>
</zb-x>"#;
    assert_eq!(html(&source.replace(r#"<ul><zb-each items={cart} as="{ id, price, qty }" key={id} let:total={price * qty} let:big={total > 5}><li class:big={big}>{id}: {total}</li></zb-each></ul>
  "#, "")).replace("<zb-x cart", "<zb-x"), html(chain));
}

#[test]
fn let_and_switch_errors_say_what_to_write() {
    for (source, message) in [
        ("<zb-x a={[1]}>\n  <zb-each items={a} as=\"n\" let:d={n * 2}><button onclick={() => (d = 3)}>{d}</button></zb-each>\n</zb-x>", "can't be assigned"),
        ("<zb-x a={1}>\n  <p let:x={a}>{x}</p>\n</zb-x>", "`let:` goes on <zb-each> or <zb-then>"),
        ("<zb-x a={[1]}>\n  <zb-each items={a} as=\"n\" let:d=\"x\">{d}</zb-each>\n</zb-x>", "is an expression"),
        ("<zb-x a={1}>\n  <zb-switch value={a}><p>x</p></zb-switch>\n</zb-x>", "contains <zb-case is={…}> elements"),
        ("<zb-x a={1}>\n  <zb-case is={1}>x</zb-case>\n</zb-x>", "only valid as a child of zb-switch"),
        ("<zb-x a={1}>\n  <zb-switch value={a}><zb-else>x</zb-else><zb-case is={1}>y</zb-case></zb-switch>\n</zb-x>", "can't come after the zb-switch's zb-else"),
        ("<zb-x a={1}>\n  <zb-switch value={a}></zb-switch>\n</zb-x>", "needs at least one"),
        ("<zb-x a={1}>\n  <zb-switch value={a}><zb-case is={[]}>y</zb-case></zb-switch>\n</zb-x>", "never matches"),
    ] {
        let rendered = error(source);
        assert!(rendered.contains(message), "{source}\n{rendered}");
    }
}
