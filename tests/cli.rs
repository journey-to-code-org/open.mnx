//! The `zubra` command line, run as a process.

use std::{fs, process::Command};

fn zubra(arguments: &[&str]) -> (bool, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_zubra"))
        .args(arguments)
        .output()
        .expect("zubra runs");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("zubra-cli-{name}-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn check_reports_errors_and_warnings_across_files() {
    let dir = temp_dir("check");
    let good = dir.join("good.zb");
    let warned = dir.join("warned.zb");
    let bad = dir.join("bad.zb");
    fs::write(&good, "<zb-good label=\"x\"><p>{label}</p></zb-good>").unwrap();
    fs::write(&warned, "<zb-warned hidden={false}><p>x</p></zb-warned>").unwrap();
    fs::write(&bad, "<zb-bad label=\"x\">\n  <p>{lable}</p>\n</zb-bad>").unwrap();

    let (ok, _, stderr) = zubra(&["check", good.to_str().unwrap(), warned.to_str().unwrap()]);
    assert!(ok, "warnings don't fail the check: {stderr}");
    assert!(stderr.contains("warning: prop `hidden`"), "{stderr}");
    assert!(stderr.contains("checked 2 files: no errors"), "{stderr}");

    let (ok, _, stderr) = zubra(&["check", good.to_str().unwrap(), bad.to_str().unwrap()]);
    assert!(!ok);
    assert!(
        stderr.contains("error: unknown reference `lable`"),
        "{stderr}"
    );
    assert!(stderr.contains("= help: did you mean `label`?"), "{stderr}");
    assert!(stderr.contains("1 file with errors"), "{stderr}");

    let (ok, stdout, stderr) = zubra(&[
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
        dir.join("card.zb"),
        "<style>p { margin: 0 }</style>\n<zb-card><p>x</p></zb-card>",
    )
    .unwrap();
    fs::write(dir.join("page.zb"), "<script>import './card.zb'</script>\n<style>.a { color: red }</style>\n<zb-page><zb-card></zb-card></zb-page>").unwrap();
    let page = dir.join("page.zb");
    let (ok, all, stderr) = zubra(&["compile", page.to_str().unwrap(), "--emit", "css"]);
    assert!(ok, "{stderr}");
    assert!(
        all.find("/* zb-card */").unwrap() < all.find("/* zb-page */").unwrap(),
        "{all}"
    );
    let (_, own, _) = zubra(&[
        "compile",
        page.to_str().unwrap(),
        "--emit",
        "css",
        "--no-imports",
    ]);
    assert!(
        own.contains("/* zb-page */") && !own.contains("zb-card"),
        "{own}"
    );
}

#[test]
fn check_reads_unsaved_text_from_standard_input() {
    use std::io::Write;
    let dir = temp_dir("stdin");
    fs::write(
        dir.join("badge.zb"),
        "<zb-badge label=\"x\"><b>{label}</b></zb-badge>",
    )
    .unwrap();
    let page = dir.join("page.zb");
    fs::write(&page, "<zb-page><p>saved, fine</p></zb-page>").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_zubra"))
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
    child.stdin.take().unwrap().write_all(b"<script>import './badge.zb'</script>\n<zb-page><zb-badge lable={1}></zb-badge></zb-page>").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report[0]["message"], "<zb-badge> has no prop `lable`");
    assert_eq!(report[0]["line"], 2);
    let (ok, _, stderr) = zubra(&["check", "a.zb", "b.zb", "--stdin"]);
    assert!(!ok && stderr.contains("one path"), "{stderr}");
}

#[test]
fn request_answers_one_json_request_on_stdin() {
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
        .write_all(
            br#"{"path":"/a.zb","files":{"/a.zb":"<zb-a x=\"1\"><zb-slot></zb-slot><b>{x}</b></zb-a>"},"props":{"x":"2"},"slots":{"default":"<i>{y}</i>"},"slotSource":"html"}"#,
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(
        response["output"],
        "<zb-a x=\"2\"><?zb [!?><i>{y}</i><?zb ]?><b>2</b></zb-a>"
    );
    let (ok, _, stderr) = zubra(&["request", "extra"]);
    assert!(!ok);
    assert!(stderr.contains("unexpected argument `extra`"), "{stderr}");
}

#[test]
fn slots_html_takes_server_rendered_content() {
    let dir = temp_dir("slots-html");
    let source = dir.join("panel.zb");
    let slots = dir.join("slots.json");
    fs::write(&source, "<zb-panel><zb-slot></zb-slot></zb-panel>").unwrap();
    fs::write(&slots, r#"{"default":"<p>{kept}</p>"}"#).unwrap();
    let (ok, stdout, stderr) = zubra(&[
        "compile",
        source.to_str().unwrap(),
        "--slots",
        slots.to_str().unwrap(),
        "--slots-html",
    ]);
    assert!(ok, "{stderr}");
    assert_eq!(
        stdout,
        "<zb-panel><?zb [!?><p>{kept}</p><?zb ]?></zb-panel>\n"
    );
    let (ok, _, stderr) = zubra(&[
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
    let file = dir.join("x.zb");
    let jsx = dir.join("y.zb.jsx");
    fs::write(
        &file,
        "<script>const name = \"a\"</script>\n<zb-x name={name}><p>{name}</p></zb-x>\n",
    )
    .unwrap();
    fs::write(&jsx, "export default function ZbY() { return <p /> }\n").unwrap();
    let (ok, _, stderr) = zubra(&["migrate", file.to_str().unwrap(), "--check"]);
    assert!(!ok);
    assert!(stderr.contains("1 file would change"), "{stderr}");
    let (ok, _, stderr) = zubra(&["migrate", file.to_str().unwrap(), jsx.to_str().unwrap()]);
    assert!(ok, "{stderr}");
    assert!(
        stderr.contains("renamed the script's `name` to `nameDefault`"),
        "{stderr}"
    );
    assert!(stderr.contains("y.zb.jsx: skipped"), "{stderr}");
    assert!(fs::read_to_string(&file)
        .unwrap()
        .contains("name={nameDefault}"));
    let (ok, _, _) = zubra(&["migrate", file.to_str().unwrap(), "--check"]);
    assert!(ok, "nothing left to migrate");
}

#[test]
fn serve_answers_a_request_per_line_and_batches() {
    use std::io::{BufRead, BufReader, Write};
    let mut child = Command::new(env!("CARGO_BIN_EXE_zubra"))
        .arg("serve")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let request = serde_json::json!({
        "emit": "html", "path": "/c/hi.zb", "props": { "name": "Ada" },
        "files": { "/c/hi.zb": "<zb-hi name=\"\"><p>Hi {name}</p></zb-hi>" },
    });
    // One at a time: each answer comes back before the next question (a long-lived process).
    for name in ["Ada", "Grace"] {
        let mut request = request.clone();
        request["props"]["name"] = name.into();
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
        let response: serde_json::Value =
            serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        assert_eq!(response["ok"], true);
        assert!(response["output"]
            .as_str()
            .unwrap()
            .contains(&format!("<p>Hi {name}</p>")));
    }
    // A batch: one response per request, in order; `ok` only if all are.
    writeln!(
        stdin,
        "\n{}",
        serde_json::json!({ "requests": [request, { "path": "/nope.zb", "files": {} }] })
    )
    .unwrap();
    drop(stdin);
    let response: serde_json::Value =
        serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    assert_eq!(response["ok"], false);
    assert_eq!(response["responses"][0]["ok"], true);
    assert_eq!(response["responses"][1]["ok"], false);
    assert!(lines.next().is_none(), "it exits when stdin closes");
    assert!(child.wait().unwrap().success());
}

#[test]
fn check_server_reports_what_the_servers_html_leaves_out() {
    let dir = std::env::temp_dir().join(format!("zb-check-server-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let picker = dir.join("picker.zb");
    fs::write(
        &picker,
        "<script>\n  const picked = new Set(value)\n</script>\n<zb-picker value={[\"kale\"]} options={[\"kale\", \"beans\"]}>\n  <zb-each items={options} as=\"option\" key={option}>\n    <label><input type=\"checkbox\" name=\"crops\" checked={picked.has(option)}> {option.toLocaleUpperCase()} {`${option}!`}</label>\n  </zb-each>\n</zb-picker>\n",
    )
    .unwrap();
    let path = picker.to_str().unwrap();
    // Without --server: fine (the browser computes them).
    let (ok, _, _) = zubra(&["check", path]);
    assert!(ok);
    let (ok, stdout, stderr) = zubra(&["check", "--server", path]);
    assert!(!ok, "a form's state left out is an error");
    let text = format!("{stdout}{stderr}");
    assert!(
        text.contains("`checked` is computed in the browser") && text.contains("picker.zb:6:"),
        "{text}"
    );
    // toLocaleUpperCase() is left for the browser; the template literal renders on the server.
    assert_eq!(
        text.matches("warning: this is computed in the browser")
            .count(),
        1,
        "{text}"
    );
    fs::remove_dir_all(&dir).ok();
}
