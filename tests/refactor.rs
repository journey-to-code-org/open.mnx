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
    assert_eq!(
        message,
        "the selection starts a <div> it doesn't end: select whole elements"
    );
    let split = refused(source, "</p><p>two", "</div>", "a-b");
    assert_eq!(
        split,
        "the selection ends a <p> it doesn't start: select whole elements"
    );
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

/// Extract, then check what the editor would write: both files compile, with the new one
/// found by its import.
fn extracted(source: &str, from: &str, to: &str) -> (Extraction, String) {
    let (start, end) = select(source, from, to);
    let extraction = extract(source, start, end, "a-b")
        .unwrap_or_else(|error| panic!("refused: {}", error.message));
    let parent = apply(source, &extraction);
    let child = extraction.file_source.clone();
    let loader = |specifier: &str, _from: &str| match specifier {
        "./a-b.zb" => Ok(("a-b.zb".to_owned(), child.clone())),
        "./badge.zb" => Ok(("badge.zb".to_owned(), BADGE.to_owned())),
        _ => Err(format!("no {specifier}")),
    };
    zubra::compile_js_with(&parent, "list.zb", "@zubra/runtime", None, &loader)
        .unwrap_or_else(|error| panic!("{}\n{parent}\n--- child\n{child}", error.message));
    (extraction, parent)
}

#[test]
fn a_selection_inside_a_tag_a_comment_an_expression_or_a_textarea_is_refused() {
    // Each of these reads as markup when parsed on its own, which is all the first version did.
    let source = r#"<script>
  let count = 0
  const label = "Total"
</script>
<x-a>
  <a href="/x" class="big link" title="<b>t</b>">go</a>
  <!-- <p>old markup</p> -->
  <p>{count + 1} {"<i>text</i>"} {count > 0 ? "<u>yes</u>" : label}</p>
  <textarea name="note"><b>shown as text</b></textarea>
  <p>longword</p>
</x-a>
"#;
    for (from, to, why) in [
        // An attribute's value, and attributes without their tag.
        ("<b>t</b>", "</b>", "inside the <a> tag itself"),
        ("class=\"big link\"", "link\"", "inside the <a> tag itself"),
        ("href=\"/x\"", "\">go", "inside the <a> tag itself"),
        // A comment's content.
        ("<p>old markup</p>", "</p>", "inside a comment"),
        // Part of an expression, and strings in one.
        ("count + 1", "1", "inside a {…} expression"),
        ("<i>text</i>", "</i>", "inside a {…} expression"),
        ("<u>yes</u>", "</u>", "inside a {…} expression"),
        // A textarea's content is text.
        (
            "<b>shown as text</b>",
            "</b>",
            "inside <textarea>, whose content is text",
        ),
        // Half a word.
        ("long", "long", "in the middle of a word"),
        // A start tag without its element.
        ("<a href", "\">", "starts a <a> it doesn't end"),
    ] {
        let message = refused(source, from, to, "a-b");
        assert!(message.contains(why), "{from} … {to}: {message}");
    }
    // Whole pieces still extract: text with an expression, a whole expression, a whole element.
    let (extraction, _) = extracted(source, "{count + 1}", "label}");
    assert_eq!(extraction.props, ["count", "label"]);
    let (extraction, parent) = extracted(source, "<a href", "</a>");
    assert!(extraction
        .file_source
        .contains(r#"title="<b>t</b>">go</a>"#));
    assert!(parent.contains("<a-b></a-b>"), "{parent}");
    // A comment between elements goes with them.
    extracted(source, "<a href", "label}</p>");
}

#[test]
fn an_import_brings_in_the_names_it_binds_and_no_others() {
    // `size` is this component's prop; the import binds `width`. `from` is a keyword here.
    let source = "<script>\n  import { size as width } from './units.js'\n  import * as shapes from './shapes.js'\n  import round, { half } from './round.js'\n  const from = 3\n</script>\n<x-a size={1}>\n  <p>{size} {width(2)} {from}</p>\n  <b>{shapes.square(2)} {round(1.5)} {half(4)}</b>\n</x-a>\n";
    let (extraction, _) = extracted(source, "<p>", "</p>");
    assert_eq!(extraction.props, ["from", "size"]);
    assert!(extraction
        .file_source
        .contains("import { size as width } from './units.js'"));
    assert!(!extraction.file_source.contains("shapes"));
    let (extraction, _) = extracted(source, "<b>", "</b>");
    assert!(extraction.props.is_empty(), "{:?}", extraction.props);
    assert!(extraction
        .file_source
        .contains("import * as shapes from './shapes.js'"));
    assert!(extraction
        .file_source
        .contains("import round, { half } from './round.js'"));
}

#[test]
fn what_the_browser_provides_is_not_a_prop() {
    let source = "<script>\n  let saved = false\n</script>\n<x-a>\n  <button onclick={() => setTimeout(() => console.log(localStorage.length, location.href, fetch, structuredClone, requestAnimationFrame), 10)}>{saved}</button>\n</x-a>\n";
    let (extraction, _) = extracted(source, "<button", "</button>");
    assert_eq!(extraction.props, ["saved"]);
}

#[test]
fn a_loop_s_name_is_the_parent_s_outside_the_loop() {
    // `item` is the parent's state before the list, and the loop's own inside it.
    let source = "<script>\n  let item = \"outside\"\n  let items = [1, 2]\n</script>\n<x-a>\n  <section><p>{item}</p><ul><zb-each items={items} as=\"item\" index=\"i\"><li>{i}: {item}</li></zb-each></ul></section>\n</x-a>\n";
    let (extraction, parent) = extracted(source, "<section>", "</section>");
    assert_eq!(extraction.props, ["item", "items"]);
    assert!(
        parent.contains("<a-b item={item} items={items}></a-b>"),
        "{parent}"
    );
    // Only the loop: `item` and `i` are its own.
    let (extraction, _) = extracted(source, "<zb-each", "</zb-each>");
    assert_eq!(extraction.props, ["items"]);
    // A zb-then's value is bound in its branch only, too.
    let awaited = "<script>\n  let user = \"x\"\n  let load = null\n</script>\n<x-a>\n  <div><i>{user}</i><zb-await value={load}><zb-then as=\"user\"><b>{user.name}</b></zb-then></zb-await></div>\n</x-a>\n";
    let (extraction, _) = extracted(awaited, "<div>", "</div>");
    assert_eq!(extraction.props, ["load", "user"]);
}

#[test]
fn slotted_content_is_refused_since_it_would_lose_its_slot() {
    let source = "<x-a>\n  <x-card><h2 slot=\"title\">Title</h2><p>Body</p></x-card>\n</x-a>\n";
    let message = refused(source, "<h2", "</h2>", "a-b");
    assert!(message.contains("`title` slot"), "{message}");
    // What's inside it, and the default content, are fine.
    extracted(source, "Title", "Title");
    extracted(source, "<p>Body</p>", "</p>");
}

#[test]
fn a_handler_that_takes_the_event_is_refused_and_one_that_doesn_t_becomes_an_event() {
    let takes = "<script>\n  let sent = 0\n  function save(event) { event.preventDefault(); sent = sent + 1 }\n</script>\n<x-a>\n  <form onsubmit={save}><button>Save {sent}</button></form>\n</x-a>\n";
    let message = refused(takes, "<form", "</form>", "a-b");
    assert!(
        message.contains("`save` takes the event") && message.contains("preventDefault"),
        "{message}"
    );
    let plain = takes.replace("save(event) { event.preventDefault(); ", "save() { ");
    let (extraction, parent) = extracted(&plain, "<form", "</form>");
    assert_eq!(extraction.events, ["save"]);
    assert!(parent.contains("onsave={save}"), "{parent}");
    assert!(extraction
        .file_source
        .contains(r#"onsubmit={() => emit("save")}"#));
    // Spacing and the other ways to write a function.
    for declaration in [
        "function  save ( e ) {}",
        "async function save(event, more) {}",
        "function* save(event) {}",
    ] {
        let source = takes.replace(
            "function save(event) { event.preventDefault(); sent = sent + 1 }",
            declaration,
        );
        assert!(
            refused(&source, "<form", "</form>", "a-b").contains("takes the event"),
            "{declaration}"
        );
    }
}

#[test]
fn what_the_server_could_not_pass_as_a_prop_is_refused() {
    // A function in a const: the reason names it.
    let function = "<script>\n  let n = 1\n  const double = (value) => value * 2\n</script>\n<x-a>\n  <p>{double(n)}</p>\n</x-a>\n";
    let message = refused(function, "<p>", "</p>", "a-b");
    assert!(
        message.contains("`double`, a function of this component"),
        "{message}"
    );
    // A value only the browser has: the parent rendered on the server, and the new component
    // would need the value as a required prop to render at all.
    let runtime =
        "<script>\n  const stamp = Date.now()\n</script>\n<x-a>\n  <p>at {stamp}</p>\n</x-a>\n";
    let rendered = zubra::compile_html_with_options(
        runtime,
        "list.zb",
        "{}",
        "{}",
        zubra::HtmlOptions {
            slot_source: zubra::SlotSource::Template,
            partial: true,
            pending: Vec::new(),
        },
        &zubra::filesystem,
    );
    assert!(rendered.is_ok(), "the parent renders before: {rendered:?}");
    let message = refused(runtime, "<p>", "</p>", "a-b");
    assert!(
        message.contains("renders on the server now, and wouldn't"),
        "{message}"
    );
}

#[test]
fn the_new_tag_must_be_free() {
    // Zubra's own tags.
    for tag in ["zb-slot", "zb-if", "zb-each", "zb-await", "zb-window"] {
        let message = refused(LIST, "<h1>", "</h1>", tag);
        assert!(
            message.contains("one of Zubra's own tags"),
            "{tag}: {message}"
        );
    }
    // A component this one imports, by its tag and by its file; an element it already uses.
    let message = refused(LIST, "<h1>", "</h1>", "zb-badge");
    assert!(message.contains("already uses <zb-badge>"), "{message}");
    let other = LIST.replace(
        "<h1>{title}</h1>",
        "<h1>{title}</h1>\n  <other-thing></other-thing>",
    );
    let message = refused(&other, "<h1>", "</h1>", "other-thing");
    assert!(message.contains("already uses <other-thing>"), "{message}");
    let by_file = "<script>\n  import './a-b.zb'\n</script>\n<x-a>\n  <p>x</p>\n</x-a>\n";
    let (start, end) = select(by_file, "<p>", "</p>");
    let error = extract(by_file, start, end, "a-b").unwrap_err();
    assert!(
        error.message.contains("already uses <a-b>"),
        "{}",
        error.message
    );
}

#[test]
fn preformatted_text_is_moved_exactly_as_written() {
    let source = "<x-a>\n      <div>\n        <pre>\n  two\n      six\n</pre>\n        <textarea>\n  kept\n</textarea>\n      </div>\n</x-a>\n";
    let (extraction, _) = extracted(source, "<div>", "</div>");
    assert!(
        extraction
            .file_source
            .contains("<pre>\n  two\n      six\n</pre>"),
        "{}",
        extraction.file_source
    );
    assert!(extraction
        .file_source
        .contains("<textarea>\n  kept\n</textarea>"));
    // Other markup is still re-indented under the new tag.
    let plain = "<x-a>\n      <div>\n        <p>x</p>\n      </div>\n</x-a>\n";
    let (extraction, _) = extracted(plain, "<div>", "</div>");
    assert!(
        extraction
            .file_source
            .contains("<a-b>\n  <div>\n    <p>x</p>\n  </div>\n</a-b>"),
        "{}",
        extraction.file_source
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
                    // A page that rendered before renders after, and is the same page. (This
                    // used to skip "rendered before, fails after", which is the case that matters.)
                    if let Ok(before) = &before {
                        let after = after.as_ref().unwrap_or_else(|error| {
                            panic!("{location}: {start}..{end}: rendered before, and after: {}\n{parent}\n--- child\n{child}", error.message)
                        });
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

/// Any selection at all, in every component of the repository: where it starts and ends is
/// arbitrary (inside tags, attribute values, comments, expressions, words). It is refused, or
/// what it writes compiles and renders the same page. The subtree test above only ever selects
/// whole elements, which is the one kind of selection the first version got right.
#[test]
fn any_selection_at_all_is_refused_or_leaves_a_page_that_compiles_and_renders_the_same() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    components(root, &mut files);
    files.sort();
    // A fixed sequence, so a failure can be run again.
    let mut seed: u64 = 0x5EED_2026;
    let mut next = move |below: usize| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % below.max(1)
    };
    let (mut tried, mut extracted, mut compared) = (0, 0, 0);
    for path in &files {
        let Ok(source) = fs::read_to_string(path) else {
            continue;
        };
        if source.contains("extends HTMLElement")
            || zubra::compile_js(&source, "@zubra/runtime", "x.zb").is_err()
        {
            continue;
        }
        let Some(tag) = host_tag(&source) else {
            continue;
        };
        let template = source.find(&format!("<{tag}")).unwrap_or(0);
        let directory = path.parent().unwrap().to_path_buf();
        let origin = directory.join("parent.zb");
        let origin = origin.to_string_lossy().into_owned();
        let location = path.strip_prefix(root).unwrap().display().to_string();
        for _ in 0..60 {
            // Mostly short selections inside the template; some anywhere.
            let start = template + next(source.len() - template);
            let reach = if next(4) == 0 { source.len() } else { 120 };
            let end = (start + 1 + next(reach)).min(source.len());
            // Half of them snapped to where markup starts and ends (`<`, `{` … `>`, `}`): these
            // look like elements, and are often half of one, or inside a comment or expression.
            let on_characters = source.is_char_boundary(start) && source.is_char_boundary(end);
            let (start, end) = if on_characters && next(2) == 0 {
                let from = source[start..]
                    .find(['<', '{'])
                    .map_or(start, |at| start + at);
                let to = source[..end.max(from)]
                    .rfind(['>', '}'])
                    .map_or(end, |at| at + 1);
                (from, to.max(from))
            } else {
                (start, end)
            };
            if start >= end {
                continue;
            }
            tried += 1;
            // An offset inside a character (an editor counting in other units) is refused, not a panic.
            if !source.is_char_boundary(start) || !source.is_char_boundary(end) {
                assert!(zubra::extract(
                    &source,
                    start,
                    end,
                    "x-extracted",
                    &origin,
                    &zubra::filesystem
                )
                .is_err());
                continue;
            }
            let Ok(extraction) = zubra::extract(
                &source,
                start,
                end,
                "x-extracted",
                &origin,
                &zubra::filesystem,
            ) else {
                continue;
            };
            extracted += 1;
            let parent = apply(&source, &extraction);
            let child = extraction.file_source.clone();
            let loader = |specifier: &str, from: &str| {
                if specifier == "./x-extracted.zb" {
                    return Ok(("x-extracted.zb".to_owned(), child.clone()));
                }
                zubra::filesystem(specifier, from)
            };
            let selected = &source[start..end];
            zubra::compile_js_with(&parent, &origin, "@zubra/runtime", None, &loader)
                .unwrap_or_else(|error| {
                    panic!("{location}: {start}..{end} ({selected:?}): {}\n{parent}\n--- child\n{child}", error.message)
                });
            if let Ok(before) =
                zubra::compile_html_with(&source, &origin, "{}", "{}", &zubra::filesystem)
            {
                let after = zubra::compile_html_with(&parent, &origin, "{}", "{}", &loader)
                    .unwrap_or_else(|error| {
                        panic!("{location}: {start}..{end} ({selected:?}): rendered before, and after: {}", error.message)
                    });
                compared += 1;
                // The same page: its elements, attributes and text. Hydration markers
                // (`<?zb …?>`) aren't content, and where a text binding sits decides whether it
                // needs one: `{status}` moved into a component of its own gains an anchor.
                let visible = |html: &str| {
                    let mut out = String::new();
                    let mut rest = html;
                    while let Some(at) = rest.find("<?zb") {
                        out.push_str(&rest[..at]);
                        rest = rest[at..]
                            .find("?>")
                            .map_or("", |end| &rest[at + end + 2..]);
                    }
                    out.push_str(rest);
                    squash(&out)
                };
                assert_eq!(
                    visible(&strip_tag(&after, "x-extracted")),
                    visible(&before),
                    "{location}: {start}..{end} ({selected:?})\n{parent}\n--- child\n{child}"
                );
            }
        }
    }
    println!("tried {tried}, extracted {extracted}, compared HTML for {compared}");
    assert!(tried > 3000, "tried {tried}");
    assert!(extracted > 30, "extracted {extracted}");
}
