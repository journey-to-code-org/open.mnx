//! The JSX front end (`.mnx.jsx` / `.mnx.tsx`): lowering to the `.mnx` format, and diagnostics
//! placed in the JSX source.

use mnix_compiler::{
    compile, compile_declarations_for, compile_js, compile_manifest, warnings, Framework,
};

fn js(source: &str) -> String {
    compile_js(source, "@mnx/runtime", "x.mnx.jsx")
        .unwrap_or_else(|error| panic!("{}", error.render(source, "x.mnx.jsx")))
}

fn error(source: &str) -> (String, usize, usize) {
    let error = compile_js(source, "@mnx/runtime", "x.mnx.jsx").unwrap_err();
    (error.message, error.span.line, error.span.column)
}

#[test]
fn a_props_only_component_renders_static_html_too() {
    let source = "export default function MnxHello({ name = \"World\", items = [\"a\", \"b\"] }) {\n  return (\n    <p class=\"hi\">\n      Hello {name}!\n      {items.length > 1 && <b>many</b>}\n    </p>\n  )\n}\n";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-hello><p class=\"hi\"><!---->Hello World!<!--[--><b>many</b><!--]--></p></mnx-hello>"
    );
    assert_eq!(
        compile(source, r#"{"name":"Ada","items":[]}"#).unwrap(),
        "<mnx-hello name=\"Ada\" items=\"[]\"><p class=\"hi\"><!---->Hello Ada!<!--[--><!--]--></p></mnx-hello>"
    );
}

#[test]
fn state_derived_values_props_and_events() {
    let output = js("export default function MnxCount({ start = 0, onCountChange }) {\n  let count = start\n  const doubled = count * 2\n  const format = (n) => `#${n}`\n  function add() { count += 2; onCountChange(count) }\n  return <button onClick={() => { count++; add() }}>{format(doubled)} {start}</button>\n}\n");
    assert!(
        output.contains("const count = __mnxState($p.start)"),
        "{output}"
    );
    assert!(
        output.contains("const doubled = __mnxComputed(() => (count.get() * 2))"),
        "{output}"
    );
    assert!(
        output.contains("const format = (n) => `#${n}`"),
        "a function isn't derived: {output}"
    );
    assert!(output.contains("function add() { __mnxAssign(count, count.get() + (2)); __mnxEmit(\"countchange\", count.get()) }"), "{output}");
    assert!(
        output.contains("handler: () => (() => { __mnxUpdate(count, 1, false); add() })"),
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
    let output = js("export default function MnxList({ items = [{ id: 1, name: \"a\" }], open = true, children }) {\n  return (\n    <mnx-list shadow>\n      {open ? items.map((item, i) => <li key={item.id} data-i={i}>{item.name}</li>) : <p>closed</p>}\n      <mnx-slot name=\"footer\">none</mnx-slot>\n      {children}\n    </mnx-list>\n  )\n}\n");
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
    let output = js("export default function MnxForm({ id = \"x\" }) {\n  return <label htmlFor={id} className=\"a {b}\" onClick={() => id = \"y\"}>Name<input /></label>\n}\n");
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
        error("export default function MnxX({ onPick }) {\n  return <button onClick={onPick}>x</button>\n}\n").0,
        "call `onPick(…)` to fire the event; passing it on isn't supported"
    );
    assert_eq!(
        error(
            "export default function MnxX({ a = 1 }) {\n  if (a) return null\n  return <p />\n}\n"
        ),
        (
            "a component function returns once, at the end; use conditionals in the returned JSX"
                .to_owned(),
            2,
            10
        )
    );
    assert_eq!(
        error("let shared = 0\nexport default function MnxX() {\n  return <p />\n}\n").1,
        1
    );
    assert!(
        error("export default function MnxX(props) {\n  return <p />\n}\n")
            .0
            .contains("destructure the props")
    );
    assert!(
        error("export default function MnxX({ a: b }) {\n  return <p />\n}\n")
            .0
            .contains("renaming")
    );
    assert!(
        error("export default function MnxX({ a = 1 }) {\n  return <p {...a} />\n}\n")
            .0
            .contains("spread")
    );
    assert!(
        error("export default function MnxX({ a = 1 }) {\n  return <p ref={a} />\n}\n")
            .0
            .contains("`ref`")
    );
    assert!(
        error("export default function MnxX({ a = 1 }) {\n  return <p title={<b />} />\n}\n")
            .0
            .contains("render prop")
    );
    assert!(
        error("export default function MnxX() {\n  return <Missing />\n}\n")
            .0
            .contains("<Missing> isn't an imported component")
    );
    assert!(error("import { emit } from '@mnx/runtime'\nexport default function MnxX() {\n  return <p />\n}\n").0.contains("`on…` props"));
    // Found after lowering, placed in the JSX: the unknown name in line 3.
    assert_eq!(
        error("export default function MnxX({ name = \"a\" }) {\n  return (\n    <p>{nmae}</p>\n  )\n}\n"),
        ("unknown reference `nmae`".to_owned(), 3, 8)
    );
}

#[test]
fn interfaces_typings_and_warnings() {
    let source = "/**\n * A picker.\n * @fires valuechange - Picked.\n */\nexport default function MnxPicker({ value = \"\", hidden = false, onValueChange }) {\n  return <button onClick={() => onValueChange(\"x\")}>{value}</button>\n}\n";
    let dts = compile_declarations_for(source, "picker.mnx.jsx", Framework::React).unwrap();
    assert!(
        dts.contains("onValueChange?: (event: MnxPickerEventMap[\"valuechange\"]) => void"),
        "{dts}"
    );
    assert!(dts.contains("A picker."), "{dts}");
    let manifest = compile_manifest(source, "picker.js").unwrap();
    assert!(
        manifest.contains("\"tagName\": \"mnx-picker\""),
        "{manifest}"
    );
    let warned = warnings(source);
    assert_eq!(warned.len(), 1);
    assert_eq!(
        (warned[0].span.line, warned[0].span.column),
        (5, 49),
        "at the parameter"
    );
}
