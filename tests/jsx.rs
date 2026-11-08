//! The JSX front end (`.zb.jsx` / `.zb.tsx`): lowering to the `.zb` format, and diagnostics
//! placed in the JSX source.

use zubra::{compile, compile_declarations_for, compile_js, compile_manifest, warnings, Framework};

fn js(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "x.zb.jsx")
        .unwrap_or_else(|error| panic!("{}", error.render(source, "x.zb.jsx")))
}

fn error(source: &str) -> (String, usize, usize) {
    let error = compile_js(source, "@zubra/runtime", "x.zb.jsx").unwrap_err();
    (error.message, error.span.line, error.span.column)
}

#[test]
fn a_props_only_component_renders_static_html_too() {
    let source = "export default function ZbHello({ name = \"World\", items = [\"a\", \"b\"] }) {\n  return (\n    <p class=\"hi\">\n      Hello {name}!\n      {items.length > 1 && <b>many</b>}\n    </p>\n  )\n}\n";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-hello><p class=\"hi\"><!---->Hello World!<!--[--><b>many</b><!--]--></p></zb-hello>"
    );
    assert_eq!(
        compile(source, r#"{"name":"Ada","items":[]}"#).unwrap(),
        "<zb-hello name=\"Ada\" items=\"[]\"><p class=\"hi\"><!---->Hello Ada!<!--[--><!--]--></p></zb-hello>"
    );
}

#[test]
fn state_derived_values_props_and_events() {
    let output = js("export default function ZbCount({ start = 0, onCountChange }) {\n  let count = start\n  const doubled = count * 2\n  const format = (n) => `#${n}`\n  function add() { count += 2; onCountChange(count) }\n  return <button onClick={() => { count++; add() }}>{format(doubled)} {start}</button>\n}\n");
    assert!(
        output.contains("const count = __zubraState($p.start)"),
        "{output}"
    );
    assert!(
        output.contains("const doubled = __zubraComputed(() => (count.get() * 2))"),
        "{output}"
    );
    assert!(
        output.contains("const format = (n) => `#${n}`"),
        "a function isn't derived: {output}"
    );
    assert!(output.contains("function add() { __zubraAssign(count, count.get() + (2)); __zubraEmit(\"countchange\", count.get()) }"), "{output}");
    assert!(
        output.contains("handler: () => (() => { __zubraUpdate(count, 1, false); add() })"),
        "{output}"
    );
    assert!(
        output.contains("$t((format(doubled.get()))) + \" \" + $t($p.start)"),
        "{output}"
    );
    assert!(output.contains("events: [\"countchange\"]"), "{output}");
}

#[test]
fn lists_conditionals_slots_and_the_host() {
    let output = js("export default function ZbList({ items = [{ id: 1, name: \"a\" }], open = true, children }) {\n  return (\n    <zb-list shadow>\n      {open ? items.map((item, i) => <li key={item.id} data-i={i}>{item.name}</li>) : <p>closed</p>}\n      <zb-slot name=\"footer\">none</zb-slot>\n      {children}\n    </zb-list>\n  )\n}\n");
    assert!(output.contains("shadow: true"), "{output}");
    assert!(
        output.contains("slots: [\"default\", \"footer\"]"),
        "{output}"
    );
    assert!(
        output.contains("each: () => $p.items, key: (item, i) => $r(item).id"),
        "{output}"
    );
    assert!(
        output.contains("blocks: [{ template: \"<!--[--><!--]-->\""),
        "{output}"
    );
    assert!(
        output.contains("{ template: \"<p>closed</p>\", parts: () => [] }"),
        "{output}"
    );
}

#[test]
fn jsx_spellings_become_html() {
    let output = js("export default function ZbForm({ id = \"x\" }) {\n  return <label htmlFor={id} className=\"a {b}\" onClick={() => id = \"y\"}>Name<input /></label>\n}\n");
    assert!(
        output.contains(r#"template: "<label>Name<input></label>""#),
        "{output}"
    );
    assert!(
        output.contains(r#"attribute: "class", value: () => "a {b}""#)
            && output.contains(r#"attribute: "for""#),
        "{output}"
    );
    assert!(
        output.contains(r#"on: "click", handler: () => (() => $p.id = "y")"#),
        "{output}"
    );
}

#[test]
fn mistakes_are_reported_in_the_jsx() {
    assert_eq!(
        error("export default function Card() {\n  return <p />\n}\n"),
        (
            "`Card` would be <card>, but a custom element's name needs a hyphen".to_owned(),
            1,
            25
        )
    );
    assert_eq!(
        error("export default function ZbX({ onPick }) {\n  return <button onClick={onPick}>x</button>\n}\n").0,
        "call `onPick(…)` to fire the event; passing it on isn't supported"
    );
    assert_eq!(
        error(
            "export default function ZbX({ a = 1 }) {\n  if (a) return null\n  return <p />\n}\n"
        ),
        (
            "a component function returns once, at the end; use conditionals in the returned JSX"
                .to_owned(),
            2,
            10
        )
    );
    assert_eq!(
        error("let shared = 0\nexport default function ZbX() {\n  return <p />\n}\n").1,
        1
    );
    assert!(
        error("export default function ZbX(props) {\n  return <p />\n}\n")
            .0
            .contains("destructure the props")
    );
    assert!(
        error("export default function ZbX({ a: b }) {\n  return <p />\n}\n")
            .0
            .contains("renaming")
    );
    // Spreading onto an element compiles since 3.5; onto a zubra component, it's an error.
    assert!(
        error("import Badge from './badge.zb';\nexport default function ZbX({ a = 1 }) {\n  return <Badge {...a} />\n}\n")
            .0
            .contains("spreading onto a zubra component")
    );
    assert!(
        error("export default function ZbX({ a = 1 }) {\n  return <p title={<b />} />\n}\n")
            .0
            .contains("render prop")
    );
    assert!(
        error("export default function ZbX() {\n  return <Missing />\n}\n")
            .0
            .contains("<Missing> isn't an imported component")
    );
    assert!(error("import { emit } from '@zubra/runtime'\nexport default function ZbX() {\n  return <p />\n}\n").0.contains("`on…` props"));
    // Found after lowering, placed in the JSX: the unknown name in line 3.
    assert_eq!(
        error("export default function ZbX({ name = \"a\" }) {\n  return (\n    <p>{nmae}</p>\n  )\n}\n"),
        ("unknown reference `nmae`".to_owned(), 3, 8)
    );
}

#[test]
fn interfaces_typings_and_warnings() {
    let source = "/**\n * A picker.\n * @fires valuechange - Picked.\n */\nexport default function ZbPicker({ value = \"\", hidden = false, onValueChange }) {\n  return <button onClick={() => onValueChange(\"x\")}>{value}</button>\n}\n";
    let dts = compile_declarations_for(source, "picker.zb.jsx", Framework::React).unwrap();
    assert!(
        dts.contains("onValueChange?: (event: ZbPickerEventMap[\"valuechange\"]) => void"),
        "{dts}"
    );
    assert!(dts.contains("A picker."), "{dts}");
    let manifest = compile_manifest(source, "picker.js").unwrap();
    assert!(
        manifest.contains("\"tagName\": \"zb-picker\""),
        "{manifest}"
    );
    let warned = warnings(source);
    assert_eq!(warned.len(), 1);
    assert_eq!(
        (warned[0].span.line, warned[0].span.column),
        (5, 48),
        "at the parameter"
    );
}

#[test]
fn class_style_ref_and_global_listeners_in_jsx() {
    let source = r#"import { prevent, keys } from '@zubra/runtime'
export default function ZbPanel({ open = false, size = 10, tone = "red" }) {
  let box = null
  let presses = 0
  return (
    <>
      <zb-document onKeyDown={keys('escape', () => (open = false))} />
      <div ref={box} className={{ open, big: size > 20 }} style={{ fontSize: size + "px", "--tone": tone }} class:wide={size > 5}>
        <form onSubmit={prevent(() => presses++)}>send</form>
      </div>
    </>
  )
}
"#;
    let code = js(source);
    for part in [
        r#"global: "document", on: "keydown""#,
        r#"ref: () => (($el) => __zubraAssign(box, $el))"#,
        r#"toggle: "open", value: () => $p.open"#,
        r#"toggle: "big", value: () => ($p.size > 20)"#,
        r#"toggle: "wide""#,
        r#"style: "font-size", value: () => ($p.size + "px")"#,
        r#"style: "--tone", value: () => $p.tone"#,
        r#"on: "submit", handler: () => (prevent("#,
    ] {
        assert!(code.contains(part), "{part}\n{code}");
    }
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-panel><!----><div class=\"wide\" style=\"font-size: 10px; --tone: red\"><form>send</form></div></zb-panel>"
    );
}

#[test]
fn typescript_in_a_tsx_template_expression_is_blanked_like_the_script_s() {
    let source = "export default function ZbX({ a = 1 }) {\n  return <p onClick={(e) => (e.target as HTMLElement).focus()} title={String(a!)}>x</p>\n}\n";
    let output = zubra::compile_js(source, "@zubra/runtime", "x.zb.tsx").unwrap();
    assert!(
        output.contains("((e) => (e.target               ).focus())"),
        "{output}"
    );
    assert!(output.contains("String($p.a )"), "{output}");
}
