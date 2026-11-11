//! `command: "refactor"`: edits that restructure a component, answered as text for the editor to
//! apply. Today one action, `extract`: the selected markup of a template becomes a new component.
//!
//! The selection is whole sibling nodes of the host tag's template. What it refers to decides the
//! new component's interface:
//!
//! - a prop, a `const`, a `let`, a `zb-each` item or anything else the selection reads from
//!   outside becomes a required prop, passed as `name={name}`;
//! - a function of the parent used as an event handler (`onclick={remove}`) becomes an event the
//!   new component fires (`emit("remove")`), which the parent listens to on the new tag;
//! - names the parent imports are imported again by the new component;
//! - an assignment to something the selection doesn't declare (`count++`, `value:bind={count}`),
//!   a `<zb-slot>`, a parent function used any other way, and a shadow DOM parent are refused,
//!   each with its reason.
//!
//! The selection is checked against the file itself, not only parsed on its own: it has to
//! start and end on the edges of whole elements, text and `{…}` expressions (not inside a tag, a
//! comment, an expression or a `<textarea>`), and what would be written is compiled before it is
//! offered. If the component compiled before and wouldn't after, or rendered on the server
//! before and wouldn't after, the extraction is refused with the compiler's reason.
//!
//! No CSS moves: a light-DOM parent's scoped rules reach into a light-DOM child already. That
//! covers rules that match by descendant (`ul li`, `.row b`). A rule that depends on the
//! selection being a *direct* child (`ul > li`, or a flex or grid container laying out its
//! children) sees the new element instead, so the layout can change: the new host is one box.
//! Names bound inside the selection (`zb-each` items, `zb-then` values) are the selection's own
//! only where they are bound: the same name read outside that loop or branch is the parent's.

use std::collections::BTreeSet;

use crate::{
    ast::{self, AttributeValue, Node, Part},
    diagnostic::{Diagnostic, Span},
    expression::Expression,
    parser,
};

/// A change to the file the selection is in: `start..end` (bytes) replaced by `text`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// What `extract` produces.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Extraction {
    /// The new component's tag.
    pub tag: String,
    /// Its file, to create beside the current one.
    pub file_name: String,
    pub file_source: String,
    /// Changes to the current file, in order and not overlapping.
    pub edits: Vec<Edit>,
    /// The props the new component takes (as attributes, kebab-case).
    pub props: Vec<String>,
    /// The events it fires.
    pub events: Vec<String>,
}

/// Names the template can use without the component providing them.
const GLOBALS: &[&str] = &[
    "Array",
    "BigInt",
    "Boolean",
    "Date",
    "Infinity",
    "Intl",
    "JSON",
    "Map",
    "Math",
    "NaN",
    "Number",
    "Object",
    "Promise",
    "Set",
    "String",
    "URL",
    "URLSearchParams",
    "console",
    "document",
    "encodeURIComponent",
    "decodeURIComponent",
    "globalThis",
    "isNaN",
    "navigator",
    "parseFloat",
    "parseInt",
    "undefined",
    "window",
];

/// Extract the markup in `start..end` of `source` into a component called `tag`.
///
/// What it writes is laid out as `zubra fmt` would lay it out (the new file, and the lines of
/// this one that the new tag is on), in the file's own line endings: a repository that checks
/// its formatting must not fail on a refactoring its editor offered.
pub fn extract(
    source: &str,
    start: usize,
    end: usize,
    tag: &str,
    path: &str,
    loader: crate::Loader,
) -> Result<Extraction, Diagnostic> {
    if !crate::format::uses_crlf(source) {
        return extract_lf(source, start, end, tag, path, loader);
    }
    // A CRLF file: worked on with LF, as the formatter does, and given back with its own line
    // endings, so the edited file doesn't end up with both kinds.
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let to_normalized =
        |offset: usize| crate::format::normalized_offset(source, offset.min(source.len()));
    let mut extraction = extract_lf(
        &normalized,
        to_normalized(start),
        to_normalized(end),
        tag,
        path,
        loader,
    )?;
    for edit in &mut extraction.edits {
        edit.start = crate::format::original_offset(source, edit.start);
        edit.end = crate::format::original_offset(source, edit.end);
        edit.text = edit.text.replace('\n', "\r\n");
    }
    extraction.file_source = extraction.file_source.replace('\n', "\r\n");
    Ok(extraction)
}

fn extract_lf(
    source: &str,
    start: usize,
    end: usize,
    tag: &str,
    path: &str,
    loader: crate::Loader,
) -> Result<Extraction, Diagnostic> {
    let refuse = |offset: usize, message: String| Diagnostic::new(span_at(source, offset), message);
    if crate::jsx::looks_like_jsx(source) {
        return Err(refuse(
            0,
            "extracting works on .zb templates, not JSX components".to_owned(),
        ));
    }
    if !valid_tag(tag) {
        return Err(refuse(
            start,
            format!("`{tag}` isn't a custom element name: lowercase words joined by hyphens, such as `price-tag`"),
        ));
    }
    let component = parser::parse(source)?;
    if component.shadow {
        return Err(refuse(
            start,
            "this component uses shadow DOM, where the styles that match the selection would stop at the new component".to_owned(),
        ));
    }
    if tag == component.tag {
        return Err(refuse(
            start,
            format!("`{tag}` is this component's own tag"),
        ));
    }
    let (template_start, template_end) = template_range(source, &component.tag)
        .ok_or_else(|| refuse(start, "couldn't find the component's template".to_owned()))?;

    // The selection without the whitespace around it.
    let (mut from, mut to) = (start.min(source.len()), end.min(source.len()));
    while from < to && source.as_bytes()[from].is_ascii_whitespace() {
        from += 1;
    }
    while to > from && source.as_bytes()[to - 1].is_ascii_whitespace() {
        to -= 1;
    }
    if from >= to || !source.is_char_boundary(from) || !source.is_char_boundary(to) {
        return Err(refuse(start, "select the markup to extract".to_owned()));
    }
    if from < template_start || to > template_end {
        return Err(refuse(
            from,
            "select markup inside the component's template, not its script, style or tag"
                .to_owned(),
        ));
    }
    // The selection against the file's own pieces: it starts where one starts and ends where one
    // ends, closes every tag it opens, and isn't inside an element whose content is text.
    // (Parsing the selected text alone can't tell: `class="a"` out of a tag, the inside of a
    // comment, or a string in an expression can each read as markup on their own.)
    let pieces = crate::format::pieces(source)?;
    let ancestors = whole_pieces(&pieces, template_start, from, to)
        .map_err(|(offset, message)| refuse(offset, message))?;
    let selected = &source[from..to];

    // Whole sibling nodes: the selection is a template of its own.
    let wrapper = format!("<x-selection>\n{selected}\n</x-selection>");
    let parsed = parser::parse(&wrapper).map_err(|error| {
        refuse(
            from,
            format!(
                "the selection isn't whole sibling nodes of the template ({})",
                error.message
            ),
        )
    })?;
    if parsed.nodes.is_empty() {
        return Err(refuse(from, "select the markup to extract".to_owned()));
    }

    // What the selection uses.
    let mut uses = Uses::default();
    uses.nodes(&parsed.nodes);
    if uses.slot {
        return Err(refuse(
            from,
            "the selection contains a <zb-slot>, which belongs to this component's own content"
                .to_owned(),
        ));
    }
    if let Some(slot) = top_slot(&parsed.nodes) {
        return Err(refuse(
            from,
            format!("the selection is placed in its parent's `{slot}` slot (slot=\"{slot}\"); the new component would sit in the default slot instead: select what's inside it"),
        ));
    }
    // The new tag must be free: not one of Zubra's own, and not one this component already uses.
    // (Directives parse as something other than an element; `zb-window` and `zb-document` are
    // elements to the parser and special to the compiler.)
    if ["zb-window", "zb-document"].contains(&tag)
        || !matches!(
            parser::parse(&format!("<x-probe><{tag}></{tag}></x-probe>")),
            Ok(probe) if matches!(probe.nodes.first(), Some(Node::Element(_)))
        )
    {
        return Err(refuse(
            start,
            format!("`{tag}` is one of Zubra's own tags, so it can't name a component"),
        ));
    }
    let mut in_use = BTreeSet::new();
    element_names(&component.nodes, &mut in_use);
    for import in &component.script.imports {
        if import.specifier.ends_with(".zb") {
            if let Some(imported) = loader(&import.specifier, path)
                .ok()
                .and_then(|(_, imported)| parser::parse(&imported).ok())
            {
                in_use.insert(imported.tag);
            }
            if import.specifier.rsplit('/').next() == Some(&format!("{tag}.zb")) {
                in_use.insert(tag.to_owned());
            }
        }
    }
    if in_use.contains(tag) {
        return Err(refuse(
            start,
            format!("this component already uses <{tag}>: choose another name"),
        ));
    }
    // `<ol zb-if={…}>` then `<p zb-else>`: the else would be left without its if.
    let after = source[to..].trim_start();
    if after.starts_with('<') {
        let next = tag_end(after, 0).map_or(after, |end| &after[..end]);
        if mentions(next, "zb-else") || mentions(next, "zb-else-if") {
            return Err(refuse(
                to,
                "the selection ends before the zb-else or zb-else-if that follows it: select the whole chain".to_owned(),
            ));
        }
    }
    // Markup the HTML parser only accepts inside a particular parent (a custom element in
    // between would move it out or drop it).
    const NEEDS_PARENT: &[&str] = &[
        "option",
        "optgroup",
        "tr",
        "td",
        "th",
        "thead",
        "tbody",
        "tfoot",
        "caption",
        "col",
        "colgroup",
        "summary",
        "legend",
        "figcaption",
        "dt",
        "dd",
    ];
    const ONLY_THESE_CHILDREN: &[&str] = &[
        "select", "optgroup", "table", "thead", "tbody", "tfoot", "tr", "colgroup", "datalist",
        "dl", "ul", "ol", "menu", "details", "fieldset", "figure",
    ];
    let mut tops = Vec::new();
    top_elements(&parsed.nodes, &mut tops);
    if tops.iter().any(|name| name == "zb-pending") {
        return Err(refuse(
            from,
            "the selection has a zb-pending without the zb-await it belongs to: it isn't whole sibling nodes".to_owned(),
        ));
    }
    if let Some(name) = tops
        .iter()
        .find(|name| NEEDS_PARENT.contains(&name.as_str()))
    {
        return Err(refuse(
            from,
            format!("<{name}> only works directly inside its parent element (a new component would sit between them): select the parent too"),
        ));
    }
    // The nearest element around the selection (looking through `zb-` directives).
    if let Some(parent) = ancestors
        .iter()
        .rev()
        .find(|name| !name.starts_with("zb-"))
        .map(|name| name.to_ascii_lowercase())
    {
        if ONLY_THESE_CHILDREN.contains(&parent.as_str())
            && !["ul", "ol", "menu", "dl", "details", "fieldset", "figure"]
                .contains(&parent.as_str())
        {
            return Err(refuse(
                from,
                format!("<{parent}> accepts only particular children, and a new component between them would be dropped or moved: select the whole <{parent}>"),
            ));
        }
    }
    if uses.orphan {
        return Err(refuse(
            from,
            "the selection has a zb-else, zb-then or zb-catch without the zb-if or zb-await it belongs to: it isn't whole sibling nodes".to_owned(),
        ));
    }
    let script = &component.script;
    let mut props = BTreeSet::new();
    let mut events = BTreeSet::new();
    let mut imports: Vec<&str> = Vec::new();
    // An import that brings `name` into scope: by the names it binds, not any word in it
    // (`import { size as width } from './from.js'` binds `width`, not `size` or `from`).
    let imported = |name: &str| {
        script.imports.iter().find(|import| {
            import_locals(&import.text)
                .iter()
                .any(|local| local == name)
        })
    };
    for (name, written) in &uses.names {
        // What the browser provides is the new component's too (the validator's list, so
        // `setTimeout`, `fetch` and `localStorage` don't become props).
        if GLOBALS.contains(&name.as_str())
            || crate::validate::RUNTIME_GLOBALS.contains(&name.as_str())
        {
            continue;
        }
        if script.emit.as_deref() == Some(name.as_str()) {
            return Err(refuse(
                from,
                format!("the selection fires this component's events (`{name}(…)`); the new component would fire its own"),
            ));
        }
        if let Some(import) = imported(name) {
            if *written {
                return Err(refuse(
                    from,
                    format!("the selection assigns to `{name}`, which this component imports"),
                ));
            }
            if !imports.contains(&import.text.as_str()) {
                imports.push(&import.text);
            }
            continue;
        }
        if *written {
            return Err(refuse(
                from,
                format!("the selection assigns to `{name}`, which belongs to this component; a new component would only change its own copy"),
            ));
        }
        if script
            .server_exports
            .iter()
            .any(|export| &export.name == name)
        {
            return Err(refuse(
                from,
                format!("the selection uses `{name}`, a server function of this component, which the new component couldn't call"),
            ));
        }
        if script.runtime_names.contains(name) {
            if uses.handlers.contains(name) && !uses.other_uses.contains(name) {
                // The parent's function would listen for the new component's event, and be
                // called with that event, not the click or submit it was written for.
                if function_parameters(&source[..template_start], name) != Some(false) {
                    return Err(refuse(
                        from,
                        format!("the selection uses `{name}` as an event handler, and `{name}` takes the event as its argument; as a listener on the new component it would be given that component's event instead (`preventDefault()` and `target` would no longer be the element's)"),
                    ));
                }
                events.insert(name.clone());
            } else {
                return Err(refuse(
                    from,
                    format!("the selection uses `{name}`, a function of this component, other than as a whole event handler (`onclick={{{name}}}`)"),
                ));
            }
            continue;
        }
        // A `state()` the selection sets: a prop is a copy of its value, not the state.
        if script.bindings.iter().any(|binding| {
            binding.name == *name
                && binding
                    .source
                    .as_deref()
                    .is_some_and(|init| init.contains('('))
        }) && (mentions(selected, &format!("{name}.set"))
            || mentions(selected, &format!("{name}.update")))
        {
            return Err(refuse(
                from,
                format!("the selection changes `{name}` (`{name}.set(…)`), state of this component; a prop would only be a copy of it"),
            ));
        }
        // A function held in a `const` (`const nudge = (by) => …`) would have to be passed as a
        // prop, and a function is a value only the browser has.
        if script.bindings.iter().any(|binding| {
            binding.name == *name
                && binding.init.is_none()
                && binding.source.as_deref().is_some_and(|init| {
                    let init = init.trim_start();
                    init.contains("=>") || init.starts_with("function") || init.starts_with("async")
                })
        }) {
            return Err(refuse(
                from,
                format!("the selection uses `{name}`, a function of this component; passed to the new component as a prop it couldn't be rendered on the server: keep the markup with its function"),
            ));
        }
        let camel = name.starts_with(|character: char| character.is_ascii_lowercase())
            && name
                .chars()
                .all(|character| character.is_ascii_alphanumeric());
        if !camel {
            return Err(refuse(
                from,
                format!("the selection reads `{name}`, which can't be a prop: a prop's name is camelCase, starting lowercase"),
            ));
        }
        props.insert(name.clone());
    }
    // Components the selection uses: the imports of `.zb` files whose tag it contains. The tag
    // comes from the file; if that can't be read, from the file's name (`badge.zb` ← `<zb-badge>`).
    for import in &script.imports {
        if !import.specifier.ends_with(".zb") || imports.contains(&import.text.as_str()) {
            continue;
        }
        let stem = import
            .specifier
            .rsplit('/')
            .next()
            .and_then(|file| file.strip_suffix(".zb"))
            .unwrap_or_default();
        let loaded = loader(&import.specifier, path)
            .ok()
            .and_then(|(_, imported)| parser::parse(&imported).ok())
            .map(|imported| imported.tag);
        let used = match loaded {
            Some(imported) => uses.elements.contains(&imported),
            None => uses
                .elements
                .iter()
                .any(|element| element == stem || element.ends_with(&format!("-{stem}"))),
        };
        if used {
            imports.push(&import.text);
        }
    }

    // The new component.
    let kebab = |name: &str| {
        let mut out = String::new();
        for character in name.chars() {
            if character.is_ascii_uppercase() {
                out.push('-');
                out.push(character.to_ascii_lowercase());
            } else {
                out.push(character);
            }
        }
        out
    };
    let event_name = |name: &str| name.to_ascii_lowercase();
    let mut body = selected.to_owned();
    for name in &events {
        body = replace_handler(
            &body,
            name,
            &format!("() => emit(\"{}\")", event_name(name)),
        );
    }
    // `<pre>` and `<textarea>` show their whitespace: such a selection is moved as written.
    let verbatim = uses.elements.contains("pre") || uses.elements.contains("textarea");
    let body = if verbatim { body } else { dedent(&body) };
    let attributes: Vec<String> = props.iter().map(|name| kebab(name)).collect();
    let mut file = format!("<!-- Extracted from <{}>. -->\n", component.tag);
    if !imports.is_empty() || !events.is_empty() {
        file.push_str("<script>\n");
        for import in &imports {
            file.push_str(&format!("  {import}\n"));
        }
        if !events.is_empty() {
            file.push_str("  import { emit } from '@zubra/runtime'\n");
        }
        file.push_str("</script>\n");
    }
    file.push_str(&format!("<{tag}"));
    for attribute in &attributes {
        file.push(' ');
        file.push_str(attribute);
    }
    file.push('>');
    // On lines of its own in the parent, the selection is indented inside the new tag; inside a
    // line of text it stays as it was, so the page doesn't gain whitespace.
    let own_lines = !verbatim
        && source[..from]
            .rsplit('\n')
            .next()
            .is_some_and(|before| before.trim().is_empty())
        && source[to..]
            .split('\n')
            .next()
            .is_some_and(|after| after.trim().is_empty());
    if own_lines {
        file.push('\n');
        for line in body.lines() {
            if line.is_empty() {
                file.push('\n');
            } else {
                file.push_str("  ");
                file.push_str(line);
                file.push('\n');
            }
        }
    } else {
        file.push_str(&body);
    }
    file.push_str(&format!("</{tag}>\n"));

    // The edits to this file: the selection becomes the new tag, and the import is added.
    let mut host = format!("<{tag}");
    for (name, attribute) in props.iter().zip(&attributes) {
        host.push_str(&format!(" {attribute}={{{name}}}"));
    }
    for name in &events {
        host.push_str(&format!(" on{}={{{name}}}", event_name(name)));
    }
    host.push_str(&format!("></{tag}>"));
    let import_line = format!("import './{tag}.zb'");
    let mut edits = Vec::new();
    match script_open_end(source, template_start) {
        Some(at) => edits.push(Edit {
            start: at,
            end: at,
            text: format!("\n  {import_line}"),
        }),
        None => {
            let at = host_start(source, &component.tag).unwrap_or(0);
            edits.push(Edit {
                start: at,
                end: at,
                text: format!("<script>\n  {import_line}\n</script>\n"),
            });
        }
    }
    let host_length = host.len();
    edits.push(Edit {
        start: from,
        end: to,
        text: host,
    });
    edits.sort_by_key(|edit| edit.start);

    // Laid out as `zubra fmt` would: the new file whole, and in this file the lines the new tag
    // is on (a tag with many props goes one attribute per line, as the formatter would put it).
    let options = crate::FormatOptions::default();
    if let Ok(formatted) = crate::format::format(&file, &options) {
        file = formatted;
    }
    {
        let mut after = source.to_owned();
        for edit in edits.iter().rev() {
            after.replace_range(edit.start..edit.end, &edit.text);
        }
        // Where the new tag is in the edited text: past what the import edit added before it.
        let (shift, added_until) = edits
            .iter()
            .filter(|edit| edit.start < from)
            .fold((0, 0), |(shift, _), edit| {
                (shift + edit.text.len(), edit.start + edit.text.len())
            });
        let (tag_from, tag_to) = (from + shift, from + shift + host_length);
        if let Ok(Some(range)) = crate::format::format_range(&after, tag_from, tag_to, &options) {
            let (first, last) = (range.start.min(tag_from), range.end.max(tag_to));
            if first >= added_until {
                let text = format!(
                    "{}{}{}",
                    &after[first..range.start],
                    range.text,
                    &after[range.end..last]
                );
                if let Some(edit) = edits.iter_mut().find(|edit| edit.start == from) {
                    edit.start = first - shift;
                    edit.end = last - shift - host_length + (to - from);
                    edit.text = text;
                }
            }
        }
    }

    // What would be written is compiled before it's offered: a refactoring must not turn a
    // component that works into one that doesn't. (A file that didn't compile to begin with
    // can't be judged this way, and is left to the checks above.)
    let mut after = source.to_owned();
    for edit in edits.iter().rev() {
        after.replace_range(edit.start..edit.end, &edit.text);
    }
    let child_path = match path.replace('\\', "/").rsplit_once('/') {
        Some((directory, _)) => format!("{directory}/{tag}.zb"),
        None => format!("{tag}.zb"),
    };
    let with_child = |specifier: &str, importer: &str| -> Result<(String, String), String> {
        if specifier == format!("./{tag}.zb") && importer != child_path {
            return Ok((child_path.clone(), file.clone()));
        }
        loader(specifier, importer)
    };
    if crate::compile_js_with(source, path, "@zubra/runtime", None, loader).is_ok() {
        if let Err(error) =
            crate::compile_js_with(&after, path, "@zubra/runtime", None, &with_child)
        {
            return Err(refuse(
                from,
                format!(
                    "extracting this would leave a component that doesn't compile ({})",
                    error.message
                ),
            ));
        }
        // And the server: a prop only the browser can compute (a function, `Date.now()`) can't
        // be passed to the new component while the page is rendered.
        for partial in [false, true] {
            let render = |text: &str, loader: crate::Loader| {
                crate::compile_html_with_options(
                    text,
                    path,
                    "{}",
                    "{}",
                    crate::HtmlOptions {
                        slot_source: crate::SlotSource::Template,
                        partial,
                        pending: Vec::new(),
                    },
                    loader,
                )
            };
            if render(source, loader).is_ok() {
                if let Err(error) = render(&after, &with_child) {
                    return Err(refuse(
                        from,
                        format!(
                            "this component renders on the server now, and wouldn't with the selection extracted ({})",
                            error.message
                        ),
                    ));
                }
            }
        }
    }

    Ok(Extraction {
        tag: tag.to_owned(),
        file_name: format!("{tag}.zb"),
        file_source: file,
        edits,
        props: attributes,
        events: events.iter().map(|name| event_name(name)).collect(),
    })
}

// ---- what a selection uses ------------------------------------------------------------------

#[derive(Default)]
struct Uses {
    /// Free identifiers, and whether any use of one assigns to it.
    names: std::collections::BTreeMap<String, bool>,
    /// Identifiers that are a whole event handler somewhere, and ones used another way.
    handlers: BTreeSet<String>,
    other_uses: BTreeSet<String>,
    /// The names bound around what is being looked at (`zb-each` items, `zb-then` values), one
    /// set per loop or branch: a name is the parent's unless one of these binds it there.
    scopes: Vec<BTreeSet<String>>,
    /// Tags of elements in it.
    elements: BTreeSet<String>,
    slot: bool,
    /// A `zb-else` or `zb-then` whose `zb-if` or `zb-await` isn't in the selection.
    orphan: bool,
}

impl Uses {
    fn is_bound(&self, name: &str) -> bool {
        self.scopes.iter().any(|scope| scope.contains(name))
    }

    fn bind(&mut self, name: &str) {
        if let Some(scope) = self.scopes.last_mut() {
            scope.insert(name.to_owned());
        }
    }

    fn expression(&mut self, attribute: Option<&str>, expression: &Expression) {
        let handler = attribute
            .filter(|name| parser::is_event_attribute(&name.to_ascii_lowercase()))
            .and(match expression {
                Expression::Identifier(name) if !self.is_bound(name) => Some(name.clone()),
                _ => None,
            });
        if let Some(name) = &handler {
            self.handlers.insert(name.clone());
        }
        let mut free = Vec::new();
        expression.for_each_identifier(&mut |name| free.push(name.to_owned()));
        for name in free {
            if self.is_bound(&name) {
                continue;
            }
            if handler.as_deref() != Some(name.as_str()) {
                self.other_uses.insert(name.clone());
            }
            self.names.entry(name).or_insert(false);
        }
        for name in expression.written_names() {
            if !self.is_bound(name) {
                self.names.insert(name.to_owned(), true);
            }
        }
        // `value:bind={count}` and `:model` write what they name.
        if attribute.is_some_and(|name| name.ends_with(":bind") || name.ends_with(":model")) {
            if let Expression::Identifier(name) = expression {
                if !self.is_bound(name) {
                    self.names.insert(name.clone(), true);
                }
            }
        }
    }

    fn parts(&mut self, attribute: Option<&str>, parts: &[Part]) {
        for part in parts {
            if let Part::Expression { expression, .. } = part {
                self.expression(attribute, expression);
            }
        }
    }

    /// Bind what a pattern names (`item`, `{ id, name }`, `[first, ...rest]`) in the current scope.
    fn pattern(&mut self, pattern: &str) {
        match ast::bindings(pattern) {
            Ok(bindings) => {
                for (name, _) in bindings {
                    self.bind(&name);
                }
            }
            Err(_) => self.bind(pattern.trim()),
        }
    }

    /// A `zb-then`/`zb-catch` branch: its value and `let:`s are bound for its children only.
    fn branch(&mut self, branch: &ast::Branch) {
        self.scopes.push(BTreeSet::new());
        if let Some(name) = &branch.name {
            self.pattern(name);
        }
        for binding in &branch.lets {
            self.expression(None, &binding.value);
            self.bind(&binding.name);
        }
        self.nodes(&branch.children);
        self.scopes.pop();
    }

    fn nodes(&mut self, nodes: &[Node]) {
        for node in nodes {
            match node {
                Node::Text(parts) => self.parts(None, parts),
                Node::Element(element) => {
                    self.elements.insert(element.name.clone());
                    for attribute in &element.attributes {
                        match &attribute.value {
                            AttributeValue::None => {}
                            AttributeValue::Text(parts) => self.parts(Some(&attribute.name), parts),
                            AttributeValue::Expression(expression, _) => {
                                self.expression(Some(&attribute.name), expression)
                            }
                        }
                    }
                    self.nodes(&element.children);
                }
                Node::If {
                    test,
                    consequent,
                    alternate,
                    ..
                } => {
                    self.expression(None, test);
                    self.nodes(consequent);
                    self.nodes(alternate);
                }
                Node::Each {
                    items,
                    item,
                    index,
                    key,
                    lets,
                    children,
                    ..
                } => {
                    // The list is read outside the loop; the item, index and `let:`s are bound
                    // inside it only.
                    self.expression(None, items);
                    self.scopes.push(BTreeSet::new());
                    self.pattern(item);
                    if let Some(index) = index {
                        self.bind(index);
                    }
                    if let Some((key, _)) = key {
                        self.expression(None, key);
                    }
                    for binding in lets {
                        self.expression(None, &binding.value);
                        self.bind(&binding.name);
                    }
                    self.nodes(children);
                    self.scopes.pop();
                }
                Node::Slot { .. } => self.slot = true,
                Node::Else { test, children, .. } => {
                    self.orphan = true;
                    if let Some((test, _)) = test {
                        self.expression(None, test);
                    }
                    self.nodes(children);
                }
                Node::Await {
                    value,
                    pending,
                    then,
                    catch,
                    delay,
                    ..
                } => {
                    self.expression(None, value);
                    if let Some((delay, _)) = delay {
                        self.expression(None, delay);
                    }
                    self.nodes(pending);
                    for branch in then.iter().chain(catch) {
                        self.branch(branch);
                    }
                }
                Node::Settled { branch, .. } => {
                    self.orphan = true;
                    self.branch(branch);
                }
            }
        }
    }
}

// ---- the selection against the file --------------------------------------------------------

/// Elements whose content is text: markup written inside them is shown, not parsed.
const TEXT_CONTENT: &[&str] = &["textarea", "title", "script", "style"];

/// Check that `from..to` is whole pieces of the file that close every tag they open, and give
/// the elements around it (outermost first). The error is where it goes wrong, and why.
fn whole_pieces(
    pieces: &[crate::format::Piece],
    template_start: usize,
    from: usize,
    to: usize,
) -> Result<Vec<String>, (usize, String)> {
    use crate::format::PieceKind;
    for (offset, verb) in [(from, "starts"), (to, "ends")] {
        let Some(piece) = pieces
            .iter()
            .find(|piece| piece.start < offset && offset < piece.end)
        else {
            continue;
        };
        let inside = match piece.kind {
            PieceKind::Open { .. } => format!("inside the <{}> tag itself", piece.name),
            PieceKind::Close => format!("inside the </{}> tag", piece.name),
            PieceKind::Comment => "inside a comment".to_owned(),
            PieceKind::Braces => "inside a {…} expression".to_owned(),
            PieceKind::Body => "inside a script or style".to_owned(),
            PieceKind::Text | PieceKind::Space => "in the middle of a word".to_owned(),
        };
        return Err((
            offset,
            format!(
                "the selection {verb} {inside}: select whole elements, text and {{…}} expressions"
            ),
        ));
    }
    // The elements open around the selection.
    let mut around: Vec<String> = Vec::new();
    for piece in pieces
        .iter()
        .filter(|piece| piece.start >= template_start && piece.end <= from)
    {
        match piece.kind {
            PieceKind::Open { childless: false } => around.push(piece.name.clone()),
            PieceKind::Close => {
                if let Some(open) = around
                    .iter()
                    .rposition(|name| name.eq_ignore_ascii_case(&piece.name))
                {
                    around.truncate(open);
                }
            }
            _ => {}
        }
    }
    if let Some(parent) = around
        .iter()
        .find(|name| TEXT_CONTENT.contains(&name.to_ascii_lowercase().as_str()))
    {
        return Err((
            from,
            format!("the selection is inside <{parent}>, whose content is text, not markup"),
        ));
    }
    // Every tag the selection opens, it closes, and it closes no other.
    let mut open: Vec<&crate::format::Piece> = Vec::new();
    for piece in pieces
        .iter()
        .filter(|piece| piece.start >= from && piece.end <= to)
    {
        match piece.kind {
            PieceKind::Open { childless: false } => open.push(piece),
            PieceKind::Close if open.pop().is_none() => {
                return Err((
                    piece.start,
                    format!(
                        "the selection ends a <{}> it doesn't start: select whole elements",
                        piece.name
                    ),
                ));
            }
            _ => {}
        }
    }
    if let Some(piece) = open.first() {
        return Err((
            piece.start,
            format!(
                "the selection starts a <{}> it doesn't end: select whole elements",
                piece.name
            ),
        ));
    }
    Ok(around)
}

/// The `slot="…"` of an element at the top of the selection (through directives), if one has it.
fn top_slot(nodes: &[Node]) -> Option<String> {
    for node in nodes {
        let found = match node {
            Node::Element(element) => element
                .attributes
                .iter()
                .find(|attribute| attribute.name.eq_ignore_ascii_case("slot"))
                .map(|attribute| match &attribute.value {
                    AttributeValue::Text(parts) => parts
                        .iter()
                        .map(|part| match part {
                            Part::Literal(text) => text.as_str(),
                            Part::Expression { .. } => "…",
                        })
                        .collect::<String>(),
                    _ => "…".to_owned(),
                }),
            Node::If {
                consequent,
                alternate,
                ..
            } => top_slot(consequent).or_else(|| top_slot(alternate)),
            Node::Each { children, .. } | Node::Else { children, .. } => top_slot(children),
            Node::Await {
                pending,
                then,
                catch,
                ..
            } => top_slot(pending).or_else(|| {
                then.iter()
                    .chain(catch)
                    .find_map(|branch| top_slot(&branch.children))
            }),
            Node::Settled { branch, .. } => top_slot(&branch.children),
            Node::Slot { .. } | Node::Text(_) => None,
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// Every element name in a template.
fn element_names(nodes: &[Node], out: &mut BTreeSet<String>) {
    for node in nodes {
        match node {
            Node::Element(element) => {
                out.insert(element.name.clone());
                element_names(&element.children, out);
            }
            Node::If {
                consequent,
                alternate,
                ..
            } => {
                element_names(consequent, out);
                element_names(alternate, out);
            }
            Node::Each { children, .. } | Node::Else { children, .. } => {
                element_names(children, out)
            }
            Node::Await {
                pending,
                then,
                catch,
                ..
            } => {
                element_names(pending, out);
                for branch in then.iter().chain(catch) {
                    element_names(&branch.children, out);
                }
            }
            Node::Settled { branch, .. } => element_names(&branch.children, out),
            Node::Slot { fallback, .. } => element_names(fallback, out),
            Node::Text(_) => {}
        }
    }
}

/// The names an `import` statement binds: `a` and `c` for `import a, { b as c } from 'x'`, `ns`
/// for `import * as ns from 'x'`, none for `import './side.zb'`.
fn import_locals(text: &str) -> Vec<String> {
    let Some(clause) = text.trim().strip_prefix("import") else {
        return Vec::new();
    };
    // Up to the `from` before the specifier's quote.
    let Some(quote) = clause.find(['\'', '"']) else {
        return Vec::new();
    };
    let Some(clause) = clause[..quote].trim_end().strip_suffix("from") else {
        return Vec::new(); // a bare `import './x.zb'`
    };
    let clause = clause.trim();
    let clause = clause.strip_prefix("type ").unwrap_or(clause);
    let word = |text: &str| -> Option<String> {
        let text = text.trim();
        let text = text.strip_prefix("type ").unwrap_or(text).trim();
        // `b as c`, `* as ns` (given here as `as ns`) and `a` all end in the local name.
        let local = text.split_whitespace().next_back().unwrap_or(text);
        (!local.is_empty()
            && local.chars().all(|character| {
                character.is_alphanumeric() || character == '_' || character == '$'
            }))
        .then(|| local.to_owned())
    };
    let mut locals = Vec::new();
    let (outside, inside) = match (clause.find('{'), clause.rfind('}')) {
        (Some(open), Some(close)) if open < close => (
            format!("{}{}", &clause[..open], &clause[close + 1..]),
            &clause[open + 1..close],
        ),
        _ => (clause.to_owned(), ""),
    };
    for part in outside.split(',') {
        let part = part.trim();
        if let Some(namespace) = part.strip_prefix('*') {
            locals.extend(word(namespace));
        } else {
            locals.extend(word(part));
        }
    }
    locals.extend(inside.split(',').filter_map(word));
    locals
}

/// Whether the function `name`, declared in `script`, takes parameters: `None` when its
/// declaration (`function name(…)`) isn't found.
fn function_parameters(script: &str, name: &str) -> Option<bool> {
    let word =
        |character: char| character.is_alphanumeric() || character == '_' || character == '$';
    for (at, _) in script.match_indices("function") {
        if script[..at].chars().next_back().is_some_and(word) {
            continue;
        }
        let rest = script[at + "function".len()..].trim_start();
        let rest = rest.strip_prefix('*').unwrap_or(rest).trim_start();
        let Some(rest) = rest.strip_prefix(name) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('(') else {
            continue;
        };
        let close = rest.find(')')?;
        return Some(!rest[..close].trim().is_empty());
    }
    None
}

// ---- text helpers ---------------------------------------------------------------------------

fn valid_tag(tag: &str) -> bool {
    tag.contains('-')
        && tag.starts_with(|character: char| character.is_ascii_lowercase())
        && !tag.ends_with('-')
        && !tag.contains("--")
        && tag.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

/// Whether `text` has `name` as a whole word.
fn mentions(text: &str, name: &str) -> bool {
    let word =
        |character: char| character.is_alphanumeric() || character == '_' || character == '$';
    text.match_indices(name).any(|(at, _)| {
        !text[..at].chars().next_back().is_some_and(word)
            && !text[at + name.len()..].chars().next().is_some_and(word)
    })
}

fn span_at(source: &str, offset: usize) -> Span {
    // An offset inside a character (a client counting in other units) is that character's start.
    let mut offset = offset.min(source.len());
    while !source.is_char_boundary(offset) {
        offset -= 1;
    }
    let before = &source[..offset];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(0, |last| last.chars().count())
        + 1;
    Span::new(line, column)
}

/// `on<event>(.modifier)*={name}` → `on<event>…={replacement}`.
fn replace_handler(body: &str, name: &str, replacement: &str) -> String {
    let needle = format!("={{{name}}}");
    let mut out = String::with_capacity(body.len());
    let mut rest = 0;
    for (at, _) in body.match_indices(&needle) {
        let attribute: String = body[..at]
            .chars()
            .rev()
            .take_while(|character| !character.is_whitespace() && *character != '<')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if parser::is_event_attribute(&attribute.to_ascii_lowercase()) {
            out.push_str(&body[rest..at]);
            out.push_str(&format!("={{{replacement}}}"));
            rest = at + needle.len();
        }
    }
    out.push_str(&body[rest..]);
    out
}

/// Remove the indentation the lines after the first share.
fn dedent(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let indent = lines
        .iter()
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                (*line).to_owned()
            } else if line.trim().is_empty() {
                String::new()
            } else {
                line.get(indent..).unwrap_or(line.trim_start()).to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Where the host tag starts, skipping the comment, script and style before it.
fn host_start(source: &str, tag: &str) -> Option<usize> {
    let mut at = 0;
    while at < source.len() {
        let rest = &source[at..];
        let skip = if rest.starts_with("<!--") {
            rest.find("-->").map(|end| end + 3)
        } else if rest.starts_with("<script") {
            rest.find("</script>").map(|end| end + 9)
        } else if rest.starts_with("<style") {
            rest.find("</style>").map(|end| end + 8)
        } else if rest.starts_with(&format!("<{tag}"))
            && rest[tag.len() + 1..].starts_with(|character: char| {
                character.is_whitespace() || character == '>' || character == '/'
            })
        {
            return Some(at);
        } else {
            rest.chars().next().map(char::len_utf8)
        };
        at += skip?;
    }
    None
}

/// The end of a start tag that begins at `from`: after its `>`, past quoted and braced values.
fn tag_end(source: &str, from: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let (mut depth, mut quote) = (0usize, None);
    let mut at = from;
    while at < bytes.len() {
        let byte = bytes[at];
        match quote {
            Some(open) => {
                if byte == open {
                    quote = None;
                }
            }
            None => match byte {
                b'"' | b'\'' | b'`' => quote = Some(byte),
                b'{' => depth += 1,
                b'}' => depth = depth.saturating_sub(1),
                b'>' if depth == 0 => return Some(at + 1),
                _ => {}
            },
        }
        at += 1;
    }
    None
}

/// The template: from after the host's start tag to the start of its end tag.
fn template_range(source: &str, tag: &str) -> Option<(usize, usize)> {
    let start = host_start(source, tag)?;
    let open_end = tag_end(source, start)?;
    let close = source.rfind(&format!("</{tag}"))?;
    (open_end <= close).then_some((open_end, close))
}

/// Just after the `>` of a top-level `<script …>`, if there is one before the template.
fn script_open_end(source: &str, before: usize) -> Option<usize> {
    let mut at = 0;
    while at < before {
        let rest = &source[at..before];
        if rest.starts_with("<!--") {
            at += rest.find("-->")? + 3;
        } else if rest.starts_with("<script") {
            return tag_end(source, at);
        } else if rest.starts_with("<style") {
            at += rest.find("</style>")? + 8;
        } else {
            at += rest.chars().next()?.len_utf8();
        }
    }
    None
}

/// The elements at the top of a selection, looking through directives (`<zb-each><tr>…`).
fn top_elements(nodes: &[Node], out: &mut Vec<String>) {
    for node in nodes {
        match node {
            Node::Element(element) => out.push(element.name.clone()),
            Node::If {
                consequent,
                alternate,
                ..
            } => {
                top_elements(consequent, out);
                top_elements(alternate, out);
            }
            Node::Each { children, .. } | Node::Else { children, .. } => {
                top_elements(children, out)
            }
            Node::Await {
                pending,
                then,
                catch,
                ..
            } => {
                top_elements(pending, out);
                for branch in then.iter().chain(catch) {
                    top_elements(&branch.children, out);
                }
            }
            Node::Settled { branch, .. } => top_elements(&branch.children, out),
            Node::Slot { .. } | Node::Text(_) => {}
        }
    }
}
