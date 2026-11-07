//! Template expressions beyond the build-time subset: any JavaScript expression (calls, arrow
//! functions, `new`, assignments in handlers …). They run in the browser only, so the JavaScript
//! output supports them and the HTML output reports them, as it does script values that only
//! exist at runtime.
//!
//! The expression is kept as source text, with the position of every free identifier (found with
//! oxc's scope analysis), so the JavaScript backend can map names to props, loop variables and
//! script bindings the way it does for subset expressions.

use oxc_allocator::Allocator;
use oxc_ast::ast::{ObjectPropertyKind, PropertyKey};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType};

/// A free identifier in a runtime expression.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Name {
    pub name: String,
    /// Byte range in the expression source.
    pub range: std::ops::Range<usize>,
    /// `{ name }`: printed as `name: <mapped>`.
    pub shorthand: bool,
    /// Assigned to (`name = …`, `name++`).
    pub written: bool,
}

/// Parse `source` as one JavaScript expression. Errors carry a byte offset into `source`.
pub fn parse(source: &str) -> Result<Vec<Name>, (usize, String)> {
    // Parenthesized, so `{ a: 1 }` is an object and a trailing statement can't sneak in.
    let wrapped = format!("({source}\n)");
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &wrapped, SourceType::mjs()).parse();
    if let Some(error) = parsed.diagnostics.first() {
        let offset = error.labels.first().map_or(0, |label| {
            (label.offset() as usize)
                .saturating_sub(1)
                .min(source.len())
        });
        return Err((offset, error.message.to_string()));
    }
    let program = &parsed.program;
    let [statement] = program.body.as_slice() else {
        return Err((0, "expected one expression".to_owned()));
    };
    if !matches!(statement, oxc_ast::ast::Statement::ExpressionStatement(_)) {
        return Err((0, "expected an expression".to_owned()));
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();

    let mut shorthands = Shorthands(Vec::new());
    shorthands.visit_program(program);

    let mut names = Vec::new();
    for (name, references) in scoping.root_unresolved_references() {
        for &reference_id in references {
            let reference = scoping.get_reference(reference_id);
            let span = nodes.get_node(reference.node_id()).kind().span();
            let start = span.start as usize - 1;
            names.push(Name {
                name: name.to_string(),
                range: start..span.end as usize - 1,
                shorthand: shorthands.0.contains(&span.start),
                written: reference.is_write(),
            });
        }
    }
    names.sort_by_key(|name| name.range.start);
    Ok(names)
}

/// Where `{ name }` shorthand properties are, by the identifier's start.
struct Shorthands(Vec<u32>);

impl<'a> Visit<'a> for Shorthands {
    fn visit_object_property_kind(&mut self, kind: &ObjectPropertyKind<'a>) {
        if let ObjectPropertyKind::ObjectProperty(property) = kind {
            if property.shorthand {
                if let PropertyKey::StaticIdentifier(key) = &property.key {
                    self.0.push(key.span.start);
                }
            }
        }
        walk::walk_object_property_kind(self, kind);
    }
}

/// `source` with each free identifier replaced by `map(name)`, parenthesized.
pub fn to_js(source: &str, names: &[Name], map: &dyn Fn(&str) -> String) -> String {
    let mut out = String::from("(");
    let mut at = 0;
    for name in names {
        out.push_str(&source[at..name.range.start]);
        if name.shorthand {
            out.push_str(&format!("{}: ", name.name));
        }
        out.push_str(&map(&name.name));
        at = name.range.end;
    }
    out.push_str(&source[at..]);
    out.push(')');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn free(source: &str) -> Vec<(String, bool, bool)> {
        parse(source)
            .unwrap()
            .into_iter()
            .map(|name| (name.name, name.shorthand, name.written))
            .collect()
    }

    #[test]
    fn finds_free_identifiers_only() {
        assert_eq!(
            free("items.map((item, i) => format(item, i, { size }))"),
            [
                ("items".to_owned(), false, false),
                ("format".to_owned(), false, false),
                ("size".to_owned(), true, false)
            ]
        );
        assert_eq!(
            free("() => { const x = 1; count = x + total }"),
            [
                ("count".to_owned(), false, true),
                ("total".to_owned(), false, false)
            ]
        );
        assert_eq!(
            free("a.b.c?.(d)"),
            [
                ("a".to_owned(), false, false),
                ("d".to_owned(), false, false)
            ]
        );
    }

    #[test]
    fn maps_names_and_expands_shorthands() {
        let source = "pick({ value }, other)";
        let names = parse(source).unwrap();
        assert_eq!(
            to_js(source, &names, &|name| format!("$p.{name}")),
            "($p.pick({ value: $p.value }, $p.other))"
        );
    }

    #[test]
    fn rejects_statements_and_reports_where() {
        assert!(parse("a; b").is_err());
        let (offset, _) = parse("format(a,, )").unwrap_err();
        assert!(offset <= 12);
        assert!(parse("").is_err());
    }
}
