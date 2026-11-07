//! The `mnix` command line, run as a process.

use std::{fs, process::Command};

fn mnix(arguments: &[&str]) -> (bool, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_mnix"))
        .args(arguments)
        .output()
        .expect("mnix runs");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("mnix-cli-{name}-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn check_reports_errors_and_warnings_across_files() {
    let dir = temp_dir("check");
    let good = dir.join("good.mnx");
    let warned = dir.join("warned.mnx");
    let bad = dir.join("bad.mnx");
    fs::write(&good, "<mnx-good label=\"x\"><p>{label}</p></mnx-good>").unwrap();
    fs::write(&warned, "<mnx-warned hidden={false}><p>x</p></mnx-warned>").unwrap();
    fs::write(&bad, "<mnx-bad label=\"x\">\n  <p>{lable}</p>\n</mnx-bad>").unwrap();

    let (ok, _, stderr) = mnix(&["check", good.to_str().unwrap(), warned.to_str().unwrap()]);
    assert!(ok, "warnings don't fail the check: {stderr}");
    assert!(stderr.contains("warning: prop `hidden`"), "{stderr}");
    assert!(stderr.contains("checked 2 files: no errors"), "{stderr}");

    let (ok, _, stderr) = mnix(&["check", good.to_str().unwrap(), bad.to_str().unwrap()]);
    assert!(!ok);
    assert!(
        stderr.contains("error: unknown reference `lable`"),
        "{stderr}"
    );
    assert!(stderr.contains("= help: did you mean `label`?"), "{stderr}");
    assert!(stderr.contains("1 file with errors"), "{stderr}");

    let (ok, stdout, stderr) = mnix(&[
        "check",
        bad.to_str().unwrap(),
        warned.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(!ok);
    assert!(stderr.is_empty(), "{stderr}");
    let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    let entries: Vec<_> = report
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["severity"].as_str().unwrap(),
                entry["line"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(entries, [("error", 2), ("warning", 1)]);
    assert_eq!(report[0]["help"], "did you mean `label`?");
}

#[test]
fn emit_css_collects_imported_components_unless_asked_not_to() {
    let dir = temp_dir("css");
    fs::write(
        dir.join("card.mnx"),
        "<style>p { margin: 0 }</style>\n<mnx-card><p>x</p></mnx-card>",
    )
    .unwrap();
    fs::write(dir.join("page.mnx"), "<script>import './card.mnx'</script>\n<style>.a { color: red }</style>\n<mnx-page><mnx-card></mnx-card></mnx-page>").unwrap();
    let page = dir.join("page.mnx");
    let (ok, all, stderr) = mnix(&["compile", page.to_str().unwrap(), "--emit", "css"]);
    assert!(ok, "{stderr}");
    assert!(
        all.find("/* mnx-card */").unwrap() < all.find("/* mnx-page */").unwrap(),
        "{all}"
    );
    let (_, own, _) = mnix(&[
        "compile",
        page.to_str().unwrap(),
        "--emit",
        "css",
        "--no-imports",
    ]);
    assert!(
        own.contains("/* mnx-page */") && !own.contains("mnx-card"),
        "{own}"
    );
}

#[test]
fn check_reads_unsaved_text_from_standard_input() {
    use std::io::Write;
    let dir = temp_dir("stdin");
    fs::write(
        dir.join("badge.mnx"),
        "<mnx-badge label=\"x\"><b>{label}</b></mnx-badge>",
    )
    .unwrap();
    let page = dir.join("page.mnx");
    fs::write(&page, "<mnx-page><p>saved, fine</p></mnx-page>").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mnix"))
        .args([
            "check",
            page.to_str().unwrap(),
            "--stdin",
            "--format",
            "json",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // Unsaved: imports a sibling (resolved from the file's real directory) with a typo'd prop.
    child.stdin.take().unwrap().write_all(b"<script>import './badge.mnx'</script>\n<mnx-page><mnx-badge lable={1}></mnx-badge></mnx-page>").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report[0]["message"], "<mnx-badge> has no prop `lable`");
    assert_eq!(report[0]["line"], 2);
    let (ok, _, stderr) = mnix(&["check", "a.mnx", "b.mnx", "--stdin"]);
    assert!(!ok && stderr.contains("one path"), "{stderr}");
}

#[test]
fn request_answers_one_json_request_on_stdin() {
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_mnix"))
        .arg("request")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            br#"{"path":"/a.mnx","files":{"/a.mnx":"<mnx-a x=\"1\"><mnx-slot></mnx-slot><b>{x}</b></mnx-a>"},"props":{"x":"2"},"slots":{"default":"<i>{y}</i>"},"slotSource":"html"}"#,
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(
        response["output"],
        "<mnx-a x=\"2\"><!--[!--><i>{y}</i><!--]--><b>2</b></mnx-a>"
    );
    let (ok, _, stderr) = mnix(&["request", "extra"]);
    assert!(!ok);
    assert!(stderr.contains("unexpected argument `extra`"), "{stderr}");
}

#[test]
fn slots_html_takes_server_rendered_content() {
    let dir = temp_dir("slots-html");
    let source = dir.join("panel.mnx");
    let slots = dir.join("slots.json");
    fs::write(&source, "<mnx-panel><mnx-slot></mnx-slot></mnx-panel>").unwrap();
    fs::write(&slots, r#"{"default":"<p>{kept}</p>"}"#).unwrap();
    let (ok, stdout, stderr) = mnix(&[
        "compile",
        source.to_str().unwrap(),
        "--slots",
        slots.to_str().unwrap(),
        "--slots-html",
    ]);
    assert!(ok, "{stderr}");
    assert_eq!(
        stdout,
        "<mnx-panel><!--[!--><p>{kept}</p><!--]--></mnx-panel>\n"
    );
    let (ok, _, stderr) = mnix(&[
        "compile",
        source.to_str().unwrap(),
        "--emit",
        "js",
        "--slots-html",
    ]);
    assert!(!ok);
    assert!(stderr.contains("apply to --emit html"), "{stderr}");
}

#[test]
fn migrate_rewrites_in_place_and_check_reports() {
    let dir = temp_dir("migrate");
    let file = dir.join("x.mnx");
    let jsx = dir.join("y.mnx.jsx");
    fs::write(
        &file,
        "<script>const name = \"a\"</script>\n<mnx-x name={name}><p>{name}</p></mnx-x>\n",
    )
    .unwrap();
    fs::write(&jsx, "export default function MnxY() { return <p /> }\n").unwrap();
    let (ok, _, stderr) = mnix(&["migrate", file.to_str().unwrap(), "--check"]);
    assert!(!ok);
    assert!(stderr.contains("1 file would change"), "{stderr}");
    let (ok, _, stderr) = mnix(&["migrate", file.to_str().unwrap(), jsx.to_str().unwrap()]);
    assert!(ok, "{stderr}");
    assert!(
        stderr.contains("renamed the script's `name` to `nameDefault`"),
        "{stderr}"
    );
    assert!(stderr.contains("y.mnx.jsx: skipped"), "{stderr}");
    assert!(fs::read_to_string(&file)
        .unwrap()
        .contains("name={nameDefault}"));
    let (ok, _, _) = mnix(&["migrate", file.to_str().unwrap(), "--check"]);
    assert!(ok, "nothing left to migrate");
}

#[test]
fn mnx_is_the_same_cli() {
    let output = Command::new(env!("CARGO_BIN_EXE_mnx"))
        .args(["compile", "--help-me"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("missing component source path")
            || String::from_utf8_lossy(&output.stderr).contains("unable to read")
    );
}
