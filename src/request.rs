//! The compiler as one function: a JSON request in, a JSON response out.
//!
//! This is what the WebAssembly build exposes (and what anything embedding the compiler can
//! use): no filesystem, no process. The request carries every source the compilation needs, so
//! `.mnx` imports resolve against `files` the way the CLI resolves them against the disk.
//!
//! ```json
//! { "command": "compile", "emit": "js", "path": "/app/inbox.mnx",
//!   "files": { "/app/inbox.mnx": "…", "/app/badge.mnx": "…" },
//!   "runtime": "@mnx/runtime", "keepImports": true,
//!   "cssImport": "…", "cssImportInline": "…", "framework": "react",
//!   "modulePath": "inbox.js", "props": {}, "slots": {}, "slotSource": "html" }
//! ```
//!
//! The response is `{ "ok", "output", "error", "warnings", "diagnostics" }`: `output` is the
//! compiled text, `error` and `warnings` are rendered for a terminal, and `diagnostics` has
//! each one as `{ file, line, column, severity, message, help }` for editors. `command: "check"`
//! runs every check without producing output.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::{Diagnostic, Framework, StyleImports};

/// Handle a request (JSON text); always returns a response (JSON text), never panics on input.
pub fn handle(request: &str) -> String {
    let response = match serde_json::from_str::<Value>(request) {
        Ok(Value::Object(request)) => respond(&request),
        Ok(_) => failure("the request must be a JSON object"),
        Err(error) => failure(&format!("the request isn't JSON: {error}")),
    };
    response.to_string()
}

fn failure(message: &str) -> Value {
    json!({ "ok": false, "output": null, "error": message, "warnings": [], "diagnostics": [] })
}

fn respond(request: &Map<String, Value>) -> Value {
    let text = |key: &str| request.get(key).and_then(Value::as_str);
    let Some(path) = text("path") else {
        return failure("`path` is required");
    };
    let files: HashMap<String, String> = match request.get("files") {
        Some(Value::Object(files)) => files
            .iter()
            .filter_map(|(path, source)| {
                source
                    .as_str()
                    .map(|source| (normalize(path), source.to_owned()))
            })
            .collect(),
        _ => return failure("`files` must map paths to sources"),
    };
    let path = normalize(path);
    let Some(source) = files.get(&path) else {
        return failure(&format!("`files` has no source for `{path}`"));
    };
    let loader = |specifier: &str, from: &str| -> Result<(String, String), String> {
        if !(specifier.starts_with("./")
            || specifier.starts_with("../")
            || specifier.starts_with('/'))
        {
            return Err(
                "component imports must be relative paths (./ or ../) when compiling files"
                    .to_owned(),
            );
        }
        let resolved = if specifier.starts_with('/') {
            normalize(specifier)
        } else {
            let base = from.rsplit_once('/').map_or("", |(directory, _)| directory);
            normalize(&format!("{base}/{specifier}"))
        };
        files
            .get(&resolved)
            .map(|source| (resolved.clone(), source.clone()))
            .ok_or_else(|| format!("{resolved}: not among the request's files"))
    };

    let warnings = crate::warnings(source);
    let mut diagnostics: Vec<Value> = warnings
        .iter()
        .map(|warning| entry(&path, warning, "warning"))
        .collect();
    let rendered_warnings: Vec<String> = warnings
        .iter()
        .map(|warning| warning.render_warning(source, &path))
        .collect();
    let runtime = text("runtime").unwrap_or("@mnx/runtime");
    let command = text("command").unwrap_or("compile");
    let result = match (command, text("emit").unwrap_or("html")) {
        ("check", _) => crate::compile_js_with(source, &path, runtime, Some(".js"), &loader)
            .map(|_| String::new()),
        ("compile", "js") => match (text("cssImport"), text("cssImportInline")) {
            (Some(stylesheet), Some(inline)) => crate::compile_js_for_bundler(
                source,
                &path,
                runtime,
                StyleImports { stylesheet, inline },
                &loader,
            ),
            (None, None) => {
                let keep = request
                    .get("keepImports")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                crate::compile_js_with(source, &path, runtime, (!keep).then_some(".js"), &loader)
            }
            _ => return failure("`cssImport` and `cssImportInline` go together"),
        },
        ("compile", "html") => {
            let props = request
                .get("props")
                .cloned()
                .unwrap_or_else(|| json!({}))
                .to_string();
            let slots = request
                .get("slots")
                .cloned()
                .unwrap_or_else(|| json!({}))
                .to_string();
            let slot_source = match text("slotSource") {
                None | Some("template") => crate::SlotSource::Template,
                Some("html") => crate::SlotSource::Html,
                Some(other) => {
                    return failure(&format!(
                        "unknown slotSource `{other}`; expected template or html"
                    ))
                }
            };
            crate::compile_html_from(source, &path, &props, &slots, slot_source, &loader)
        }
        ("compile", "css")
            if request
                .get("noImports")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            crate::compile_css(source)
        }
        ("compile", "css") => crate::css_with(source, &path, &loader),
        ("compile", "dts") => {
            let framework = match text("framework") {
                Some("react") => Framework::React,
                Some("vue") => Framework::Vue,
                Some("svelte") => Framework::Svelte,
                Some("solid") => Framework::Solid,
                None | Some("none") => Framework::None,
                Some(other) => {
                    return failure(&format!(
                        "unknown framework `{other}`; expected react, vue, svelte, solid or none"
                    ))
                }
            };
            crate::compile_declarations_for(source, file_name(&path), framework)
        }
        ("compile", "manifest") => {
            let name = file_name(&path);
            let stem = crate::components::component_extension(name)
                .map_or(name, |extension| &name[..name.len() - extension.len()]);
            let default_module = format!("{stem}.js");
            crate::compile_manifest(source, text("modulePath").unwrap_or(&default_module))
        }
        ("compile", other) => {
            return failure(&format!(
                "unknown emit `{other}`; expected html, js, css, dts or manifest"
            ))
        }
        (other, _) => {
            return failure(&format!(
                "unknown command `{other}`; expected compile or check"
            ))
        }
    };
    match result {
        Ok(output) => json!({
            "ok": true,
            "output": if command == "check" { Value::Null } else { Value::String(output) },
            "error": null,
            "warnings": rendered_warnings,
            "diagnostics": diagnostics,
        }),
        Err(error) => {
            diagnostics.push(entry(&path, &error, "error"));
            json!({
                "ok": false,
                "output": null,
                "error": error.render_in(source, &path),
                "warnings": rendered_warnings,
                "diagnostics": diagnostics,
            })
        }
    }
}

fn entry(path: &str, diagnostic: &Diagnostic, severity: &str) -> Value {
    let file = diagnostic
        .file
        .as_ref()
        .map_or(path, |(file, _)| file.as_str());
    json!({
        "file": file,
        "line": diagnostic.span.line,
        "column": diagnostic.span.column,
        "severity": severity,
        "message": diagnostic.message,
        "help": diagnostic.help,
    })
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `/app/./x/../badge.mnx` → `/app/badge.mnx` (lexically; the request has no filesystem).
fn normalize(path: &str) -> String {
    let path = path.replace('\\', "/");
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(request: Value) -> Value {
        serde_json::from_str(&handle(&request.to_string())).unwrap()
    }

    const BADGE: &str = "<mnx-badge label=\"x\"><b>{label}</b></mnx-badge>";
    const INBOX: &str = "<script>import './parts/../badge.mnx'</script>\n<mnx-inbox><mnx-badge label=\"Ada\"></mnx-badge></mnx-inbox>";

    #[test]
    fn compiles_every_output_from_the_files_it_is_given() {
        let files = json!({ "/app/inbox.mnx": INBOX, "/app/badge.mnx": BADGE });
        let html = call(json!({ "path": "/app/inbox.mnx", "files": files, "emit": "html" }));
        assert_eq!(html["ok"], true, "{html}");
        assert!(html["output"].as_str().unwrap().contains("<b>Ada</b>"));
        let js = call(
            json!({ "path": "/app/inbox.mnx", "files": files, "emit": "js", "keepImports": true }),
        );
        assert!(
            js["output"]
                .as_str()
                .unwrap()
                .contains("import './parts/../badge.mnx'"),
            "{js}"
        );
        let js = call(json!({ "path": "/app/inbox.mnx", "files": files, "emit": "js" }));
        assert!(
            js["output"]
                .as_str()
                .unwrap()
                .contains("\"./parts/../badge.js\""),
            "{js}"
        );
        for emit in ["css", "dts", "manifest"] {
            let response = call(json!({ "path": "/app/badge.mnx", "files": files, "emit": emit }));
            assert_eq!(response["ok"], true, "{emit}: {response}");
        }
        let manifest =
            call(json!({ "path": "/app/badge.mnx", "files": files, "emit": "manifest" }));
        assert!(manifest["output"]
            .as_str()
            .unwrap()
            .contains("\"path\": \"badge.js\""));
        let react = call(
            json!({ "path": "/app/badge.mnx", "files": files, "emit": "dts", "framework": "react" }),
        );
        assert!(react["output"].as_str().unwrap().contains("MnxBadgeReact"));
    }

    #[test]
    fn reports_errors_and_warnings_for_terminals_and_editors() {
        let files = json!({ "/app/x.mnx": "<mnx-x hidden={false}>\n  <p>{hiden}</p>\n</mnx-x>" });
        let response = call(json!({ "command": "check", "path": "/app/x.mnx", "files": files }));
        assert_eq!(response["ok"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .starts_with("error: unknown reference `hiden`"));
        assert!(response["warnings"][0]
            .as_str()
            .unwrap()
            .starts_with("warning: prop `hidden`"));
        assert_eq!(
            response["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| (d["severity"].as_str().unwrap(), d["line"].as_u64().unwrap()))
                .collect::<Vec<_>>(),
            [("warning", 1), ("error", 2)]
        );
        assert_eq!(response["diagnostics"][1]["help"], "did you mean `hidden`?");

        let missing =
            call(json!({ "path": "/app/inbox.mnx", "files": { "/app/inbox.mnx": INBOX } }));
        assert!(
            missing["error"]
                .as_str()
                .unwrap()
                .contains("/app/badge.mnx: not among the request's files"),
            "{missing}"
        );
        let ok = call(
            json!({ "command": "check", "path": "/app/badge.mnx", "files": { "/app/badge.mnx": BADGE } }),
        );
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["output"], Value::Null);
    }

    #[test]
    fn bad_requests_get_a_reason_not_a_panic() {
        for (request, expected) in [
            ("[]", "JSON object"),
            ("{", "isn't JSON"),
            ("{\"files\": {}}", "`path` is required"),
            ("{\"path\": \"/a.mnx\"}", "`files` must map"),
            ("{\"path\": \"/a.mnx\", \"files\": {}}", "no source for `/a.mnx`"),
            ("{\"path\": \"/a.mnx\", \"files\": {\"/a.mnx\": \"<mnx-a></mnx-a>\"}, \"emit\": \"pdf\"}", "unknown emit"),
            ("{\"path\": \"/a.mnx\", \"files\": {\"/a.mnx\": \"<mnx-a></mnx-a>\"}, \"command\": \"run\"}", "unknown command"),
            ("{\"path\": \"/a.mnx\", \"files\": {\"/a.mnx\": \"<mnx-a></mnx-a>\"}, \"emit\": \"js\", \"cssImport\": \"x\"}", "go together"),
        ] {
            let response: Value = serde_json::from_str(&handle(request)).unwrap();
            assert_eq!(response["ok"], false);
            assert!(response["error"].as_str().unwrap().contains(expected), "{request}: {response}");
        }
    }

    #[test]
    fn paths_normalize_like_the_filesystem() {
        assert_eq!(normalize("/app/./x/../badge.mnx"), "/app/badge.mnx");
        assert_eq!(normalize("C:\\app\\x.mnx"), "C:/app/x.mnx");
        assert_eq!(normalize("/../a.mnx"), "/a.mnx");
        assert_eq!(normalize("../a/./b.mnx"), "../a/b.mnx");
    }
}
