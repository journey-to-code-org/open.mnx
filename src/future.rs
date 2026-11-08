//! What 3.0 changed, found in 2.x code (`plan/decisions/3.0-scope.md`).
//!
//! Since 3.0, a signal `const` in a script (from `state()`, `computed()`, `inject()`,
//! `hasSlot()` or `hydrated()`) means its value, as it already did in templates. `count.get()`
//! and `count.set(…)` keep working, so the only 2.x code that changes meaning passes the signal
//! itself:
//!
//! ```js
//! const count = state(0)
//! watch(count, log)            // 3.0: watches the number, not the signal
//! watch(signal(count), log)    // the signal, in 2.x and 3.0 alike
//! ```
//!
//! 2.6–2.11 warned about those uses, and `zubra migrate --to 3` wraps them in `signal(…)`
//! (`prepare`), which is the identity in 2.x. Run it once, on 2.x code: in 3.0 code, a bare name
//! is its value on purpose. `zubra migrate --to 3 --check` lists the places (`uses`).

use oxc_allocator::Allocator;
use oxc_ast::{
    ast::{
        BindingPattern, Expression, ImportDeclarationSpecifier, Statement, VariableDeclarationKind,
    },
    AstKind,
};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType};

use crate::{
    diagnostic::{Diagnostic, Span},
    migrate::script_body,
    scanner::span_after,
};

const MAKERS: &[&str] = &["state", "computed", "inject", "hasSlot", "hydrated"];

/// A use of a signal `const` that 3.0 reads as its value: where, and the name.
struct Use {
    start: u32,
    end: u32,
    name: String,
}

struct Analysis {
    /// Where the script body starts in the file.
    offset: usize,
    uses: Vec<Use>,
    /// The `@zubra/runtime` import, to add `signal` to: its specifiers' end, and whether
    /// `signal` is already imported.
    runtime_import: Option<(u32, bool)>,
}

fn analyse(source: &str) -> Option<Analysis> {
    let (start, end, typescript) = script_body(source)?;
    let script = &source[start..end];
    let allocator = Allocator::default();
    let source_type = if typescript {
        SourceType::ts()
    } else {
        SourceType::mjs()
    };
    let parsed = Parser::new(&allocator, script, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return None;
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();

    let mut makers = Vec::new();
    let mut runtime_import = None;
    for statement in &parsed.program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.source.value != "@zubra/runtime" {
            continue;
        }
        let mut has_signal = false;
        let mut last = None;
        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier {
                let imported = named.imported.name();
                if MAKERS.contains(&imported.as_str()) {
                    makers.push(named.local.name.to_string());
                }
                has_signal |= imported == "signal";
                last = Some(named.span.end);
            }
        }
        if let Some(last) = last {
            runtime_import = Some((last, has_signal));
        }
    }
    let mut uses = Vec::new();
    for statement in &parsed.program.body {
        let Statement::VariableDeclaration(declaration) = statement else {
            continue;
        };
        if declaration.kind != VariableDeclarationKind::Const {
            continue;
        }
        for declarator in &declaration.declarations {
            let (
                Some(Expression::CallExpression(call)),
                BindingPattern::BindingIdentifier(identifier),
            ) = (
                declarator
                    .init
                    .as_ref()
                    .map(Expression::without_parentheses),
                &declarator.id,
            )
            else {
                continue;
            };
            if !matches!(&call.callee, Expression::Identifier(callee) if makers.iter().any(|maker| maker == callee.name.as_str()))
            {
                continue;
            }
            for reference in scoping.get_resolved_references(identifier.symbol_id()) {
                let span = nodes.get_node(reference.node_id()).kind().span();
                let explicit = match nodes.parent_kind(reference.node_id()) {
                    // `count.get()`, `count.set(…)`, `count?.get()`: the same in 3.0.
                    AstKind::StaticMemberExpression(member) => {
                        member.object.span() == span
                            && matches!(member.property.name.as_str(), "get" | "set")
                    }
                    // Already `signal(count)`.
                    AstKind::CallExpression(call) => {
                        matches!(&call.callee, Expression::Identifier(callee) if callee.name == "signal")
                    }
                    _ => false,
                };
                if !explicit {
                    uses.push(Use {
                        start: span.start,
                        end: span.end,
                        name: identifier.name.to_string(),
                    });
                }
            }
        }
    }
    Some(Analysis {
        offset: start,
        uses,
        runtime_import,
    })
}

/// The places in 2.x code whose meaning 3.0 changes, for `zubra migrate --to 3 --check`.
pub fn uses(source: &str) -> Vec<Diagnostic> {
    let Some(analysis) = analyse(source) else {
        return Vec::new();
    };
    let script_start = span_after(Span::new(1, 1), source, analysis.offset);
    let script = &source[analysis.offset..];
    analysis
        .uses
        .iter()
        .map(|found| {
            Diagnostic::new(
                span_after(script_start, script, found.start as usize),
                format!("in 2.x, `{0}` here is the signal; since 3.0 it's its value (as in the template)", found.name),
            )
            .with_help(format!(
                "`zubra migrate --to 3` writes `signal({0})`, which keeps passing the signal itself (it means the same in 2.x)",
                found.name
            ))
        })
        .collect()
}

/// `zubra migrate --to 3`: wrap those uses in `signal(…)`, importing it. Returns the new source and
/// how many it wrapped.
pub fn prepare(source: &str) -> (String, usize) {
    let Some(analysis) = analyse(source) else {
        return (source.to_owned(), 0);
    };
    if analysis.uses.is_empty() {
        return (source.to_owned(), 0);
    }
    let mut edits: Vec<(usize, usize, String)> = analysis
        .uses
        .iter()
        .map(|found| {
            (
                analysis.offset + found.start as usize,
                analysis.offset + found.end as usize,
                format!("signal({})", found.name),
            )
        })
        .collect();
    if let Some((end, false)) = analysis.runtime_import {
        let at = analysis.offset + end as usize;
        edits.push((at, at, ", signal".to_owned()));
    }
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    let mut output = source.to_owned();
    for (from, to, text) in edits {
        output.replace_range(from..to, &text);
    }
    (output, analysis.uses.len())
}
