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
        module.contains("function $define("),
        "the element runtime is inlined"
    );
    assert!(
        module.contains("const derived = computed;"),
        "an aliased import is a local name: {module}"
    );
    assert!(module.contains("x-counter"), "{module}");
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
    assert!(String::from_utf8_lossy(&output.stdout).contains("function $define("));

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
        .contains("function $define("));
}

#[test]
fn the_slot_machinery_is_left_out_of_a_component_without_slots() {
    let plain = element("noslots", "<x-a><p>hi</p></x-a>").unwrap();
    assert!(
        !plain.contains("$assignSlots") && !plain.contains("@slots"),
        "{plain}"
    );
    let slotted = element("slots", "<x-a><p><zb-slot></zb-slot></p></x-a>").unwrap();
    assert!(slotted.contains("function $assignSlots(") && !slotted.contains("@slots"));
    let asks = element(
        "hasslot",
        "<script>\n  import { hasSlot } from '@zubra/runtime'\n  const given = hasSlot('x')\n</script>\n<x-a><p>{given}</p></x-a>",
    )
    .unwrap();
    assert!(
        asks.contains("function $assignSlots("),
        "hasSlot() needs it"
    );
}
