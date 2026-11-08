//! JavaScript beyond the build-time subset in templates: calls, arrow functions, handlers.

use zubra::{compile, compile_js};

const SOURCE: &str = r#"<script>
  import { state, emit } from "@zubra/runtime"
  const count = state(0)
  const format = (n) => `#${n}`
</script>
<zb-x items={[1, 2, 3]} min={1} stamp={Date.now()}>
  <p>{format(count.get())} {items.filter((item) => item > min).length} {Math.max(min, 2)}</p>
  <button onclick={() => count.set(count.get() + 1)}>+</button>
  <zb-each items={items.map((item) => ({ item }))} as="row">
    <i onclick={() => emit("pick", row.item)}>{row.item.toFixed(1)}</i>
  </zb-each>
</zb-x>"#;

#[test]
fn compiles_to_script_code_with_props_and_rows_mapped() {
    let js = compile_js(SOURCE, "@zubra/runtime", "x.zb").unwrap();
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
        r#"<zb-x items={[1]}><p>{items.toLocaleString()}</p></zb-x>"#,
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
            r#"<zb-x a={1}><button onclick={() => { a = 2 }}>x</button></zb-x>"#,
            "{}"
        )
        .unwrap(),
        "<zb-x><button>x</button></zb-x>"
    );
}

#[test]
fn names_are_checked_and_only_props_can_be_assigned() {
    let unknown =
        compile_js("<zb-x><p>{formt(1)}</p></zb-x>", "@zubra/runtime", "x.zb").unwrap_err();
    assert_eq!(unknown.message, "unknown reference `formt`");
    // State (a `let`) and props can be assigned; other script names can't.
    let state = compile_js(
        "<script>let total = 0</script>\n<zb-x><button onclick={() => total++}>{total}</button></zb-x>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap();
    assert!(
        state.contains("handler: () => (() => __zubraUpdate(total, 1, false))"),
        "{state}"
    );
    let local = compile_js(
        "<script>const total = 0</script>\n<zb-x><button onclick={() => total++}>x</button></zb-x>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert_eq!(
        local.message,
        "`total` can't be assigned here: a template can assign props and state (a `let`) only"
    );
    let row = compile_js(
        "<zb-x items={[1]}><zb-each items={items} as=\"item\"><b onclick={() => { item = 2 }}>x</b></zb-each></zb-x>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert_eq!(
        row.help.as_deref(),
        Some("a list item is read-only; change the list instead")
    );
    // Names local to the expression are its own.
    assert!(compile_js(
        "<zb-x items={[1]}><p>{items.map((value) => value * 2).join()}</p></zb-x>",
        "@zubra/runtime",
        "x.zb"
    )
    .is_ok());
}

#[test]
fn the_subset_still_comes_first_and_v02_syntax_is_still_caught() {
    let js = compile_js(
        "<zb-x a={1}><p>{a + 1}</p></zb-x>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap();
    assert!(js.contains("text: () => $t(($p.a + 1))"), "{js}");
    let error = compile_js(
        "<zb-x a={1}><p>{{ a }}</p></zb-x>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert!(error.message.contains("v0.2 syntax"), "{}", error.message);
    let error =
        compile_js("<zb-x a={1}><p>{a +}</p></zb-x>", "@zubra/runtime", "x.zb").unwrap_err();
    assert!(!error.message.is_empty());
}

#[test]
fn partial_html_leaves_browser_only_parts_to_the_element() {
    use zubra::{compile_html_with_options, HtmlOptions, SlotSource};
    let partial = |source: &str, props: &str| {
        let loader = |_: &str, _: &str| -> Result<(String, String), String> { Err("none".into()) };
        compile_html_with_options(
            source,
            "x.zb",
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
        "<zb-x>\n  <p></p>\n  <button>+</button>\n  <?zb [?><?zb [?>\n    <i>1.0</i>\n  <?zb ]?><?zb [?>\n    <i>2.0</i>\n  <?zb ]?><?zb [?>\n    <i>3.0</i>\n  <?zb ]?><?zb ]?>\n</zb-x>",
        "the text and the browser-computed default are left out; the list's map and toFixed render"
    );
    assert_eq!(
        partial(SOURCE, r#"{"stamp":5,"min":2}"#).unwrap(),
        "<zb-x min=\"2\" stamp=\"5\">\n  <p></p>\n  <button>+</button>\n  <?zb [?><?zb [?>\n    <i>1.0</i>\n  <?zb ]?><?zb [?>\n    <i>2.0</i>\n  <?zb ]?><?zb [?>\n    <i>3.0</i>\n  <?zb ]?><?zb ]?>\n</zb-x>"
    );
    assert_eq!(
        partial("<script>const now = Date.now()</script>\n<zb-x a=\"x\"><p title={now} class=\"c {now}\">{a}</p><zb-if test={now > 0}><b>later</b></zb-if></zb-x>", "{}").unwrap(),
        "<zb-x><p>x</p><?zb [??><?zb ]?></zb-x>"
    );
    // Everything else is still checked.
    assert!(partial("<zb-x><p>{nope()}</p></zb-x>", "{}").is_err());
}
