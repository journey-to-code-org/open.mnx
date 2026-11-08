//! JavaScript beyond the build-time subset in templates: calls, arrow functions, handlers.

use mnx_compiler::{compile, compile_js};

const SOURCE: &str = r#"<script>
  import { state, emit } from "@mnx/runtime"
  const count = state(0)
  const format = (n) => `#${n}`
</script>
<mnx-x items={[1, 2, 3]} min={1} stamp={Date.now()}>
  <p>{format(count.get())} {items.filter((item) => item > min).length} {Math.max(min, 2)}</p>
  <button onclick={() => count.set(count.get() + 1)}>+</button>
  <mnx-each items={items.map((item) => ({ item }))} as="row">
    <i onclick={() => emit("pick", row.item)}>{row.item.toFixed(1)}</i>
  </mnx-each>
</mnx-x>"#;

#[test]
fn compiles_to_script_code_with_props_and_rows_mapped() {
    let js = compile_js(SOURCE, "@mnx/runtime", "x.mnx").unwrap();
    assert!(js.contains(r#"text: () => $t((format(count.get()))) + " " + $t(($p.items.filter((item) => item > $p.min).length)) + " " + $t((Math.max($p.min, 2)))"#), "{js}");
    assert!(
        js.contains("handler: () => (() => count.set(count.get() + 1))"),
        "{js}"
    );
    assert!(
        js.contains("each: () => ($p.items.map((item) => ({ item })))"),
        "{js}"
    );
    assert!(
        js.contains(r#"handler: () => (() => emit("pick", $r(row).item))"#),
        "{js}"
    );
    assert!(
        js.contains("events: [\"pick\"]"),
        "emit() in the template declares the event: {js}"
    );
    assert!(
        js.contains(r#"$initial("stamp", () => (Date.now()));"#),
        "{js}"
    );
}

#[test]
fn static_html_reports_them_as_browser_only() {
    let error = compile(SOURCE, "{}").unwrap_err();
    assert!(
        error.message.contains(
            "the default for prop `stamp` uses `Date.now()`, which only exists at runtime"
        ),
        "{}",
        error.message
    );
    let error = compile(
        r#"<mnx-x items={[1]}><p>{items.toLocaleString()}</p></mnx-x>"#,
        "{}",
    )
    .unwrap_err();
    assert!(
        error.message.contains("runs in the browser only"),
        "{}",
        error.message
    );
    // Handlers aren't rendered, so an inline one doesn't stop static HTML.
    assert_eq!(
        compile(
            r#"<mnx-x a={1}><button onclick={() => { a = 2 }}>x</button></mnx-x>"#,
            "{}"
        )
        .unwrap(),
        "<mnx-x><button>x</button></mnx-x>"
    );
}

#[test]
fn names_are_checked_and_only_props_can_be_assigned() {
    let unknown =
        compile_js("<mnx-x><p>{formt(1)}</p></mnx-x>", "@mnx/runtime", "x.mnx").unwrap_err();
    assert_eq!(unknown.message, "unknown reference `formt`");
    // State (a `let`) and props can be assigned; other script names can't.
    let state = compile_js(
        "<script>let total = 0</script>\n<mnx-x><button onclick={() => total++}>{total}</button></mnx-x>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap();
    assert!(
        state.contains("handler: () => (() => __mnxUpdate(total, 1, false))"),
        "{state}"
    );
    let local = compile_js(
        "<script>const total = 0</script>\n<mnx-x><button onclick={() => total++}>x</button></mnx-x>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap_err();
    assert_eq!(
        local.message,
        "`total` can't be assigned here: a template can assign props and state (a `let`) only"
    );
    let row = compile_js(
        "<mnx-x items={[1]}><mnx-each items={items} as=\"item\"><b onclick={() => { item = 2 }}>x</b></mnx-each></mnx-x>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap_err();
    assert_eq!(
        row.help.as_deref(),
        Some("a list item is read-only; change the list instead")
    );
    // Names local to the expression are its own.
    assert!(compile_js(
        "<mnx-x items={[1]}><p>{items.map((value) => value * 2).join()}</p></mnx-x>",
        "@mnx/runtime",
        "x.mnx"
    )
    .is_ok());
}

#[test]
fn the_subset_still_comes_first_and_v02_syntax_is_still_caught() {
    let js = compile_js(
        "<mnx-x a={1}><p>{a + 1}</p></mnx-x>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap();
    assert!(js.contains("text: () => $t(($p.a + 1))"), "{js}");
    let error = compile_js(
        "<mnx-x a={1}><p>{{ a }}</p></mnx-x>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap_err();
    assert!(error.message.contains("v0.2 syntax"), "{}", error.message);
    let error =
        compile_js("<mnx-x a={1}><p>{a +}</p></mnx-x>", "@mnx/runtime", "x.mnx").unwrap_err();
    assert!(!error.message.is_empty());
}

#[test]
fn partial_html_leaves_browser_only_parts_to_the_element() {
    use mnx_compiler::{compile_html_with_options, HtmlOptions, SlotSource};
    let partial = |source: &str, props: &str| {
        let loader = |_: &str, _: &str| -> Result<(String, String), String> { Err("none".into()) };
        compile_html_with_options(
            source,
            "x.mnx",
            props,
            "{}",
            HtmlOptions {
                slot_source: SlotSource::Template,
                partial: true,
                pending: Vec::new(),
            },
            &loader,
        )
    };
    assert_eq!(
        partial(SOURCE, "{}").unwrap(),
        "<mnx-x>\n  <p></p>\n  <button>+</button>\n  <!--[--><!--[-->\n    <i>1.0</i>\n  <!--]--><!--[-->\n    <i>2.0</i>\n  <!--]--><!--[-->\n    <i>3.0</i>\n  <!--]--><!--]-->\n</mnx-x>",
        "the text and the browser-computed default are left out; the list's map and toFixed render"
    );
    assert_eq!(
        partial(SOURCE, r#"{"stamp":5,"min":2}"#).unwrap(),
        "<mnx-x min=\"2\" stamp=\"5\">\n  <p></p>\n  <button>+</button>\n  <!--[--><!--[-->\n    <i>1.0</i>\n  <!--]--><!--[-->\n    <i>2.0</i>\n  <!--]--><!--[-->\n    <i>3.0</i>\n  <!--]--><!--]-->\n</mnx-x>"
    );
    assert_eq!(
        partial("<script>const now = Date.now()</script>\n<mnx-x a=\"x\"><p title={now} class=\"c {now}\">{a}</p><mnx-if test={now > 0}><b>later</b></mnx-if></mnx-x>", "{}").unwrap(),
        "<mnx-x><p>x</p><!--[?--><!--]--></mnx-x>"
    );
    // Everything else is still checked.
    assert!(partial("<mnx-x><p>{nope()}</p></mnx-x>", "{}").is_err());
}
