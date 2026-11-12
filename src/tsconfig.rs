//! The `tsconfig.json` a component's TypeScript is compiled under.
//!
//! The compiler reads the nearest `tsconfig.json` above a component (following a relative
//! `extends`), through the same loader as its imports, so the CLI reads it from disk and the
//! WebAssembly build gets it in the request's files. Only the options that change what the
//! JavaScript does are read:
//!
//! - `verbatimModuleSyntax`: imports are kept as written, and a type imported without `type` is
//!   an error, as in `tsc` (TS1484);
//! - `useDefineForClassFields`, or the `target` that decides its default: whether class fields
//!   (and parameter properties) are defined fields or assignments in the constructor;
//! - `paths` and `baseUrl`: where a non-relative import of a TypeScript module is, for the enums
//!   in it.

use std::cell::RefCell;

use serde_json::{Map, Value};

use crate::components::Loader;

/// The options that change the output, with TypeScript's defaults for a modern target.
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub verbatim_module_syntax: bool,
    pub define_class_fields: bool,
    pub experimental_decorators: bool,
    /// `paths`, in order: a pattern (`@lib/*`) and where it maps (`/abs/src/lib/*`, …).
    pub paths: Vec<(String, Vec<String>)>,
    /// Where the `tsconfig.json` was found, for messages.
    pub file: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            verbatim_module_syntax: false,
            define_class_fields: true,
            experimental_decorators: false,
            paths: Vec::new(),
            file: None,
        }
    }
}

thread_local! {
    static CURRENT: RefCell<Options> = RefCell::new(Options::default());
}

/// The options for the component being compiled.
pub fn current() -> Options {
    CURRENT.with(|options| options.borrow().clone())
}

/// Run `f` with `options` as the current ones.
pub fn with<T>(options: Options, f: impl FnOnce() -> T) -> T {
    let previous = CURRENT.with(|current| current.replace(options));
    let result = f();
    CURRENT.with(|current| current.replace(previous));
    result
}

/// Whether a component (its source, at `path`) is TypeScript: only those read a tsconfig.json.
pub fn is_typescript(path: &str, source: &str) -> bool {
    if path.ends_with(".tsx") {
        return true;
    }
    // Any `<script …>` tag with `lang="ts"` (however it's spaced or quoted).
    let lower = source.to_ascii_lowercase();
    lower.match_indices("<script").any(|(start, _)| {
        let tag = &lower[start + "<script".len()..];
        let tag = &tag[..tag.find('>').unwrap_or(tag.len())];
        tag.match_indices("lang").any(|(at, _)| {
            let before = tag[..at].chars().last();
            let rest = tag[at + 4..].trim_start();
            before.is_some_and(char::is_whitespace)
                && rest.strip_prefix('=').is_some_and(|value| {
                    let value = value.trim_start();
                    let value = value.trim_start_matches(['"', '\'']);
                    value.starts_with("ts") && !value[2..].starts_with(char::is_alphanumeric)
                })
        })
    })
}

/// The options for the component at `path`: its nearest `tsconfig.json`, or the defaults.
pub fn for_component(path: &str, loader: Loader<'_>) -> Options {
    for depth in 0..16 {
        let specifier = if depth == 0 {
            "./tsconfig.json".to_owned()
        } else {
            format!("{}tsconfig.json", "../".repeat(depth))
        };
        if let Ok((found, source)) = loader(&specifier, path) {
            let mut compiler_options = Map::new();
            read(&found, &source, loader, &mut compiler_options, 0);
            return options(&found, &compiler_options);
        }
        // Past the root, a relative path stops resolving.
        if depth > 0 && path.matches('/').count() < depth {
            break;
        }
    }
    Options::default()
}

/// `compilerOptions` from `source` (at `path`) over those of what it extends.
fn read(path: &str, source: &str, loader: Loader<'_>, into: &mut Map<String, Value>, depth: u8) {
    let Some(config) = jsonc(source) else {
        return;
    };
    if depth < 8 {
        let extends: Vec<&str> = match config.get("extends") {
            Some(Value::String(one)) => vec![one.as_str()],
            Some(Value::Array(many)) => many.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        for parent in extends {
            // Relative ones only: a package's config would need node_modules resolution.
            if parent.starts_with("./") || parent.starts_with("../") {
                let specifier = if parent.ends_with(".json") {
                    parent.to_owned()
                } else {
                    format!("{parent}.json")
                };
                if let Ok((found, text)) = loader(&specifier, path) {
                    read(&found, &text, loader, into, depth + 1);
                }
            }
        }
    }
    if let Some(Value::Object(options)) = config.get("compilerOptions") {
        for (key, value) in options {
            // `paths` and `baseUrl` are relative to the file that sets them.
            let value = if key == "baseUrl" || key == "paths" {
                json_with_base(value, directory(path))
            } else {
                value.clone()
            };
            into.insert(key.clone(), value);
        }
    }
}

/// `{ value, base }`: a path option remembers the directory it's relative to.
fn json_with_base(value: &Value, base: &str) -> Value {
    serde_json::json!({ "value": value, "base": base })
}

/// The options `compilerOptions` sets (as given, with no file to resolve paths against).
pub fn from_compiler_options(compiler: &Map<String, Value>) -> Options {
    Options {
        file: None,
        ..options("", compiler)
    }
}

fn options(file: &str, compiler: &Map<String, Value>) -> Options {
    let flag = |name: &str| compiler.get(name).and_then(Value::as_bool);
    // `useDefineForClassFields` defaults to true for ES2022 and later (and ESNext), false below.
    let modern_target = compiler
        .get("target")
        .and_then(Value::as_str)
        .is_none_or(|target| {
            let target = target.to_ascii_lowercase();
            target == "esnext"
                || target
                    .strip_prefix("es")
                    .and_then(|year| year.parse::<u32>().ok())
                    .is_some_and(|year| year >= 2022)
        });
    let mut paths = Vec::new();
    if let Some(Value::Object(entry)) = compiler.get("paths") {
        // Relative to `baseUrl` when it's set, otherwise to the tsconfig that sets `paths`.
        let base = match compiler.get("baseUrl") {
            Some(Value::Object(base_url)) => join(
                base_url.get("base").and_then(Value::as_str).unwrap_or(""),
                base_url.get("value").and_then(Value::as_str).unwrap_or("."),
            ),
            _ => entry
                .get("base")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        };
        if let Some(Value::Object(patterns)) = entry.get("value") {
            for (pattern, targets) in patterns {
                let targets = targets
                    .as_array()
                    .map(|targets| {
                        targets
                            .iter()
                            .filter_map(Value::as_str)
                            .map(|target| join(&base, target))
                            .collect()
                    })
                    .unwrap_or_default();
                paths.push((pattern.clone(), targets));
            }
        }
    }
    Options {
        verbatim_module_syntax: flag("verbatimModuleSyntax").unwrap_or(false),
        define_class_fields: flag("useDefineForClassFields").unwrap_or(modern_target),
        experimental_decorators: flag("experimentalDecorators").unwrap_or(false),
        paths,
        file: Some(file.to_owned()),
    }
}

/// Where `specifier` maps under `paths`: candidate paths, most specific pattern first.
pub fn map_path(options: &Options, specifier: &str) -> Vec<String> {
    let mut found: Vec<(usize, Vec<String>)> = Vec::new();
    for (pattern, targets) in &options.paths {
        let matched = match pattern.split_once('*') {
            Some((prefix, suffix)) => specifier
                .strip_prefix(prefix)
                .and_then(|rest| rest.strip_suffix(suffix))
                .map(|star| (prefix.len(), star.to_owned())),
            None => (pattern == specifier).then(|| (pattern.len(), String::new())),
        };
        if let Some((specificity, star)) = matched {
            found.push((
                specificity,
                targets
                    .iter()
                    .map(|target| target.replacen('*', &star, 1))
                    .collect(),
            ));
        }
    }
    found.sort_by_key(|(specificity, _)| std::cmp::Reverse(*specificity));
    found.into_iter().flat_map(|(_, targets)| targets).collect()
}

fn directory(path: &str) -> &str {
    path.rfind('/').map_or("", |at| &path[..at])
}

/// `base` joined with a relative `path`, with `.` and `..` resolved.
fn join(base: &str, path: &str) -> String {
    let mut parts: Vec<&str> = if path.starts_with('/') {
        Vec::new()
    } else {
        base.split('/').collect()
    };
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if joined.starts_with('/') || base.is_empty() {
        joined
    } else {
        format!("/{}", joined.trim_start_matches('/'))
    }
}

/// JSON with comments and trailing commas, as `tsconfig.json` allows.
fn jsonc(text: &str) -> Option<Value> {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(character) = chars.next() {
        if in_string {
            out.push(character);
            match character {
                '\\' => {
                    if let Some(next) = chars.next() {
                        out.push(next);
                    }
                }
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (character, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(character);
            }
            ('/', Some('/')) => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut previous = ' ';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => out.push(character),
        }
    }
    // Trailing commas: a comma followed (after whitespace) by `}` or `]`.
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut in_string = false;
    let mut index = 0;
    while index < bytes.len() {
        let character = bytes[index];
        if in_string {
            cleaned.push(character);
            if character == '\\' && index + 1 < bytes.len() {
                cleaned.push(bytes[index + 1]);
                index += 1;
            } else if character == '"' {
                in_string = false;
            }
        } else if character == '"' {
            in_string = true;
            cleaned.push(character);
        } else if character == ',' {
            let next = bytes[index + 1..].iter().find(|next| !next.is_whitespace());
            if !matches!(next, Some('}' | ']')) {
                cleaned.push(character);
            }
        } else {
            cleaned.push(character);
        }
        index += 1;
    }
    serde_json::from_str(&cleaned).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_typescript_script_is_found_however_its_tag_is_spaced() {
        for source in [
            "<script lang=\"ts\">",
            "<script  lang=\"ts\">",
            "<script\n  lang='ts'>",
            "<SCRIPT lang = \"ts\">",
            "<script setup lang=ts>",
        ] {
            assert!(super::is_typescript("x.zb", source), "{source}");
        }
        for source in [
            "<script>",
            "<script lang=\"tsx\">",
            "<script data-lang=\"ts\">",
            "<p lang=\"ts\">",
        ] {
            assert!(!super::is_typescript("x.zb", source), "{source}");
        }
    }

    use super::*;

    #[test]
    fn reads_json_with_comments_and_trailing_commas() {
        let value = jsonc(
            "{\n  // a comment\n  \"a\": \"// not a comment\", /* block */\n  \"b\": [1, 2,],\n}",
        )
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "a": "// not a comment", "b": [1, 2] })
        );
    }

    #[test]
    fn maps_paths_most_specific_first() {
        let options = Options {
            paths: vec![
                ("@app/*".into(), vec!["/p/src/*".into()]),
                ("@app/enums/*".into(), vec!["/p/shared/enums/*".into()]),
            ],
            ..Options::default()
        };
        assert_eq!(
            map_path(&options, "@app/enums/size"),
            ["/p/shared/enums/size", "/p/src/enums/size"]
        );
        assert!(map_path(&options, "lodash").is_empty());
    }

    #[test]
    fn the_target_decides_how_class_fields_are_defined() {
        for (target, define) in [
            ("ES2022", true),
            ("esnext", true),
            ("ES2020", false),
            ("es5", false),
        ] {
            let mut compiler = Map::new();
            compiler.insert("target".into(), Value::String(target.into()));
            assert_eq!(
                options("/t.json", &compiler).define_class_fields,
                define,
                "{target}"
            );
        }
        let mut compiler = Map::new();
        compiler.insert("target".into(), Value::String("ES2020".into()));
        compiler.insert("useDefineForClassFields".into(), Value::Bool(true));
        assert!(options("/t.json", &compiler).define_class_fields);
    }
}
