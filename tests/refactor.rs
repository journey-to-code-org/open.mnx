//! `command: "refactor"`, `action: "extract"`: markup becomes a component. The cases are the
//! rules (what becomes a prop, an event, an import, a refusal), then every subtree of every
//! component in the repository: the result must compile, and the page must be the same apart
//! from the new tag.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use zubra::Extraction;

const LIST: &str = r#"<script>
  import { fmt } from './fmt.js'
  import './badge.zb'
  let items = [{ id: 1, name: "ada" }, { id: 2, name: "linus" }]
  const title = "People"
  let count = 0
  function remove() { count = count + 1 }
</script>
<x-list>
  <h1>{title}</h1>
  <ul>
    <zb-each items={items} as="item" key={item.id}>
      <li onclick={remove}><zb-badge label={item.name}></zb-badge> {fmt(item.name)} of {count}</li>
    </zb-each>
  </ul>
</x-list>
"#;

fn select(source: &str, from: &str, to: &str) -> (usize, usize) {
    let start = source.find(from).unwrap();
    let end = source[start..].find(to).unwrap() + start + to.len();
    (start, end)
}

fn extract(
    source: &str,
    start: usize,
    end: usize,
    tag: &str,
) -> Result<Extraction, zubra::Diagnostic> {
    let loader = |specifier: &str, _from: &str| match specifier {
        "./badge.zb" => Ok(("badge.zb".to_owned(), BADGE.to_owned())),
        _ => Err(format!("no {specifier}")),
    };
    zubra::extract(source, start, end, tag, "list.zb", &loader)
}

const BADGE: &str = "<zb-badge label=\"\"><b>{label}</b></zb-badge>";

fn apply(source: &str, extraction: &Extraction) -> String {
    let mut out = source.to_owned();
    for edit in extraction.edits.iter().rev() {
        out.replace_range(edit.start..edit.end, &edit.text);
    }
    out
}

#[test]
fn a_selection_becomes_a_component_with_props_events_and_imports() {
    let (start, end) = select(LIST, "<ul>", "</ul>");
    let extraction = extract(LIST, start, end, "people-list").unwrap();
    assert_eq!(extraction.file_name, "people-list.zb");
    assert_eq!(extraction.props, ["count", "items"]);
    assert_eq!(extraction.events, ["remove"]);
    let file = &extraction.file_source;
    assert!(file.contains("import { fmt } from './fmt.js'"), "{file}");
    assert!(
        file.contains("import './badge.zb'"),
        "the component it uses: {file}"
    );
    assert!(
        file.contains("import { emit } from '@zubra/runtime'"),
        "{file}"
    );
    assert!(file.contains("<people-list count items>"), "{file}");
    assert!(file.contains(r#"onclick={() => emit("remove")}"#), "{file}");
    assert!(file.contains("{fmt(item.name)}"), "{file}");
    let parent = apply(LIST, &extraction);
    assert!(
        parent
            .contains("<people-list count={count} items={items} onremove={remove}></people-list>"),
        "{parent}"
    );
    assert!(parent.contains("import './people-list.zb'"), "{parent}");
    assert!(!parent.contains("<zb-each"), "{parent}");
}

#[test]
fn both_files_compile_and_the_page_is_the_same_apart_from_the_new_tag() {
    let original = LIST
        .replace("{fmt(item.name)}", "{item.name}")
        .replace("  import { fmt } from './fmt.js'\n", "");
    let (start, end) = select(&original, "<ul>", "</ul>");
    let extraction = extract(&original, start, end, "people-list").unwrap();
    let parent = apply(&original, &extraction);
    let files: BTreeMap<&str, String> = BTreeMap::from([
        ("./badge.zb", BADGE.to_owned()),
        ("./people-list.zb", extraction.file_source.clone()),
    ]);
    let loader = |specifier: &str, _from: &str| {
        files
            .get(specifier)
            .map(|source| {
                (
                    specifier.trim_start_matches("./").to_owned(),
                    source.clone(),
                )
            })
            .ok_or_else(|| format!("no {specifier}"))
    };
    let before = zubra::compile_html_with(&original, "list.zb", "{}", "{}", &loader).unwrap();
    let after = zubra::compile_html_with(&parent, "list.zb", "{}", "{}", &loader).unwrap();
    assert_eq!(strip_tag(&after, "people-list"), squash(&before), "{after}");
    zubra::compile_js_with(&parent, "list.zb", "@zubra/runtime", None, &loader).unwrap();
}

#[test]
fn a_script_is_added_when_the_parent_has_none() {
    let source = "<x-card title=\"t\">\n  <h2>{title}</h2>\n  <p>body</p>\n</x-card>\n";
    let (start, end) = select(source, "<h2>", "</h2>");
    let extraction = extract(source, start, end, "card-title").unwrap();
    let parent = apply(source, &extraction);
    assert!(
        parent.starts_with("<script>\n  import './card-title.zb'\n</script>\n<x-card"),
        "{parent}"
    );
    assert!(
        parent.contains("<card-title title={title}></card-title>"),
        "{parent}"
    );
}

fn refused(source: &str, from: &str, to: &str, tag: &str) -> String {
    let (start, end) = select(source, from, to);
    extract(source, start, end, tag).unwrap_err().message
}

#[test]
fn what_it_can_t_extract_it_says_why() {
    let assigns = "<script>\n  let count = 0\n</script>\n<x-a>\n  <button onclick={() => count++}>{count}</button>\n</x-a>\n";
    let message = refused(assigns, "<button", "</button>", "a-b");
    assert!(message.contains("assigns to `count`"), "{message}");
    let bound =
        "<script>\n  let value = 'a'\n</script>\n<x-a>\n  <x-field value:bind={value}></x-field>\n</x-a>\n";
    let message = refused(bound, "<x-field", "</x-field>", "a-b");
    assert!(message.contains("assigns to `value`"), "{message}");
    let slot = "<x-a>\n  <section><zb-slot></zb-slot></section>\n</x-a>\n";
    assert!(refused(slot, "<section>", "</section>", "a-b").contains("<zb-slot>"));
    let call = "<script>\n  function pick(id) {}\n  let ids = [1]\n</script>\n<x-a>\n  <ul><zb-each items={ids} as=\"id\"><li onclick={() => pick(id)}>x</li></zb-each></ul>\n</x-a>\n";
    let message = refused(call, "<ul>", "</ul>", "a-b");
    assert!(
        message.contains("`pick`") && message.contains("event handler"),
        "{message}"
    );
    let shadow = "<x-a shadow>\n  <p>x</p>\n</x-a>\n";
    assert!(refused(shadow, "<p>", "</p>", "a-b").contains("shadow DOM"));
    let plain = "<x-a>\n  <div><p>x</p></div>\n</x-a>\n";
    assert!(refused(plain, "<p>", "</p>", "plain").contains("custom element name"));
    assert!(refused(plain, "<p>", "</p>", "x-a").contains("own tag"));
}

#[test]
fn markup_that_only_works_inside_its_parent_stays_there() {
    let select_box = "<x-a>\n  <select><option>one</option><option>two</option></select>\n</x-a>\n";
    let message = refused(
        select_box,
        "<option>one</option>",
        "<option>two</option>",
        "a-b",
    );
    assert!(
        message.contains("<option> only works directly inside"),
        "{message}"
    );
    // The whole <select> is fine.
    let (start, end) = select(select_box, "<select>", "</select>");
    extract(select_box, start, end, "a-b").unwrap();
    // A div between the two hides the parent, but not what the markup is.
    let row = "<x-a>\n  <div><tr><td>x</td></tr></div>\n</x-a>\n";
    assert!(refused(row, "<tr>", "</tr>", "a-b").contains("<tr> only works"));
    // A table's own children are refused by their parent.
    let table = "<x-a>\n  <table><caption>c</caption><p>x</p></table>\n</x-a>\n";
    let message = refused(table, "<p>", "</p>", "a-b");
    assert!(message.contains("<table> accepts only"), "{message}");
}

#[test]
fn a_function_used_as_a_handler_and_any_other_way_is_not_an_event() {
    let source = "<script>\n  function pick() {}\n</script>\n<x-a>\n  <p onclick={pick}>{pick}</p>\n</x-a>\n";
    let message = refused(source, "<p", "</p>", "a-b");
    assert!(
        message.contains("`pick`") && message.contains("event handler"),
        "{message}"
    );
}

#[test]
fn a_selection_that_isn_t_whole_sibling_nodes_is_refused() {
    let source = "<script>\n  let on = true\n</script>\n<x-a>\n  <div><p>one</p><p>two</p></div>\n  <zb-if test={on}><b>yes</b><zb-else><i>no</i></zb-else></zb-if>\n</x-a>\n";
    // half of a pair of tags
    let message = refused(source, "<div><p>one</p>", "<p>two</p>", "a-b");
    assert!(
        message.contains("whole sibling nodes") || message.contains("sibling"),
        "{message}"
    );
    let split = refused(source, "</p><p>two", "</div>", "a-b");
    assert!(split.contains("sibling"), "{split}");
    // an else without its if
    let orphan = refused(source, "<zb-else>", "</zb-else>", "a-b");
    assert!(orphan.contains("sibling"), "{orphan}");
    // outside the template
    let outside = refused(source, "let on = true", "true", "a-b");
    assert!(
        outside.contains("inside the component's template"),
        "{outside}"
    );
    // nothing selected
    let error = extract(source, 0, 0, "a-b").unwrap_err();
    assert!(
        error.message.contains("select the markup"),
        "{}",
        error.message
    );
}

#[test]
fn the_request_api_answers_with_json_text() {
    let (start, end) = select(LIST, "<ul>", "</ul>");
    let request = serde_json::json!({
        "command": "refactor", "action": "extract", "path": "list.zb",
        "files": { "list.zb": LIST }, "start": start, "end": end, "tag": "people-list",
    });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let output: serde_json::Value =
        serde_json::from_str(response["output"].as_str().unwrap()).unwrap();
    assert_eq!(output["fileName"], "people-list.zb");
    assert_eq!(output["edits"].as_array().unwrap().len(), 2);
    assert_eq!(output["events"][0], "remove");
    // A refusal is an error with a diagnostic at the selection.
    let request = serde_json::json!({
        "command": "refactor", "action": "extract", "path": "list.zb",
        "files": { "list.zb": LIST }, "start": 0, "end": 5, "tag": "people-list",
    });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
    assert_eq!(response["ok"], false);
    assert!(response["diagnostics"][0]["message"]
        .as_str()
        .unwrap()
        .contains("template"));
}

// ---- every subtree of every component in the repository -------------------------------------

fn squash(html: &str) -> String {
    html.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `html` without the new tag's start and end tags, whitespace squashed.
fn strip_tag(html: &str, tag: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(at) = rest.find(&format!("<{tag}")) {
        out.push_str(&rest[..at]);
        let close = rest[at..].find('>').unwrap() + at + 1;
        rest = &rest[close..];
    }
    out.push_str(rest);
    squash(&out.replace(&format!("</{tag}>"), ""))
}

/// The host tag: the first top-level element after the comment, script and style.
fn host_tag(source: &str) -> Option<String> {
    let mut at = 0;
    while at < source.len() {
        let rest = &source[at..];
        if rest.starts_with("<!--") {
            at += rest.find("-->")? + 3;
        } else if rest.starts_with("<script") {
            at += rest.find("</script>")? + 9;
        } else if rest.starts_with("<style") {
            at += rest.find("</style>")? + 8;
        } else if rest.starts_with('<') {
            let name: String = rest['<'.len_utf8()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            return name.contains('-').then_some(name);
        } else {
            at += rest.chars().next()?.len_utf8();
        }
    }
    None
}

fn components(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !(name.starts_with('.')
                || ["node_modules", "target", "dist", "fixtures"].contains(&name.as_str()))
            {
                components(&path, found);
            }
        } else if name.ends_with(".zb") {
            found.push(path);
        }
    }
}

/// Byte ranges of each element with its end tag, found by balancing tags in `text[from..to]`.
fn subtrees(source: &str, from: usize, to: usize) -> Vec<(usize, usize)> {
    const VOID: &[&str] = &[
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
        "track", "wbr",
    ];
    let bytes = source.as_bytes();
    let mut stack: Vec<(String, usize)> = Vec::new();
    let mut found = Vec::new();
    let mut at = from;
    while at < to {
        if source[at..].starts_with("<!--") {
            at = source[at..].find("-->").map_or(to, |end| at + end + 3);
        } else if bytes[at] == b'<' {
            let closing = bytes.get(at + 1) == Some(&b'/');
            let name_start = at + 1 + usize::from(closing);
            let name: String = source[name_start..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            if name.is_empty() {
                at += 1;
                continue;
            }
            // to the end of the tag, past quotes and braces
            let (mut depth, mut quote, mut end) = (0usize, None, name_start);
            while end < to {
                let byte = bytes[end];
                match quote {
                    Some(open) => {
                        if byte == open {
                            quote = None;
                        }
                    }
                    None => match byte {
                        b'"' | b'\'' => quote = Some(byte),
                        b'{' => depth += 1,
                        b'}' => depth = depth.saturating_sub(1),
                        b'>' if depth == 0 => break,
                        _ => {}
                    },
                }
                end += 1;
            }
            let self_closing = bytes.get(end.wrapping_sub(1)) == Some(&b'/');
            if closing {
                if let Some(index) = stack.iter().rposition(|(open, _)| *open == name) {
                    let (_, start) = stack[index].clone();
                    stack.truncate(index);
                    found.push((start, end + 1));
                }
            } else if self_closing || VOID.contains(&name.as_str()) {
                found.push((at, end + 1));
            } else {
                stack.push((name, at));
            }
            at = end + 1;
        } else {
            at += source[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    found
}

#[test]
fn every_subtree_of_every_component_extracts_or_says_why_and_the_page_stays_the_same() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    components(root, &mut files);
    files.sort();
    let (mut extracted, mut refused_count, mut compared) = (0, 0, 0);
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    for path in &files {
        let Ok(source) = fs::read_to_string(path) else {
            continue;
        };
        if source.contains("extends HTMLElement")
            || zubra::compile_js(&source, "@zubra/runtime", "x.zb").is_err()
        {
            continue; // not a component that compiles on its own (needs imports resolved from disk, or JSX)
        }
        let Some(tag) = host_tag(&source) else {
            continue;
        };
        let Some(host) = source.rfind(&format!("</{tag}")) else {
            continue;
        };
        let open = source.find(&format!("<{tag}")).unwrap_or(0);
        let open_end = source[open..].find('>').map_or(open, |at| open + at + 1);
        let mut ranges = subtrees(&source, open_end, host);
        ranges.sort();
        ranges.truncate(40);
        for (start, end) in ranges {
            let origin_path = path.to_string_lossy().into_owned();
            match zubra::extract(
                &source,
                start,
                end,
                "x-extracted",
                &origin_path,
                &zubra::filesystem,
            ) {
                Err(error) => {
                    refused_count += 1;
                    let reason = error
                        .message
                        .split(['`', '('])
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_owned();
                    *reasons.entry(reason).or_default() += 1;
                }
                Ok(extraction) => {
                    extracted += 1;
                    let parent = apply(&source, &extraction);
                    let directory = path.parent().unwrap().to_path_buf();
                    let child = extraction.file_source.clone();
                    let loader = |specifier: &str, from: &str| {
                        if specifier == "./x-extracted.zb" {
                            return Ok(("x-extracted.zb".to_owned(), child.clone()));
                        }
                        zubra::filesystem(specifier, from)
                    };
                    let location = path.strip_prefix(root).unwrap().display();
                    let origin = directory.join("parent.zb");
                    let origin = origin.to_string_lossy();
                    zubra::compile_js_with(&parent, &origin, "@zubra/runtime", None, &loader)
                        .unwrap_or_else(|error| {
                            panic!("{location}: {start}..{end}: parent: {}\n{parent}\n--- child\n{child}", error.message)
                        });
                    let before =
                        zubra::compile_html_with(&source, &origin, "{}", "{}", &zubra::filesystem);
                    let after = zubra::compile_html_with(&parent, &origin, "{}", "{}", &loader);
                    if let (Ok(before), Ok(after)) = (&before, &after) {
                        compared += 1;
                        assert_eq!(
                            strip_tag(after, "x-extracted"),
                            squash(before),
                            "{location}: {start}..{end}\n{parent}\n--- child\n{child}"
                        );
                    }
                }
            }
        }
    }
    println!("extracted {extracted}, refused {refused_count}, compared HTML for {compared}: {reasons:#?}");
    assert!(extracted > 100, "extracted {extracted}");
    assert!(compared > 50, "compared {compared}");
}
