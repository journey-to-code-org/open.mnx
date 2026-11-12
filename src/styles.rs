//! A component's `<style>`, scoped to it.
//!
//! - **Light DOM**: the CSS goes inside `@scope (tag) to ([data-zb-slotted="tag"])`, the
//!   platform's own scoping. Selectors match the component's elements and stop at content
//!   callers put in its slots (the runtime and the HTML output mark each slotted element with
//!   `data-zb-slotted="<the tag it's slotted into>"`, so a parent's content placed in a child's
//!   slot is still the parent's to style). `:host` means the host, as in shadow DOM, so one
//!   stylesheet works either way.
//! - **Shadow DOM**: the shadow root scopes it; the CSS is used as written.
//!
//! Both go in a cascade layer, `components` by default, so utility classes (Tailwind's
//! `utilities` layer) and unlayered app CSS override a component's own defaults. The sheet first
//! declares Tailwind's layer order (`theme, base, components, utilities`), so whichever loads
//! first, base styles come before components and utilities after. `layer="…"` picks another
//! layer; `layer="none"` leaves the CSS unlayered. Leading `@import`, `@use`, `@reference` (and
//! similar) statements stay at the top, where CSS and preprocessors require them.

use crate::ast::{ComponentAst, Style};

/// The attribute that marks content slotted into a component (its value is the component's tag).
pub const SLOTTED: &str = "data-zb-slotted";

/// The component's stylesheet, or `None` without a `<style>`.
pub fn stylesheet(component: &ComponentAst) -> Option<String> {
    if component.host_reset {
        // The page can match the host (`* { … !important }`) and its inherited properties flow
        // in: start the host from nothing, and make the component's own `:host` rules
        // `!important`, which wins across the shadow boundary.
        let own = component.style.as_ref().map_or(String::new(), |style| {
            wrap(
                &Style {
                    css: important_host_rules(&style.css),
                    ..style.clone()
                },
                &component.tag,
                true,
            )
        });
        return Some(format!("{HOST_RESET}\n{own}"));
    }
    let style = component.style.as_ref()?;
    Some(wrap(style, &component.tag, component.shadow))
}

const HOST_RESET: &str = ":host { all: initial !important; }";

/// Top-level rules whose selector starts with `:host`: every declaration made `!important`.
fn important_host_rules(css: &str) -> String {
    let mut out = String::with_capacity(css.len() + 64);
    let mut rest = css;
    while let Some(open) = rest.find('{') {
        let selector = &rest[..open];
        // The selector is what follows the previous rule's `}` (or `;` of an at-rule).
        let selector_start = selector.rfind([';', '}']).map_or(0, |at| at + 1);
        let is_host = selector[selector_start..].trim_start().starts_with(":host")
            && !selector[selector_start..].contains('@');
        // The block, with nested braces.
        let mut depth = 0;
        let mut end = None;
        for (index, character) in rest[open..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else { break };
        out.push_str(&rest[..=open]);
        let body = &rest[open + 1..end];
        if is_host && !body.contains('{') {
            let declarations: Vec<String> = body
                .split(';')
                .map(|declaration| {
                    let trimmed = declaration.trim();
                    if trimmed.is_empty()
                        || trimmed.contains("!important")
                        || !trimmed.contains(':')
                    {
                        declaration.to_owned()
                    } else {
                        format!("{} !important", declaration.trim_end())
                    }
                })
                .collect();
            out.push_str(&declarations.join(";"));
        } else {
            out.push_str(body);
        }
        out.push('}');
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

fn wrap(style: &Style, tag: &str, shadow: bool) -> String {
    let (prelude, body) = hoist(&style.css);
    let body = body.trim_matches('\n');
    let scoped = if shadow {
        format!("{body}\n")
    } else {
        let (own, slotted) = split_slotted(&host_to_scope(body), tag);
        let mut scoped = format!("@scope ({tag}) to ([{SLOTTED}=\"{tag}\"]) {{\n{own}\n}}\n");
        if !slotted.trim().is_empty() {
            // `::slotted()` rules reach the slotted elements themselves, which the block above
            // stops at, so they get a scope with no lower boundary.
            scoped.push_str(&format!(
                "@scope ({tag}) {{\n{}\n}}\n",
                slotted.trim_matches('\n')
            ));
        }
        scoped
    };
    let mut out = String::new();
    for statement in prelude {
        out.push_str(statement.trim());
        out.push('\n');
    }
    match &style.layer {
        None => out.push_str(&scoped),
        Some(layer) => {
            if layer == "components" {
                out.push_str("@layer theme, base, components, utilities;\n");
            }
            out.push_str(&format!("@layer {layer} {{\n{scoped}}}\n"));
        }
    }
    out
}

/// At-rules that must come before other rules (or that preprocessors need at the top level).
const HOISTED: &[&str] = &[
    "@import",
    "@charset",
    "@namespace",
    "@use",
    "@forward",
    "@reference",
    "@config",
    "@plugin",
];

/// Split leading statement at-rules (`@import "x";`) from the rest.
fn hoist(css: &str) -> (Vec<&str>, &str) {
    let mut statements = Vec::new();
    let mut rest = css;
    loop {
        let trimmed = skip_space_and_comments(rest);
        let lower = trimmed.to_ascii_lowercase();
        let Some(keyword) = HOISTED.iter().find(|keyword| {
            lower.starts_with(*keyword)
                && !lower[keyword.len()..]
                    .starts_with(|c: char| c.is_ascii_alphanumeric() || c == '-')
        }) else {
            break;
        };
        let _ = keyword;
        let Some(end) = statement_end(trimmed) else {
            break;
        };
        statements.push(&trimmed[..end]);
        rest = &trimmed[end..];
    }
    (statements, rest)
}

fn skip_space_and_comments(mut css: &str) -> &str {
    loop {
        css = css.trim_start();
        if let Some(rest) = css.strip_prefix("/*") {
            css = rest.find("*/").map_or("", |end| &rest[end + 2..]);
        } else {
            return css;
        }
    }
}

/// The end of a statement at-rule: just past its `;` (outside strings and parentheses).
fn statement_end(css: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote = None;
    for (index, character) in css.char_indices() {
        match (quote, character) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(character),
            (None, '(') => depth += 1,
            (None, ')') => depth = depth.saturating_sub(1),
            (None, '{') => return None, // a block, not a statement
            (None, ';') if depth == 0 => return Some(index + 1),
            _ => {}
        }
    }
    None
}

/// Group rules that may hold style rules, whose bodies are split too.
const GROUPING: &[&str] = &[
    "@media",
    "@supports",
    "@container",
    "@layer",
    "@starting-style",
];

/// Light DOM: split a stylesheet into the rules for the component's own elements and the
/// `::slotted()` rules, rewritten to match what's slotted in light DOM. Slotted elements take
/// the place of the `<zb-slot>`, so `.list > ::slotted(li)` becomes
/// `.list > :where([data-zb-slotted="tag"]):is(li)`: the slot's parent is the slotted
/// element's parent. `:where()` keeps the mark from adding specificity, as `::slotted(li)`'s is
/// `li`'s. A selector list with both kinds is split between the two. Group rules (`@media`,
/// `@supports`, …) are split inside and kept around each half; nested style rules aren't.
fn split_slotted(css: &str, tag: &str) -> (String, String) {
    let mut own = String::with_capacity(css.len());
    let mut slotted = String::new();
    let mut rest = css;
    loop {
        // Whitespace and comments between rules stay with the component's own rules.
        let trimmed = skip_space_and_comments(rest);
        own.push_str(&rest[..rest.len() - trimmed.len()]);
        rest = trimmed;
        if rest.is_empty() {
            break;
        }
        let Some((open, terminator)) = rule_head_end(rest) else {
            own.push_str(rest);
            break;
        };
        if terminator == ';' {
            // A statement at-rule (`@layer a, b;`).
            own.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
            continue;
        }
        let Some(close) = matching_brace(rest, open) else {
            own.push_str(rest);
            break;
        };
        let prelude = &rest[..open];
        let body = &rest[open + 1..close];
        let at_rule = prelude.trim_start().to_ascii_lowercase();
        if at_rule.starts_with('@') {
            if GROUPING.iter().any(|name| {
                at_rule.starts_with(name)
                    && !at_rule[name.len()..]
                        .starts_with(|c: char| c.is_ascii_alphanumeric() || c == '-')
            }) {
                let (inner_own, inner_slotted) = split_slotted(body, tag);
                own.push_str(&format!("{prelude}{{{inner_own}}}"));
                if !inner_slotted.trim().is_empty() {
                    slotted.push_str(&format!("{} {{\n{inner_slotted}}}\n", prelude.trim()));
                }
            } else {
                own.push_str(&rest[..=close]);
            }
        } else {
            let selectors = split_selector_list(prelude);
            let (with, without): (Vec<&str>, Vec<&str>) = selectors
                .into_iter()
                .partition(|selector| slotted_on_its_own(selector));
            if with.is_empty() {
                own.push_str(&rest[..=close]);
            } else {
                if !without.is_empty() {
                    let leading = &prelude[..prelude.len() - prelude.trim_start().len()];
                    own.push_str(&format!(
                        "{leading}{} {{{body}}}",
                        without
                            .iter()
                            .map(|s| s.trim())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                let rewritten: Vec<String> = with
                    .iter()
                    .map(|selector| rewrite_slotted(selector.trim(), tag))
                    .collect();
                slotted.push_str(&format!("{} {{{body}}}\n", rewritten.join(", ")));
            }
        }
        rest = &rest[close + 1..];
    }
    (own, slotted)
}

/// Where a rule's head ends: the index of its `{` or, for a statement at-rule, its `;`
/// (outside strings, comments and parentheses).
fn rule_head_end(css: &str) -> Option<(usize, char)> {
    let mut depth = 0usize;
    let mut quote = None;
    let bytes = css.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let character = bytes[index] as char;
        match (quote, character) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(character),
            (None, '/') if bytes.get(index + 1) == Some(&b'*') => {
                index = css[index + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |end| index + 2 + end + 2);
                continue;
            }
            (None, '(' | '[') => depth += 1,
            (None, ')' | ']') => depth = depth.saturating_sub(1),
            (None, '{') if depth == 0 => return Some((index, '{')),
            (None, ';') if depth == 0 => return Some((index, ';')),
            _ => {}
        }
        index += 1;
    }
    None
}

/// The index of the `}` closing the `{` at `open` (outside strings and comments).
fn matching_brace(css: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote = None;
    let bytes = css.as_bytes();
    let mut index = open;
    while index < bytes.len() {
        let character = bytes[index] as char;
        match (quote, character) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(character),
            (None, '/') if bytes.get(index + 1) == Some(&b'*') => {
                index = css[index + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |end| index + 2 + end + 2);
                continue;
            }
            (None, '{') => depth += 1,
            (None, '}') => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// A selector list split at its top-level commas.
fn split_selector_list(list: &str) -> Vec<&str> {
    let mut selectors = Vec::new();
    let mut depth = 0usize;
    let mut quote = None;
    let mut start = 0;
    for (index, character) in list.char_indices() {
        match (quote, character) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(character),
            (None, '(' | '[') => depth += 1,
            (None, ')' | ']') => depth = depth.saturating_sub(1),
            (None, ',') if depth == 0 => {
                selectors.push(&list[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    selectors.push(&list[start..]);
    selectors
}

/// Whether a selector uses `::slotted()` on its own (`.list > ::slotted(li)`), not attached to a
/// slot (`slot[name=a]::slotted(li)`): the `<zb-slot>` isn't in the light DOM to match, so those
/// are left as written.
fn slotted_on_its_own(selector: &str) -> bool {
    let mut found = false;
    let mut rest = selector;
    while let Some(at) = rest.find("::slotted(") {
        found = true;
        let before = rest[..at].trim_end_matches(' ');
        let attached = rest[..at].len() == before.len()
            && !before.is_empty()
            && !before.ends_with(['>', '+', '~', '(', ',']);
        if attached && !rest[..at].trim().is_empty() {
            return false;
        }
        rest = &rest[at + 1..];
    }
    found
}

/// `::slotted(x)` → `:where([data-zb-slotted="tag"]):is(x)` (`::slotted()` with nothing in it
/// stays as written: it matches nothing in shadow DOM either).
fn rewrite_slotted(selector: &str, tag: &str) -> String {
    let mut out = String::with_capacity(selector.len() + 48);
    let mut rest = selector;
    while let Some(at) = rest.find("::slotted(") {
        out.push_str(&rest[..at]);
        let inside = &rest[at + "::slotted(".len()..];
        let mut depth = 1usize;
        let mut end = None;
        for (index, character) in inside.char_indices() {
            match character {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else {
            out.push_str(&rest[at..]);
            return out;
        };
        let argument = inside[..end].trim();
        if argument.is_empty() {
            out.push_str("::slotted()");
        } else {
            out.push_str(&format!(":where([{SLOTTED}=\"{tag}\"]):is({argument})"));
        }
        rest = &inside[end + 1..];
    }
    out.push_str(rest);
    out
}

/// `:host` → `:scope` and `:host(x)` → `:scope:is(x)`, outside strings and comments.
fn host_to_scope(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("/*") {
            let end = after.find("*/").map_or(after.len(), |end| end + 2);
            out.push_str(&rest[..2 + end]);
            rest = &after[end..];
        } else if rest.starts_with(['"', '\'']) {
            let quote = rest.as_bytes()[0] as char;
            let end = rest[1..].find(quote).map_or(rest.len(), |end| end + 2);
            out.push_str(&rest[..end]);
            rest = &rest[end..];
        } else if rest.starts_with(":host")
            && !rest[5..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '-')
        {
            if rest[5..].starts_with('(') {
                out.push_str(":scope:is(");
                rest = &rest[6..];
            } else {
                out.push_str(":scope");
                rest = &rest[5..];
            }
        } else {
            let next = rest.chars().next().expect("not empty");
            out.push(next);
            rest = &rest[next.len_utf8()..];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostic::Span;

    fn style(css: &str, layer: Option<&str>) -> Style {
        Style {
            css: css.to_owned(),
            layer: layer.map(str::to_owned),
            lang: None,
            span: Span::new(1, 1),
        }
    }

    #[test]
    fn light_dom_styles_are_scoped_and_stop_at_slotted_content() {
        assert_eq!(
            wrap(&style("\n  h2 { color: red }\n  :host { display: block }\n", Some("components")), "zb-card", false),
            "@layer theme, base, components, utilities;\n@layer components {\n@scope (zb-card) to ([data-zb-slotted=\"zb-card\"]) {\n  h2 { color: red }\n  :scope { display: block }\n}\n}\n"
        );
    }

    #[test]
    fn shadow_dom_styles_are_layered_as_written() {
        assert_eq!(
            wrap(
                &style(":host { display: block }", Some("ui")),
                "zb-card",
                true
            ),
            "@layer ui {\n:host { display: block }\n}\n"
        );
        assert_eq!(
            wrap(&style("p { margin: 0 }", None), "zb-card", true),
            "p { margin: 0 }\n"
        );
    }

    #[test]
    fn leading_imports_stay_at_the_top() {
        let css = "/* theme */\n@reference \"tailwindcss\";\n@import url(\"a;b.css\") layer(x);\n.box { @apply p-4; }";
        let out = wrap(&style(css, None), "zb-card", false);
        assert!(
            out.starts_with(
                "@reference \"tailwindcss\";\n@import url(\"a;b.css\") layer(x);\n@scope (zb-card)"
            ),
            "{out}"
        );
        assert!(out.contains(".box { @apply p-4; }"), "{out}");
    }

    #[test]
    fn slotted_rules_reach_slotted_elements_in_light_dom() {
        let css = "\n  .list { display: grid }\n  .list > ::slotted(li), .list > .own { margin: 0 }\n  ::slotted(*) { color: red }\n";
        assert_eq!(
            wrap(&style(css, None), "zb-list", false),
            "@scope (zb-list) to ([data-zb-slotted=\"zb-list\"]) {\n  .list { display: grid }\n  .list > .own { margin: 0 }\n  \n}\n\
             @scope (zb-list) {\n.list > :where([data-zb-slotted=\"zb-list\"]):is(li) { margin: 0 }\n:where([data-zb-slotted=\"zb-list\"]):is(*) { color: red }\n}\n"
        );
    }

    #[test]
    fn slotted_rules_inside_group_rules_keep_the_group() {
        let (own, slotted) = split_slotted(
            "@media (width > 40em) { p { margin: 0 } ::slotted(p) { margin: 1px } }\n@layer a, b;",
            "zb-x",
        );
        assert_eq!(
            own,
            "@media (width > 40em) { p { margin: 0 }  }\n@layer a, b;"
        );
        assert_eq!(
            slotted,
            "@media (width > 40em) {\n:where([data-zb-slotted=\"zb-x\"]):is(p) { margin: 1px }\n}\n"
        );
    }

    #[test]
    fn slotted_attached_to_a_slot_and_in_strings_is_left_alone() {
        let css = "slot[name=a]::slotted(p) { margin: 0 }\n.a[title=\"::slotted(x)\"] { content: '::slotted(x)' }";
        let (own, slotted) = split_slotted(css, "zb-x");
        assert_eq!(own, css);
        assert_eq!(slotted, "");
        assert_eq!(
            wrap(&style("::slotted(p) { margin: 0 }", None), "zb-x", true),
            "::slotted(p) { margin: 0 }\n",
            "shadow DOM keeps it as written"
        );
    }

    #[test]
    fn host_becomes_scope_only_as_a_selector() {
        assert_eq!(
            host_to_scope(":host(.open) > p, :host-context(x), .a[title=\":host\"] /* :host */ { content: ':host' }"),
            ":scope:is(.open) > p, :host-context(x), .a[title=\":host\"] /* :host */ { content: ':host' }"
        );
    }
}
