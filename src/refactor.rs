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
//! No CSS moves: a light-DOM parent's scoped rules reach into a light-DOM child already.
//! Names bound inside the selection (`zb-each` items, `zb-then` values) are told apart from the
//! parent's by name, not by scope: a name used both inside and outside a binding of it in the
//! selection counts as the selection's own.

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
pub fn extract(
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
    if let Some(parent) = enclosing_tag(source, template_start, from) {
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
    let imported = |name: &str| {
        script
            .imports
            .iter()
            .find(|import| mentions(&import.text, name))
    };
    for (name, written) in &uses.names {
        if uses.bound.contains(name) || GLOBALS.contains(&name.as_str()) {
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
    let body = dedent(&body);
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
    let own_lines = source[..from]
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
    edits.push(Edit {
        start: from,
        end: to,
        text: host,
    });
    edits.sort_by_key(|edit| edit.start);

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
    /// Names the selection binds itself.
    bound: BTreeSet<String>,
    /// Tags of elements in it.
    elements: BTreeSet<String>,
    slot: bool,
    /// A `zb-else` or `zb-then` whose `zb-if` or `zb-await` isn't in the selection.
    orphan: bool,
}

impl Uses {
    fn expression(&mut self, attribute: Option<&str>, expression: &Expression) {
        let handler = attribute
            .filter(|name| parser::is_event_attribute(&name.to_ascii_lowercase()))
            .and(match expression {
                Expression::Identifier(name) => Some(name.clone()),
                _ => None,
            });
        if let Some(name) = &handler {
            self.handlers.insert(name.clone());
        }
        expression.for_each_identifier(&mut |name| {
            self.names.entry(name.to_owned()).or_insert(false);
            if handler.as_deref() != Some(name) {
                self.other_uses.insert(name.to_owned());
            }
        });
        for name in expression.written_names() {
            self.names.insert(name.to_owned(), true);
        }
        // `value:bind={count}` and `:model` write what they name.
        if attribute.is_some_and(|name| name.ends_with(":bind") || name.ends_with(":model")) {
            if let Expression::Identifier(name) = expression {
                self.names.insert(name.clone(), true);
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

    fn pattern(&mut self, pattern: &str) {
        match ast::bindings(pattern) {
            Ok(bindings) => self
                .bound
                .extend(bindings.into_iter().map(|(name, _)| name)),
            Err(_) => {
                self.bound.insert(pattern.trim().to_owned());
            }
        }
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
                    self.expression(None, items);
                    self.pattern(item);
                    if let Some(index) = index {
                        self.bound.insert(index.clone());
                    }
                    if let Some((key, _)) = key {
                        self.expression(None, key);
                    }
                    for binding in lets {
                        self.bound.insert(binding.name.clone());
                        self.expression(None, &binding.value);
                    }
                    self.nodes(children);
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
                        if let Some(name) = &branch.name {
                            self.pattern(name);
                        }
                        for binding in &branch.lets {
                            self.bound.insert(binding.name.clone());
                            self.expression(None, &binding.value);
                        }
                        self.nodes(&branch.children);
                    }
                }
                Node::Settled { branch, .. } => {
                    self.orphan = true;
                    if let Some(name) = &branch.name {
                        self.pattern(name);
                    }
                    self.nodes(&branch.children);
                }
            }
        }
    }
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
    let offset = offset.min(source.len());
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

/// The nearest element (not a `zb-` directive) around `at`, by balancing tags from `from`.
fn enclosing_tag(source: &str, from: usize, at: usize) -> Option<String> {
    const VOID: &[&str] = &[
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
        "track", "wbr",
    ];
    let bytes = source.as_bytes();
    let mut stack: Vec<String> = Vec::new();
    let mut index = from;
    while index < at {
        if source[index..].starts_with("<!--") {
            index += source[index..]
                .find("-->")
                .map_or(at - index, |end| end + 3);
        } else if bytes[index] == b'<' {
            let closing = bytes.get(index + 1) == Some(&b'/');
            let name: String = source[index + 1 + usize::from(closing)..]
                .chars()
                .take_while(|character| character.is_ascii_alphanumeric() || *character == '-')
                .collect();
            if name.is_empty() {
                index += 1;
                continue;
            }
            let end = tag_end(source, index).unwrap_or(at);
            if closing {
                if let Some(open) = stack.iter().rposition(|open| *open == name) {
                    stack.truncate(open);
                }
            } else if !(bytes.get(end.wrapping_sub(2)) == Some(&b'/')
                || VOID.contains(&name.as_str()))
            {
                stack.push(name);
            }
            index = end.max(index + 1);
        } else {
            index += source[index..].chars().next().map_or(1, char::len_utf8);
        }
    }
    stack
        .into_iter()
        .rev()
        .find(|name| !name.starts_with("zb-"))
}
