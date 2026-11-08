//! `zubra migrate`: rewrite a 1.x `.zb` file for 2.0, and say what else changes.
//!
//! 2.0 makes props names in the script (`value`, not `props().value`), so a script binding with
//! a prop's name would clash with it. The usual case is a default taken from the script:
//!
//! ```html
//! <script>const title = "Hi"</script>   →   <script>const titleDefault = "Hi"</script>
//! <zb-card title={title}>              →   <zb-card title={titleDefault}>
//! ```
//!
//! The binding and every reference to it in the script and in host defaults are renamed. In the
//! template, a prop's name already means the prop, so nothing there changes. The other 2.0
//! change for `.zb` files, `let` becoming state, needs no rewrite: such a `let` starts
//! updating the template, which is reported as a note.

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::{
    ast::{BindingPattern, ImportDeclarationSpecifier, Statement},
    AstKind,
};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType};

use crate::{
    ast::PropDefault,
    diagnostic::{Diagnostic, Span},
    scanner::span_after,
};

/// What migrating one file does.
#[derive(Debug, Default)]
pub struct Migration {
    /// The rewritten source (the same text when nothing changes).
    pub output: String,
    /// One line per rename.
    pub changes: Vec<String>,
    /// Behavior changes that need no rewrite, at their place in the file.
    pub notes: Vec<Diagnostic>,
}

/// Where a component's `<script>` body is in its file, and whether it's TypeScript.
pub(crate) fn script_body(source: &str) -> Option<(usize, usize, bool)> {
    let lower = source.to_ascii_lowercase();
    let mut at = 0;
    loop {
        let open = lower[at..].find("<script")? + at;
        // Skip `<script` inside a comment.
        if let Some(comment) = lower[..open].rfind("<!--") {
            if lower[comment..open].find("-->").is_none() {
                at = open + 7;
                continue;
            }
        }
        let tag_end = lower[open..].find('>')? + open + 1;
        let close = lower[tag_end..].find("</script")? + tag_end;
        let typescript = lower[open..tag_end].contains("lang=\"ts\"")
            || lower[open..tag_end].contains("lang='ts'");
        return Some((tag_end, close, typescript));
    }
}

fn offset_of(source: &str, span: Span) -> usize {
    let mut line = 1;
    let mut column = 1;
    for (offset, character) in source.char_indices() {
        if line == span.line && column == span.column {
            return offset;
        }
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    source.len()
}

/// Migrate `source` (an `.zb` file).
pub fn migrate(source: &str) -> Result<Migration, Diagnostic> {
    let component = crate::parser::parse_for_migration(source)?;
    let mut migration = Migration {
        output: source.to_owned(),
        ..Migration::default()
    };
    let Some((start, end, typescript)) = script_body(source) else {
        return Ok(migration);
    };
    let script = &source[start..end];
    let allocator = Allocator::default();
    let source_type = if typescript {
        SourceType::ts()
    } else {
        SourceType::mjs()
    };
    let parsed = Parser::new(&allocator, script, source_type).parse();
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();

    // Top-level names, by symbol.
    let mut top = Vec::new();
    for statement in &parsed.program.body {
        match statement {
            Statement::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    for identifier in declarator.id.get_binding_identifiers() {
                        top.push((
                            identifier.name.to_string(),
                            identifier.symbol_id(),
                            identifier.span,
                        ));
                    }
                }
            }
            Statement::FunctionDeclaration(function) => {
                if let Some(id) = &function.id {
                    top.push((id.name.to_string(), id.symbol_id(), id.span));
                }
            }
            Statement::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    top.push((id.name.to_string(), id.symbol_id(), id.span));
                }
            }
            Statement::ImportDeclaration(import) => {
                for specifier in import.specifiers.iter().flatten() {
                    let local = match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(named) => &named.local,
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                            &default.local
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                            &namespace.local
                        }
                    };
                    top.push((local.name.to_string(), local.symbol_id(), local.span));
                }
            }
            _ => {}
        }
    }
    let taken: HashSet<String> = scoping.symbol_names().map(str::to_owned).collect();
    let props: Vec<&str> = component
        .props
        .iter()
        .map(|prop| prop.name.as_str())
        .collect();

    // Renames: a top-level name that is also a prop.
    let mut renames: HashMap<String, String> = HashMap::new();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for (name, symbol, span) in &top {
        if !props.contains(&name.as_str()) {
            continue;
        }
        let mut renamed = format!("{name}Default");
        let mut counter = 2;
        while taken.contains(&renamed) || props.contains(&renamed.as_str()) {
            renamed = format!("{name}Default{counter}");
            counter += 1;
        }
        edits.push((
            start + span.start as usize,
            start + span.end as usize,
            renamed.clone(),
        ));
        for reference in scoping.get_resolved_references(*symbol) {
            let node = nodes.get_node(reference.node_id());
            let at = node.kind().span();
            let shorthand = matches!(nodes.parent_kind(reference.node_id()), AstKind::ObjectProperty(property) if property.shorthand);
            let text = if shorthand {
                format!("{name}: {renamed}")
            } else {
                renamed.clone()
            };
            edits.push((start + at.start as usize, start + at.end as usize, text));
        }
        migration.changes.push(format!(
            "renamed the script's `{name}` to `{renamed}`: in 2.0, `{name}` in the script is the prop"
        ));
        renames.insert(name.clone(), renamed);
    }
    // Host defaults that use a renamed binding.
    if !renames.is_empty() {
        for prop in &component.props {
            let PropDefault::Expression(_, span) = &prop.default else {
                continue;
            };
            let open = offset_of(source, *span);
            let Ok(braced) = crate::scanner::Cursor::new(&source[open..]).scan_braced() else {
                continue;
            };
            let inner_start = open + 1;
            let Ok(names) = crate::runtime_expression::parse(braced.inner) else {
                continue;
            };
            for found in names {
                if let Some(renamed) = renames.get(&found.name) {
                    let text = if found.shorthand {
                        format!("{}: {renamed}", found.name)
                    } else {
                        renamed.clone()
                    };
                    edits.push((
                        inner_start + found.range.start,
                        inner_start + found.range.end,
                        text,
                    ));
                }
            }
        }
    }
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    edits.dedup_by_key(|edit| edit.0);
    for (from, to, text) in edits {
        migration.output.replace_range(from..to, &text);
    }

    // Notes: a `let` the script changes and the template reads starts updating it.
    let mut template_names = HashSet::new();
    crate::ast::for_each_expression(&component.nodes, &mut |expression, _| {
        expression.for_each_identifier(&mut |name| {
            template_names.insert(name.to_owned());
        });
    });
    for statement in &parsed.program.body {
        let Statement::VariableDeclaration(declaration) = statement else {
            continue;
        };
        if declaration.kind != oxc_ast::ast::VariableDeclarationKind::Let {
            continue;
        }
        for declarator in &declaration.declarations {
            let BindingPattern::BindingIdentifier(identifier) = &declarator.id else {
                continue;
            };
            let name = identifier.name.as_str();
            let written = scoping
                .get_resolved_references(identifier.symbol_id())
                .any(|reference| reference.is_write());
            if written && template_names.contains(name) && !props.contains(&name) {
                migration
                    .notes
                    .push(note(source, start, script, identifier.span.start, name));
            }
        }
    }
    Ok(migration)
}

fn note(source: &str, start: usize, script: &str, at: u32, name: &str) -> Diagnostic {
    let script_start = span_after(Span::new(1, 1), source, start);
    Diagnostic::new(
        span_after(script_start, script, at as usize),
        format!("`{name}` is a `let` the script changes and the template reads: in 2.0 `let` is state, so the template will update when it changes (in 1.x it doesn't)"),
    )
    .with_help("nothing to rewrite; check that updating is what you want")
}
