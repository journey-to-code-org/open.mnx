//! `--emit element`: a plain custom element with no runtime import, and the clear refusals for
//! what it doesn't cover. (What the element does in a browser is tested by running the runtime's
//! browser suites on this output: `ZUBRA_EMIT=element npm run test:browser`.)
use std::{fs, process::Command};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("zubra-element-{name}-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn element(name: &str, source: &str) -> Result<String, zubra::Diagnostic> {
    let dir = temp_dir(name);
    let path = dir.join("x.zb");
    fs::write(&path, source).unwrap();
    zubra::compile_element_file(path.to_str().unwrap())
}

fn refusal(name: &str, source: &str) -> String {
    let error = element(name, source).expect_err("refused");
    let text = format!(
        "{} {}",
        error.message,
        error.help.clone().unwrap_or_default()
    );
    assert!(
        text.contains("--emit js"),
        "points at the runtime build: {text}"
    );
    text
}

#[test]
fn an_element_has_no_runtime_import_and_defines_itself() {
    let module = element(
        "plain",
        r#"<script>
  import { state, computed as derived } from '@zubra/runtime'
  const count = state(0)
  const double = derived(() => count.get() * 2)
</script>
<x-counter step={1}>
  <button onclick={() => count.set(count.get() + step)}>{count} × 2 = {double}</button>
</x-counter>"#,
    )
    .unwrap();
    assert!(
        !module.contains("from '@zubra/runtime'") && !module.contains("from \"@zubra/runtime\""),
        "{module}"
    );
    assert!(
        module.contains("const derived = createComputed;"),
        "an aliased import is a local name: {module}"
    );
    assert!(
        module.contains("customElements.define(tag, XCounter)"),
        "{module}"
    );
}

/// The output is the custom element as you'd write it: a class over HTMLElement, its props as
/// accessors and observed attributes, its nodes found and named, its updates as DOM calls.
#[test]
fn the_output_is_a_standard_custom_element() {
    let module = element(
        "standard",
        r#"<script>
  let count = 0
  function add() {
    count += step
  }
</script>
<x-counter step={1} label="Count">
  <button class="add" aria-label={label} onclick={add}>+</button>
  <output>{count}</output>
</x-counter>"#,
    )
    .unwrap();
    for expected in [
        "export class XCounter extends HTMLElement {",
        "static observedAttributes = [\"step\", \"label\"];",
        "attributeChangedCallback(name, previous, raw) {",
        "this.step = raw === null ? 1 : Number(raw);",
        "get step() {",
        "set step(value) {",
        "connectedCallback() {",
        // The script, as written: props are the element's, state is `.value`.
        "count.value += element.step",
        // Nodes by position, named for what they are (`add` is the script's, so the button is `add2`).
        "const add2 = content.children[0];",
        "add2.addEventListener(\"click\", add);",
        "const output = content.children[1];",
        "(output.textContent = value)",
        "(value) => attribute(add2, \"aria-label\", value)",
        "customElements.define(tag, XCounter)",
    ] {
        assert!(module.contains(expected), "`{expected}` in:\n{module}");
    }
    for runtime in [
        "$define",
        "$p",
        "$r(",
        "$t(",
        "from \"@zubra/runtime\"",
        "__zubra",
    ] {
        assert!(!module.contains(runtime), "no `{runtime}` in:\n{module}");
    }
}

/// Names the component uses are never shadowed: the generated ones step aside.
#[test]
fn generated_names_never_take_the_components_own() {
    let module = element(
        "names",
        r#"<script>
  import { host } from '@zubra/runtime'
  const element = host()
  function bind() { return 1 }
  const content = "c"
</script>
<x-a label="hi"><p title={content}>{label} {bind()}</p></x-a>"#,
    )
    .unwrap();
    assert!(module.contains("const element2 = this;"), "{module}");
    assert!(module.contains("function $bind("), "{module}");
    assert!(module.contains("const content2 = clone("), "{module}");
    assert!(
        !module.replace("@zubra/", "").contains('@'),
        "no helper placeholder is left: {module}"
    );
}

#[test]
fn other_imports_are_kept() {
    let module = element(
        "imports",
        r#"<script>
  import { popover } from '@zubra/runtime/primitives'
  import { format } from './format.js'
</script>
<x-a><p>{format(1)}</p></x-a>"#,
    )
    .unwrap();
    assert!(module.contains("@zubra/runtime/primitives"), "{module}");
    assert!(module.contains("./format.js"), "{module}");
}

#[test]
fn what_it_does_not_cover_is_refused_with_a_reason() {
    assert!(refusal("shadow", "<x-a shadow><p>hi</p></x-a>").contains("shadow"));
    assert!(refusal(
        "subpath",
        "<script>\n  import { combobox } from '@zubra/runtime/zag'\n</script>\n<x-a><p>hi</p></x-a>",
    )
    .contains("@zubra/runtime/zag"));
    assert!(refusal(
        "resource",
        "<script>\n  import { resource } from '@zubra/runtime'\n</script>\n<x-a><p>hi</p></x-a>",
    )
    .contains("`resource`"));
    assert!(refusal(
        "spread",
        "<script>\n  const attrs = () => ({ title: 'x' })\n</script>\n<x-a><a {...attrs()}>go</a></x-a>",
    )
    .contains("spread"));
}

#[test]
fn the_command_line_and_request_api_emit_it() {
    let dir = temp_dir("cli");
    let path = dir.join("a.zb");
    fs::write(&path, "<x-a label=\"hi\"><b>{label}</b></x-a>").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_zubra"))
        .args(["compile", path.to_str().unwrap(), "--emit", "element"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("extends HTMLElement"));

    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_zubra"))
        .arg("request")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"emit":"element","path":"/a.zb","files":{"/a.zb":"<x-a label=\"hi\"><b>{label}</b></x-a>"}}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    assert!(response["output"]
        .as_str()
        .unwrap()
        .contains("extends HTMLElement"));
}

#[test]
fn the_slot_machinery_is_left_out_of_a_component_without_slots() {
    let plain = element("noslots", "<x-a><p>hi</p></x-a>").unwrap();
    assert!(
        !plain.contains("assignSlots") && !plain.contains("#slotRegion") && !plain.contains("@@"),
        "{plain}"
    );
    let slotted = element("slots", "<x-a><p><zb-slot></zb-slot></p></x-a>").unwrap();
    assert!(
        slotted.contains("function assignSlots(")
            && slotted.contains("#slotRegion(")
            && !slotted.contains("@@"),
        "{slotted}"
    );
    let asks = element(
        "hasslot",
        "<script>\n  import { hasSlot } from '@zubra/runtime'\n  const given = hasSlot('x')\n</script>\n<x-a><p>{given}</p></x-a>",
    )
    .unwrap();
    assert!(asks.contains("function assignSlots("), "hasSlot() needs it");
}

/// A JSX component's element reads like a `.zb` one's: its script with props as `element.name`
/// and state as `name.value` (no `$p`), its text under JSX's whitespace rule.
#[test]
fn a_jsx_component_reads_like_any_other() {
    let dir = temp_dir("jsx");
    let path = dir.join("counter.zb.jsx");
    fs::write(
        &path,
        r#"export default function XCounter({ step = 1, onChange }) {
  let count = 0
  function add() {
    count += step
    onChange(count)
  }
  return (
    <x-counter>
      <button onClick={add}>
        Add
      </button>
      <output>{count}</output>
    </x-counter>
  )
}
"#,
    )
    .unwrap();
    let module = zubra::compile_element_file(path.to_str().unwrap()).unwrap();
    for expected in [
        "count.value += element.step",
        "emit(\"change\", count.value)",
        "<button>Add</button>",
        "export class XCounter extends HTMLElement {",
    ] {
        assert!(module.contains(expected), "`{expected}` in:\n{module}");
    }
    for runtime in ["$p", "__zubra"] {
        assert!(!module.contains(runtime), "no `{runtime}` in:\n{module}");
    }
}
