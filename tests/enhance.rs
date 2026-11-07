//! 2.7's progressive enhancement: `<select value>` and `<textarea value>` in HTML output, the
//! `.submit` and `.mod` modifiers, `:bind` on child elements, and `hydrated()`.

use mnx_compiler::{compile, compile_js};

fn html(source: &str) -> String {
    compile(source, "{}").unwrap_or_else(|error| panic!("{}", error.message))
}

#[allow(dead_code)]
fn js(source: &str) -> String {
    compile_js(source, "@mnx/runtime", "x.mnx").unwrap_or_else(|error| panic!("{}", error.message))
}

#[test]
fn a_selects_value_marks_its_option_and_a_textareas_value_is_its_content() {
    let output = html(
        r#"<mnx-x status="pending" note="a < b">
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
</mnx-x>"#,
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
    let js = compile_js(source, "@mnx/runtime", "x.mnx")
        .err()
        .map(|error| format!("{} {}", error.message, error.help.unwrap_or_default()));
    html.or(js)
        .unwrap_or_else(|| panic!("expected an error for {source}"))
}

#[test]
fn submit_and_mod_modifiers() {
    let output = js(r#"<mnx-x>
  <form><select onchange.submit></select><textarea onkeydown.mod.enter.prevent.submit={() => {}}></textarea></form>
</mnx-x>"#);
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
    let page = html(r#"<mnx-x><select onchange.submit></select></mnx-x>"#);
    assert!(page.contains("<select></select>"), "{page}");
    assert!(
        error(r#"<mnx-x><input onkeydown.mod.ctrl.enter={() => {}}></mnx-x>"#)
            .contains("`.mod` already means Ctrl")
    );
    // Without .submit, an event attribute still needs a handler.
    assert!(
        error(r#"<mnx-x><select onchange.prevent></select></mnx-x>"#)
            .contains("inline event-handler attributes are not allowed")
    );
}

#[test]
fn hydrated_is_false_on_the_server_and_a_signal_in_the_template() {
    let source = r#"<script>
  import { hydrated } from '@mnx/runtime'
  const live = hydrated()
</script>
<mnx-x>
  <mnx-if test={!live}><button>Apply</button></mnx-if>
  <p class:on={live}>{live ? "live" : "static"}</p>
</mnx-x>"#;
    let page = html(source);
    assert!(
        page.contains("<button>Apply</button>")
            && page.contains("<p>static</p>")
            && !page.contains("[?"),
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
    let output = js(r#"<mnx-x color="red">
  <other-thing value:bind={color}></other-thing>
</mnx-x>"#);
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
    assert!(error(r#"<mnx-x v=""><input value:bind={v}></mnx-x>"#)
        .contains("a native <input> has none"));
    assert!(
        error(r#"<mnx-x v=""><other-thing value:bind={v + 1}></other-thing></mnx-x>"#)
            .contains("takes a `let` or a prop")
    );
}

#[test]
fn a_known_first_operand_decides_and_and_or_on_the_server() {
    let source = r#"<script>
  import { hydrated } from '@mnx/runtime'
  const live = hydrated()
  let text = ""
</script>
<mnx-x>
  <button class="a" disabled={live && text.trim() === ""}>a</button>
  <button class="b" disabled={!live || text.trim() === ""}>b</button>
  <button class="c" disabled={text.trim() === "" && live}>c</button>
</mnx-x>"#;
    let page = mnx_compiler::compile_html_with_options(
        source,
        "x.mnx",
        "{}",
        "{}",
        mnx_compiler::HtmlOptions {
            slot_source: mnx_compiler::SlotSource::Template,
            partial: true,
        },
        &mnx_compiler::filesystem,
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
