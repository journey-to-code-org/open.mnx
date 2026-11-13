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
    // A gap inside a child component is reported at the child's tag in this file, saying where
    // in the child it is (not at the child's line and column, as if they were this file's).
    fs::write(
        dir.join("badge.zb"),
        "<script>\n  const at = Date.now()\n</script>\n<style>\n  span { color: red; }\n</style>\n<zb-badge>\n  <span>{at}</span>\n</zb-badge>\n",
    )
    .unwrap();
    let card = dir.join("card.zb");
    fs::write(
        &card,
        "<script>\n  import './badge.zb'\n</script>\n<zb-card>\n  <zb-badge></zb-badge>\n</zb-card>\n",
    )
    .unwrap();
    let (ok, stdout, stderr) = zubra(&["check", "--server", card.to_str().unwrap()]);
    assert!(ok, "a warning, not an error");
    let text = format!("{stdout}{stderr}");
    assert!(
        text.contains("inside <zb-badge> (badge.zb:8:")
            && text.contains("card.zb:5:")
            && !text.contains("card.zb:8:"),
        "{text}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn components_import_components_from_packages_in_node_modules() {
    let dir = temp_dir("packages");
    let kit = dir.join("node_modules/@acme/kit/components");
    fs::create_dir_all(&kit).unwrap();
    fs::write(kit.join("dot.zb"), "<kit-dot><i></i></kit-dot>\n").unwrap();
    fs::write(
        kit.join("cart-panel.zb"),
        "<script>\n  import './dot.zb'\n</script>\n<cart-panel count={2}><b>{count}</b><kit-dot></kit-dot></cart-panel>\n",
    )
    .unwrap();
    let app = dir.join("src/pages");
    fs::create_dir_all(&app).unwrap();
    let page = app.join("shop-page.zb");
    let write_page = |specifier: &str, attributes: &str| {
        fs::write(
            &page,
            format!("<script>\n  import '{specifier}'\n</script>\n<shop-page><cart-panel{attributes}></cart-panel></shop-page>\n"),
        )
        .unwrap();
    };
    let path = page.to_str().unwrap();

    // No "exports": every file is reachable. Found from a folder two levels below node_modules.
    write_page("@acme/kit/components/cart-panel.zb", " count={5}");
    let (ok, _, stderr) = zubra(&["check", path]);
    assert!(ok, "{stderr}");
    let (_, html, _) = zubra(&["compile", path, "--emit", "html"]);
    assert!(
        html.contains("<b>5</b>") && html.contains("<kit-dot><i></i></kit-dot>"),
        "{html}"
    );
    let (_, module, _) = zubra(&["compile", path, "--emit", "js"]);
    assert!(
        module.contains("import \"@acme/kit/components/cart-panel.js\""),
        "{module}"
    );
    // Its props are checked as any child's are, at the app's line.
    write_page("@acme/kit/components/cart-panel.zb", " cuont={5}");
    let (ok, _, stderr) = zubra(&["check", path]);
    assert!(
        !ok && stderr.contains("has no prop `cuont`") && stderr.contains("shop-page.zb"),
        "{stderr}"
    );

    // "exports" decides what can be imported, as Node does.
    let manifest = dir.join("node_modules/@acme/kit/package.json");
    fs::write(
        &manifest,
        r#"{ "name": "@acme/kit", "exports": { "./ui/*": { "require": "./nope/*", "import": "./components/*", "default": "./nope/*" } } }"#,
    )
    .unwrap();
    write_page("@acme/kit/ui/cart-panel.zb", "");
    let (ok, _, stderr) = zubra(&["check", path]);
    assert!(ok, "{stderr}");
    write_page("@acme/kit/components/cart-panel.zb", "");
    let (ok, _, stderr) = zubra(&["check", path]);
    assert!(
        !ok && stderr.contains("@acme/kit doesn't export ./components/cart-panel.zb"),
        "{stderr}"
    );

    // Not installed, and no such file: each says so.
    write_page("@acme/nope/x.zb", "");
    let (ok, _, stderr) = zubra(&["check", path]);
    assert!(
        !ok && stderr.contains("@acme/nope isn't installed"),
        "{stderr}"
    );
    write_page("@acme/kit/ui/cart-pane.zb", "");
    let (ok, _, stderr) = zubra(&["check", path]);
    assert!(
        !ok && stderr.contains("@acme/kit has no components/cart-pane.zb"),
        "{stderr}"
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn one_tag_has_one_definition_across_what_a_component_imports() {
    // A page defines a tag once, and the browser keeps whichever module loads first. Two of the
    // app's files with one tag, or two packages', anywhere in what a component imports, is an
    // error naming both, at the import that brings in the second. An app's component beside a
    // package's is fine: the app's stands in for the package's (the server and the plugin do that).
    let dir = temp_dir("one-definition");
    let kit = dir.join("node_modules/@acme/kit/components");
    let other = dir.join("node_modules/@other/ui");
    fs::create_dir_all(&kit).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::create_dir_all(dir.join("parts")).unwrap();
    let button = |attribute: &str| {
        format!("<action-button {attribute}><button>{{{attribute}}}</button></action-button>\n")
    };
    fs::write(kit.join("action-button.zb"), button("label")).unwrap();
    fs::write(
        kit.join("cart-panel.zb"),
        "<script>\n  import './action-button.zb'\n</script>\n<cart-panel><action-button label=\"Pay\"></action-button></cart-panel>\n",
    )
    .unwrap();
    fs::write(other.join("action-button.zb"), button("caption")).unwrap();
    fs::write(dir.join("action-button.zb"), button("text")).unwrap();
    fs::write(dir.join("parts/action-button.zb"), button("words")).unwrap();
    fs::write(
        dir.join("parts/toolbar.zb"),
        "<script>\n  import './action-button.zb'\n</script>\n<tool-bar><action-button words=\"Go\"></action-button></tool-bar>\n",
    )
    .unwrap();
    let page = dir.join("shop-page.zb");
    let check = |imports: &[&str]| {
        let lines: String = imports
            .iter()
            .map(|specifier| format!("  import '{specifier}'\n"))
            .collect();
        fs::write(
            &page,
            format!("<script>\n{lines}</script>\n<shop-page><p>shop</p></shop-page>\n"),
        )
        .unwrap();
        zubra(&["check", page.to_str().unwrap()])
    };

    // The app's own beside the package's, either order: the app's stands in.
    for imports in [
        ["./action-button.zb", "@acme/kit/components/cart-panel.zb"],
        ["@acme/kit/components/cart-panel.zb", "./action-button.zb"],
    ] {
        let (ok, _, stderr) = check(&imports);
        assert!(ok, "{imports:?}: {stderr}");
    }
    // The package's own, imported directly and through cart-panel: one file.
    let (ok, _, stderr) = check(&[
        "@acme/kit/components/action-button.zb",
        "@acme/kit/components/cart-panel.zb",
    ]);
    assert!(ok, "{stderr}");

    // Two of the app's: named, at the second import, with the import it came through.
    let (ok, _, stderr) = check(&["./action-button.zb", "./parts/toolbar.zb"]);
    assert!(!ok);
    assert!(
        stderr.contains("<action-button> has two definitions: action-button.zb and parts/action-button.zb, through `./parts/toolbar.zb`"),
        "{stderr}"
    );
    assert!(
        stderr.contains("shop-page.zb:3:"),
        "at the second import: {stderr}"
    );

    // Two packages': named, directly this time, so without "through".
    let (ok, _, stderr) = check(&[
        "@acme/kit/components/cart-panel.zb",
        "@other/ui/action-button.zb",
    ]);
    assert!(!ok);
    assert!(
        stderr.contains("has two definitions: @acme/kit/components/action-button.zb and @other/ui/action-button.zb.")
            && !stderr.contains("through"),
        "{stderr}"
    );

    // A component of the app's with the page's own tag is a second definition too.
    fs::write(
        dir.join("parts/shop-page.zb"),
        "<shop-page><p>other</p></shop-page>\n",
    )
    .unwrap();
    fs::write(
        dir.join("parts/shop-wrap.zb"),
        "<script>\n  import './shop-page.zb'\n</script>\n<shop-wrap><shop-page></shop-page></shop-wrap>\n",
    )
    .unwrap();
    let (ok, _, stderr) = check(&["./parts/shop-wrap.zb"]);
    assert!(
        !ok && stderr.contains("<shop-page> has two definitions"),
        "{stderr}"
    );
    fs::remove_dir_all(&dir).ok();
}
