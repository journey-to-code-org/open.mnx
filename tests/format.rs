//! `zubra fmt` against every `.zb` file in the repository: formatting changes nothing a
//! component compiles to except the length of whitespace runs with line breaks in them (which
//! render the same), and formatting a formatted file changes nothing.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use zubra::FormatOptions;

fn components(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !(name.starts_with('.')
                || ["node_modules", "target", "dist"].contains(&name.as_str()))
            {
                components(&path, found);
            }
        } else if name.ends_with(".zb") {
            found.push(path);
        }
    }
}

/// Every whitespace run with a line break in it (as source text, or `\n` escaped in a string)
/// becomes one line break: the only thing the formatter may change in compiled output.
fn normalize(output: &str) -> String {
    let bytes = output.as_bytes();
    let mut normalized = String::with_capacity(output.len());
    let mut at = 0;
    while at < bytes.len() {
        let start = at;
        let mut breaks = false;
        loop {
            match bytes.get(at) {
                Some(b' ' | b'\t' | b'\n') => {
                    breaks |= bytes[at] == b'\n';
                    at += 1;
                }
                Some(b'\\') if bytes.get(at + 1) == Some(&b'n') => {
                    breaks = true;
                    at += 2;
                }
                _ => break,
            }
        }
        if at > start {
            normalized.push_str(if breaks { "\n" } else { &output[start..at] });
        } else {
            let character = output[at..].chars().next().unwrap();
            normalized.push(character);
            at += character.len_utf8();
        }
    }
    normalized
}

/// What the component compiles to at `path` (its imports read from beside it), as JavaScript
/// and as a plain custom element.
fn compiled(source: &str, path: &Path) -> Option<(String, String)> {
    let path = path.to_str().unwrap();
    let js = zubra::compile_js_with(
        source,
        path,
        "@zubra/runtime",
        Some(".js"),
        &zubra::filesystem,
    )
    .ok()?;
    let element = zubra::compile_element_with(source, path, Some(".js"), &zubra::filesystem)
        .unwrap_or_default();
    Some((normalize(&js), normalize(&element)))
}

#[test]
fn formatting_every_component_keeps_what_it_compiles_to() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    components(root, &mut files);
    files.sort();
    assert!(files.len() > 150, "found {} components", files.len());
    let (mut formatted, mut changed, mut compiled_both) = (0, 0, 0);
    for file in &files {
        let source = fs::read_to_string(file).unwrap();
        let Ok(output) = zubra::format(&source, &FormatOptions::default()) else {
            // Fixtures of compile errors don't parse; the formatter refuses those.
            assert!(
                compiled(&source, file).is_none()
                    || zubra::format(&source, &FormatOptions::default()).is_ok(),
                "{}: compiles, but the formatter refused it",
                file.display()
            );
            continue;
        };
        formatted += 1;
        changed += usize::from(output != source.replace("\r\n", "\n"));
        let again = zubra::format(&output, &FormatOptions::default()).unwrap();
        assert_eq!(
            again,
            output,
            "{}: formatting twice changed it",
            file.display()
        );
        if let Some(before) = compiled(&source, file) {
            // Compile the formatted text at the same path, so its imports resolve the same.
            let after = compiled(&output, file).unwrap_or_else(|| {
                panic!("{}: compiled before formatting, not after", file.display())
            });
            assert_eq!(
                before.0,
                after.0,
                "{}: the JavaScript changed",
                file.display()
            );
            assert_eq!(
                before.1,
                after.1,
                "{}: the plain element changed",
                file.display()
            );
            compiled_both += 1;
        }
    }
    eprintln!(
        "{formatted} of {} formatted ({changed} changed), {compiled_both} compiled the same",
        files.len()
    );
    assert!(compiled_both > 150);
}

/// Ranges over every component: the edit changes only what it covers, keeps what the component
/// compiles to, is stable once applied, and over the whole file gives the whole format.
#[test]
fn range_formatting_every_component_changes_only_the_range_and_keeps_what_it_compiles_to() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    components(root, &mut files);
    files.sort();
    let options = FormatOptions::default();
    let (mut edits, mut compared) = (0, 0);
    for file in &files {
        let original = fs::read_to_string(file).unwrap().replace("\r\n", "\n");
        // The repository is formatted, so start from the same file laid out at another width:
        // there is then something for every range to do.
        let wide = FormatOptions {
            indent_width: 8,
            ..FormatOptions::default()
        };
        let Ok(source) = zubra::format(&original, &wide) else {
            continue;
        };
        let Ok(whole) = zubra::format(&source, &options) else {
            continue;
        };
        // The whole file as one range is the whole format.
        let all = zubra::format_range(&source, 0, source.len(), &options).unwrap();
        let everything = all.as_ref().map_or(source.clone(), |edit| {
            let mut out = source.clone();
            out.replace_range(edit.start..edit.end, &edit.text);
            out
        });
        assert_eq!(
            zubra::format(&everything, &options).unwrap(),
            whole,
            "{}: the range of the whole file",
            file.display()
        );
        // Windows of a few lines, down the file.
        let lines: Vec<usize> = std::iter::once(0)
            .chain(source.match_indices('\n').map(|(at, _)| at + 1))
            .collect();
        for window in lines.chunks(7).take(30) {
            let start = window[0];
            let end = window.last().copied().unwrap().min(source.len());
            let Some(edit) = zubra::format_range(&source, start, end, &options).unwrap() else {
                continue;
            };
            edits += 1;
            let mut out = source.clone();
            out.replace_range(edit.start..edit.end, &edit.text);
            assert_eq!(&out[..edit.start], &source[..edit.start]);
            assert_eq!(
                &out[edit.start + edit.text.len()..],
                &source[edit.end..],
                "{}: text outside the edit changed",
                file.display()
            );
            // Applied, the edited region has nothing left to do.
            // (An edit that opens with the line break before its first line starts at the end of
            // the line above; the region begins on the line after it.)
            let edited_start = edit.start + usize::from(edit.text.starts_with('\n'));
            let edited_end = edit.start + edit.text.len();
            assert_eq!(
                zubra::format_range(&out, edited_start, edited_end, &options).unwrap(),
                None,
                "{}: {start}..{end} isn't stable",
                file.display()
            );
            if let (Some(before), Some(after)) = (compiled(&source, file), compiled(&out, file)) {
                assert_eq!(
                    before,
                    after,
                    "{}: {start}..{end} changed the output",
                    file.display()
                );
                compared += 1;
            }
        }
    }
    eprintln!("{edits} range edits, {compared} compiled the same");
    assert!(
        edits > 100 && compared > 100,
        "{edits} edits, {compared} compared"
    );
}

#[test]
fn the_comparison_would_notice_a_change() {
    // The check above is only as good as `normalize`: it must keep real differences.
    assert_eq!(normalize("a\\n    b"), normalize("a\n b"));
    assert_ne!(normalize("a b"), normalize("ab"));
    assert_ne!(normalize("a  b"), normalize("a b"));
    assert_ne!(normalize("\"x\""), normalize("\"y\""));
}

fn zubra(arguments: &[&str], input: Option<&str>) -> (bool, String, String) {
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_zubra"))
        .args(arguments)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.unwrap_or("").as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn the_cli_formats_files_and_folders_checks_and_reads_stdin() {
    let dir = std::env::temp_dir().join(format!("zubra-fmt-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src/node_modules/pkg")).unwrap();
    let messy = "<x-a>\n<p>a</p>\n</x-a>\n";
    let tidy = "<x-a>\n  <p>a</p>\n</x-a>\n";
    fs::write(dir.join("src/a.zb"), messy).unwrap();
    fs::write(dir.join("src/b.zb"), tidy).unwrap();
    fs::write(dir.join("src/node_modules/pkg/c.zb"), messy).unwrap();
    let src = dir.join("src");
    let src = src.to_str().unwrap();

    let (ok, stdout, stderr) = zubra(&["fmt", src, "--check"], None);
    assert!(!ok, "--check fails when a file would change");
    assert!(
        stdout.contains("would format") && stdout.contains("a.zb") && !stdout.contains("b.zb"),
        "{stdout}"
    );
    assert!(stderr.contains("1 file is not formatted"), "{stderr}");
    assert_eq!(
        fs::read_to_string(dir.join("src/a.zb")).unwrap(),
        messy,
        "--check writes nothing"
    );

    let (ok, stdout, _) = zubra(&["fmt", src], None);
    assert!(ok);
    assert!(
        stdout.contains("formatted") && stdout.contains("a.zb"),
        "{stdout}"
    );
    assert_eq!(fs::read_to_string(dir.join("src/a.zb")).unwrap(), tidy);
    assert_eq!(
        fs::read_to_string(dir.join("src/node_modules/pkg/c.zb")).unwrap(),
        messy,
        "node_modules is skipped"
    );
    assert!(zubra(&["fmt", src, "--check"], None).0);

    let (ok, stdout, _) = zubra(&["fmt", "--stdin", "--tabs"], Some(messy));
    assert!(ok);
    assert_eq!(stdout, "<x-a>\n\t<p>a</p>\n</x-a>\n");
    let (ok, stdout, _) = zubra(&["fmt", "--stdin", "--indent", "4"], Some(messy));
    assert!(ok);
    assert_eq!(stdout, "<x-a>\n    <p>a</p>\n</x-a>\n");

    let (ok, _, stderr) = zubra(
        &["fmt", "--stdin", "broken.zb"],
        Some("<x-a>\n<p>\n</x-a>\n"),
    );
    assert!(!ok);
    assert!(
        stderr.contains("broken.zb") && stderr.contains("closing tag"),
        "{stderr}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_request_api_formats_too() {
    let request = serde_json::json!({
        "command": "format",
        "path": "/app/a.zb",
        "files": { "/app/a.zb": "<x-a>\n<p>a</p>\n</x-a>" },
        "indentWidth": 4,
    });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["output"], "<x-a>\n    <p>a</p>\n</x-a>\n");

    let request = serde_json::json!({ "command": "format", "path": "/app/a.zb", "files": { "/app/a.zb": "<x-a>\n<p>\n</x-a>" } });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
    assert_eq!(response["ok"], false);
    assert_eq!(response["diagnostics"][0]["severity"], "error");
}

#[test]
fn the_request_api_formats_a_range() {
    let source = "<x-a>\n<p>\nx\n</p>\n<i>y</i>\n</x-a>\n";
    let start = source.find("x\n").unwrap();
    let request = serde_json::json!({
        "command": "formatRange", "path": "a.zb", "files": { "a.zb": source },
        "start": start, "end": start + 1, "indentWidth": 4,
    });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let output: serde_json::Value =
        serde_json::from_str(response["output"].as_str().unwrap()).unwrap();
    let edit = &output["edit"];
    assert_eq!(edit["text"], "\n        x");
    let (from, to) = (
        edit["start"].as_u64().unwrap() as usize,
        edit["end"].as_u64().unwrap() as usize,
    );
    let mut out = source.to_owned();
    out.replace_range(from..to, edit["text"].as_str().unwrap());
    assert_eq!(out, "<x-a>\n<p>\n        x\n</p>\n<i>y</i>\n</x-a>\n");
    // Formatted already: no edit. A file that doesn't parse: an error with a diagnostic.
    let formatted = serde_json::json!({
        "command": "formatRange", "path": "a.zb", "files": { "a.zb": "<x-a>\n  <p>a</p>\n</x-a>\n" },
        "start": 8, "end": 12,
    });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&formatted.to_string())).unwrap();
    assert_eq!(response["output"].as_str().unwrap(), r#"{"edit":null}"#);
    let broken = serde_json::json!({
        "command": "formatRange", "path": "a.zb", "files": { "a.zb": "<x-a>\n  <p>\n</x-a>\n" },
        "start": 0, "end": 3,
    });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&broken.to_string())).unwrap();
    assert_eq!(response["ok"], false);
    let missing = serde_json::json!({ "command": "formatRange", "path": "a.zb", "files": { "a.zb": "<x-a></x-a>" } });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&missing.to_string())).unwrap();
    assert!(response["error"].as_str().unwrap().contains("start"));
}
