//! 2.7's progressive enhancement: `<select value>` and `<textarea value>` in HTML output, the
//! `.submit` and `.mod` modifiers, `:bind` on child elements, and `hydrated()`.

use zubra::{compile, compile_js};

fn html(source: &str) -> String {
    compile(source, "{}").unwrap_or_else(|error| panic!("{}", error.message))
}

#[allow(dead_code)]
fn js(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "x.zb").unwrap_or_else(|error| panic!("{}", error.message))
}

#[test]
fn a_selects_value_marks_its_option_and_a_textareas_value_is_its_content() {
    let output = html(
        r#"<zb-x status="pending" note="a < b">
  <select name="s" value={status}>
    <option value="open" selected>Open</option>
    <optgroup label="Later"><option value="pending">Pending</option></optgroup>
    <option>solved</option>
  </select>
  <select value="solved"><option>open</option><option>
    solved
  </option></select>
  <select value={"none"}><option value="a">A</option></select>
  <textarea name="n" value={note}></textarea>
</zb-x>"#,
    );
    assert!(output.contains(r#"<select name="s">"#), "{output}");
    assert!(
        output.contains(r#"<option value="open">Open</option>"#),
        "an authored `selected` gives way to the value: {output}"
    );
    assert!(
        output.contains(r#"<option value="pending" selected>Pending</option>"#),
        "{output}"
    );
    assert!(
        output.contains("<option selected>\n    solved\n  </option>"),
        "matched by its text: {output}"
    );
    assert!(
        output.contains(r#"<option value="a">A</option>"#),
        "no match, nothing selected: {output}"
    );
    assert!(
        output.contains(r#"<textarea name="n">a &lt; b</textarea>"#),
        "{output}"
    );
    assert!(
        !output.contains("value=\"pending\"><") && !output.contains("<textarea name=\"n\" value"),
        "{output}"
    );
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
fn submit_and_mod_modifiers() {
    let output = js(r#"<zb-x>
  <form><select onchange.submit></select><textarea onkeydown.mod.enter.prevent.submit={() => {}}></textarea></form>
</zb-x>"#);
    assert!(
        output.contains(r#"on: "change", handler: () => null, modifiers: { submit: true }"#),
        "{output}"
    );
    assert!(
        output
            .contains(r#"modifiers: { prevent: true, mod: true, submit: true, keys: ["Enter"] }"#),
        "{output}"
    );
    // Nothing of them in the HTML.
    let page = html(r#"<zb-x><select onchange.submit></select></zb-x>"#);
    assert!(page.contains("<select></select>"), "{page}");
    assert!(
        error(r#"<zb-x><input onkeydown.mod.ctrl.enter={() => {}}></zb-x>"#)
            .contains("`.mod` already means Ctrl")
    );
    // Without .submit, an event attribute still needs a handler.
    assert!(error(r#"<zb-x><select onchange.prevent></select></zb-x>"#)
        .contains("inline event-handler attributes are not allowed"));
}

#[test]
fn hydrated_is_false_on_the_server_and_a_signal_in_the_template() {
    let source = r#"<script>
  import { hydrated } from '@zubra/runtime'
  const live = hydrated()
</script>
<zb-x>
  <zb-if test={!live}><button>Apply</button></zb-if>
  <p class:on={live}>{live ? "live" : "static"}</p>
</zb-x>"#;
    let page = html(source);
    assert!(
        page.contains("<button>Apply</button>")
            && page.contains("<p>static</p>")
            && !page.contains("<?zb [??>"),
        "{page}"
    );
    let output = js(source);
    assert!(
        output.contains("value: () => $r(live)"),
        "read like a value: {output}"
    );
}

#[test]
fn bind_on_a_child_is_the_prop_and_its_change_event() {
    let output = js(r#"<zb-x color="red">
  <other-thing value:bind={color}></other-thing>
</zb-x>"#);
    assert!(
        output.contains(r#"prop: "value", value: () => $p.color"#),
        "{output}"
    );
    assert!(
        output.contains(
            r#"on: "valuechange", handler: () => ((event) => ($p.color = event.detail))"#
        ),
        "{output}"
    );
    assert!(
        error(r#"<zb-x v=""><input value:bind={v}></zb-x>"#).contains("a native <input> has none")
    );
    assert!(
        error(r#"<zb-x v=""><other-thing value:bind={v + 1}></other-thing></zb-x>"#)
            .contains("takes a `let` or a prop")
    );
}

#[test]
fn a_known_first_operand_decides_and_and_or_on_the_server() {
    let source = r#"<script>
  import { hydrated } from '@zubra/runtime'
  const live = hydrated()
  let text = ""
</script>
<zb-x>
  <button class="a" disabled={live && text.trim() === ""}>a</button>
  <button class="b" disabled={!live || text.trim() === ""}>b</button>
  <button class="c" disabled={text.trim() === "" && live}>c</button>
</zb-x>"#;
    let page = zubra::compile_html_with_options(
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
    assert!(
        page.contains(r#"<button class="a">a</button>"#),
        "false && …: {page}"
    );
    assert!(
        page.contains(r#"<button class="b" disabled>b</button>"#),
        "!false || …: {page}"
    );
    assert!(
        page.contains(r#"<button class="c">c</button>"#),
        "a runtime first operand is left for the browser: {page}"
    );
}
