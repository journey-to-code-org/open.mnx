//! The features of this release against each other: what one writes, another must accept.
use std::fs;
use std::path::{Path, PathBuf};
use zubra::{extract, format, format_range, FormatOptions};

const LIST: &str = "<script>\n  let items = [{ id: 1, name: \"ada\" }]\n  let title = \"People\"\n</script>\n<x-list>\n  <h1>{title}</h1>\n  <ul>\n    <zb-each items={items} as=\"item\" key={item.id}>\n      <li>{item.name}</li>\n    </zb-each>\n  </ul>\n</x-list>\n";

fn select(source: &str, from: &str, to: &str) -> (usize, usize) {
    let start = source.find(from).unwrap();
    let end = start + source[start..].find(to).unwrap() + to.len();
    (start, end)
}

fn apply(source: &str, edits: &[zubra::Edit]) -> String {
    let mut out = source.to_owned();
    for edit in edits.iter().rev() {
        out.replace_range(edit.start..edit.end, &edit.text);
    }
    out
}

fn components(directory: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !matches!(name.as_str(), "node_modules" | "target" | ".git" | "dist") {
                components(&path, out);
            }
        } else if name.ends_with(".zb") {
            out.push(path);
        }
    }
}

/// Extract to component, then `zubra fmt --check`: a repository that checks its formatting in
/// CI (this one does) must not fail because of a refactoring the editor offered.
#[test]
fn what_extract_writes_is_already_formatted() {
    let (start, end) = select(LIST, "<ul>", "</ul>");
    let extraction = extract(LIST, start, end, "people-list", "list.zb", &|_, _| {
        Err("none".to_owned())
    })
    .unwrap();
    let options = FormatOptions::default();
    assert_eq!(
        format(&extraction.file_source, &options).unwrap(),
        extraction.file_source,
        "the new file"
    );
    let parent = apply(LIST, &extraction.edits);
    assert_eq!(
        format(&parent, &options).unwrap(),
        parent,
        "the edited file"
    );
}

/// The same across the repository's own components, which are all formatted: after any whole
/// element is extracted, both files still are.
#[test]
fn extracting_from_the_repository_s_components_leaves_them_formatted() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    components(root, &mut files);
    files.sort();
    let options = FormatOptions::default();
    let (mut extracted, mut unformatted) = (0, Vec::new());
    for path in &files {
        let Ok(source) = fs::read_to_string(path) else {
            continue;
        };
        if format(&source, &options).ok().as_deref() != Some(source.as_str()) {
            continue; // a fixture that isn't formatted, or doesn't parse
        }
        let origin = path.parent().unwrap().join("parent.zb");
        let origin = origin.to_string_lossy().into_owned();
        // Every element that starts a line and ends one.
        for (start, _) in source.match_indices("\n  <") {
            let start = start + 1 + source[start + 1..].find('<').unwrap();
            let name: String = source[start + 1..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            let close = format!("</{name}>");
            let Some(end) = source[start..]
                .find(&close)
                .map(|at| start + at + close.len())
            else {
                continue;
            };
            let Ok(extraction) = extract(
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
            let parent = apply(&source, &extraction.edits);
            for (what, text) in [("new file", &extraction.file_source), ("parent", &parent)] {
                if format(text, &options).ok().as_deref() != Some(text.as_str()) {
                    unformatted.push(format!(
                        "{}: {what} after extracting {start}..{end}",
                        path.strip_prefix(root).unwrap().display()
                    ));
                }
            }
        }
    }
    println!("extracted {extracted}, unformatted {}", unformatted.len());
    assert!(extracted > 100, "extracted {extracted}");
    assert!(
        unformatted.is_empty(),
        "{} of {extracted}:\n{}",
        unformatted.len(),
        unformatted[..unformatted.len().min(12)].join("\n")
    );
}

/// A file with CRLF line endings: the formatter keeps them, so extract must too, in the edits to
/// the file and in the new one. Otherwise the edited file has both kinds.
#[test]
fn extract_keeps_a_crlf_file_s_line_endings() {
    let source = LIST.replace('\n', "\r\n");
    let (start, end) = select(&source, "<ul>", "</ul>");
    let extraction = extract(&source, start, end, "people-list", "list.zb", &|_, _| {
        Err("none".to_owned())
    })
    .unwrap();
    let parent = apply(&source, &extraction.edits);
    for (what, text) in [("parent", &parent), ("new file", &extraction.file_source)] {
        assert!(
            !text.replace("\r\n", "").contains('\n'),
            "{what} has a bare LF:\n{text:?}"
        );
        assert_eq!(
            &format(text, &FormatOptions::default()).unwrap(),
            text,
            "{what}"
        );
    }
}

/// Format Selection on what Extract just inserted changes nothing.
#[test]
fn format_selection_on_the_inserted_tag_changes_nothing() {
    let (start, end) = select(LIST, "<ul>", "</ul>");
    let extraction = extract(LIST, start, end, "people-list", "list.zb", &|_, _| {
        Err("none".to_owned())
    })
    .unwrap();
    let parent = apply(LIST, &extraction.edits);
    let at = parent.find("<people-list").unwrap();
    let edit = format_range(&parent, at, at + 5, &FormatOptions::default()).unwrap();
    assert_eq!(edit, None);
}

/// The nesting limit (workers) and Extract (editors): extracting from markup at the limit gives
/// a refusal or a result, never a crash, and the formatter handles the same depth.
#[test]
fn markup_at_the_nesting_limit_formats_and_extracts() {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(|| {
            let depth = 250;
            let source = format!(
                "<x-deep>\n{}<p>x</p>{}\n</x-deep>\n",
                "<div>".repeat(depth),
                "</div>".repeat(depth)
            );
            assert!(format(&source, &FormatOptions::default()).is_ok());
            let (start, end) = select(&source, "<p>", "</p>");
            let extraction = extract(&source, start, end, "x-leaf", "deep.zb", &|_, _| {
                Err("none".to_owned())
            })
            .unwrap();
            assert!(extraction.file_source.contains("<p>x</p>"));
            // Past the limit, both say so.
            let deeper = source.replace("<p>x</p>", &"<span>".repeat(20));
            assert!(format(&deeper, &FormatOptions::default()).is_err());
        })
        .unwrap()
        .join()
        .unwrap();
}

/// Spread onto a component (spread) inside a selection (editors): the spread's object is the
/// parent's state, so it becomes a prop, and the child still gets its required prop from it.
#[test]
fn a_selection_that_spreads_onto_a_component_extracts() {
    let tag = "<x-tag name count={0}><b>{name}</b> <i>{count}</i></x-tag>";
    let source = "<script>\n  import './tag.zb'\n  let rest = { name: \"a\", count: 2 }\n</script>\n<x-page>\n  <section><x-tag {...rest}></x-tag></section>\n</x-page>\n";
    let loader = |specifier: &str, _from: &str| match specifier {
        "./tag.zb" => Ok(("tag.zb".to_owned(), tag.to_owned())),
        _ => Err(format!("no {specifier}")),
    };
    let (start, end) = select(source, "<section>", "</section>");
    let extraction = extract(source, start, end, "x-part", "page.zb", &loader).unwrap();
    assert_eq!(extraction.props, ["rest"]);
    assert!(extraction.file_source.contains("import './tag.zb'"));
    assert!(extraction.file_source.contains("<x-tag {...rest}></x-tag>"));
}
