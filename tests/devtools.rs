//! `--devtools`: what the browser DevTools panel reads from a development build: the component's
//! path, each part's source location, and the script's signals by name.

use std::{fs, process::Command};

use serde_json::{json, Value};

const SOURCE: &str = r#"<script>
  let count = 0
  const doubled = count * 2
</script>
<zb-counter label="Clicks">
  <button onclick={() => count++}>{label}</button>
  <p zb-if={count > 0}>
    <span>{doubled}</span>
  </p>
</zb-counter>
"#;

/// Compile the fixture with `arguments`, in a directory of the test's own (`name`): the tests
/// run in parallel, and a file shared between them could be read half written.
fn compile(name: &str, arguments: &[&str]) -> (bool, String, String) {
    let dir = std::env::temp_dir().join(format!("zubra-devtools-{name}-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("counter.zb");
    fs::write(&path, SOURCE).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_zubra"))
        .args(["compile", path.to_str().unwrap()])
        .args(arguments)
        .output()
        .expect("zubra runs");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn a_devtools_build_records_where_each_part_was_written() {
    let (ok, js, stderr) = compile("located", &["--emit", "js", "--devtools"]);
    assert!(ok, "{stderr}");
    // The listener and the text are on line 6; the region is line 7; the row's text, line 8.
    assert!(
        js.contains(r#"on: "click""#) && js.contains("at: [6, 11]"),
        "{js}"
    );
    assert!(
        js.contains(r#"text: () => $t($p.label), at: [6, 35]"#),
        "{js}"
    );
    assert!(js.contains("at: [7, 3]"), "the zb-if region: {js}");
    assert!(js.contains("at: [8, 11]"), "a part inside a block: {js}");
}

#[test]
fn a_devtools_build_names_the_signals_and_the_file() {
    let (ok, js, stderr) = compile("named", &["--emit", "js", "--devtools"]);
    assert!(ok, "{stderr}");
    assert!(
        js.contains("counter.zb\", at: [5, 1] },\n"),
        "the definition's source: {js}"
    );
    assert!(js.contains("setup($p, $emit, $initial, $dev) {"), "{js}");
    assert!(
        js.contains("$dev?.({ count, doubled });\n    return ["),
        "{js}"
    );
}

#[test]
fn without_the_flag_none_of_it_is_emitted() {
    let (ok, js, stderr) = compile("plain", &["--emit", "js"]);
    assert!(ok, "{stderr}");
    assert!(!js.contains("at: ["), "{js}");
    assert!(!js.contains("$dev"), "{js}");
    assert!(!js.contains("source:"), "{js}");
}

#[test]
fn the_flag_applies_to_javascript_only() {
    let (ok, _, stderr) = compile("css", &["--emit", "css", "--devtools"]);
    assert!(!ok);
    assert!(
        stderr.contains("--devtools applies to --emit js"),
        "{stderr}"
    );
}

#[test]
fn the_request_api_takes_it_too() {
    let request = json!({
        "path": "/app/counter.zb",
        "files": { "/app/counter.zb": SOURCE },
        "emit": "js",
        "keepImports": true,
        "devtools": true,
    });
    let response: Value =
        serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let js = response["output"].as_str().unwrap();
    assert!(
        js.contains("source: { file: \"/app/counter.zb\", at: [5, 1] }"),
        "{js}"
    );
    assert!(js.contains("at: [6, 11]"), "{js}");
}
