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
