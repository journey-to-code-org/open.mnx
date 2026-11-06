//! Reading the `<script>` block.
//!
//! The script is real JavaScript, parsed with oxc. The compiler needs two things from it:
//!
//! 1. **Build-time values.** Each top-level `const`/`let` whose initializer is inside the
//!    expression language (literals, objects, arrays, arithmetic, member access, …) can be
//!    evaluated during the build, so static HTML can be rendered from it. The initializer's
//!    source text is located with oxc's spans and handed to [`crate::expression::parse`], so the
//!    build-time semantics are exactly the expression language's — one evaluator, not two.
//! 2. **Every declared name**, so the resolver can tell a typo from a name that simply only
//!    exists at runtime (a function, a class, an import, or a `const` initialized by a call).
//!
//! Everything else in the script is left for the JavaScript output to carry verbatim.

use oxc_allocator::Allocator;
use oxc_ast::ast::{Statement, VariableDeclarationKind};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};

use crate::{
    ast::{Binding, ComponentImport, Import, Script},
    diagnostic::{Diagnostic, Span},
    expression,
    scanner::span_after,
};

/// Parse `source` (the text between `<script>` and `</script>`), which begins at `start` in the
/// component file.
pub fn parse(source: &str, start: Span) -> Result<Script, Diagnostic> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    let at = |offset: u32| span_after(start, source, offset as usize);
    if let Some(error) = parsed.diagnostics.first() {
        let offset = error.labels.first().map_or(0, |label| label.offset());
        return Err(Diagnostic::new(
            at(offset),
            format!("invalid <script>: {}", error.message),
        ));
    }

    let mut script = Script::default();
    let mut import_ranges = Vec::new();
    for statement in &parsed.program.body {
        match statement {
            Statement::VariableDeclaration(declaration) => {
                let mutable = match declaration.kind {
                    VariableDeclarationKind::Const => false,
                    VariableDeclarationKind::Let => true,
                    VariableDeclarationKind::Var => {
                        return Err(Diagnostic::new(
                            at(declaration.span.start),
                            "use `const` or `let` instead of `var` in a component script",
                        ));
                    }
                    _ => {
                        for name in declaration
                            .declarations
                            .iter()
                            .flat_map(|declarator| declarator.id.get_binding_identifiers())
                        {
                            script.runtime_names.push(name.name.to_string());
                        }
                        continue;
                    }
                };
                for declarator in &declaration.declarations {
                    let names = declarator.id.get_binding_identifiers();
                    let simple = declarator.id.get_binding_identifier();
                    match (simple, &declarator.init) {
                        (Some(identifier), Some(init)) => {
                            let text =
                                &source[init.span().start as usize..init.span().end as usize];
                            script.bindings.push(Binding {
                                name: identifier.name.to_string(),
                                init: expression::parse(text).ok(),
                                mutable,
                                span: at(identifier.span.start),
                            });
                        }
                        (Some(identifier), None) => script.bindings.push(Binding {
                            name: identifier.name.to_string(),
                            init: Some(expression::Expression::Null),
                            mutable,
                            span: at(identifier.span.start),
                        }),
                        // Destructuring: the names exist, but only at runtime for now.
                        (None, _) => script
                            .runtime_names
                            .extend(names.iter().map(|name| name.name.to_string())),
                    }
                }
            }
            Statement::FunctionDeclaration(function) => {
                if let Some(id) = &function.id {
                    script.runtime_names.push(id.name.to_string());
                }
            }
            Statement::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    script.runtime_names.push(id.name.to_string());
                }
            }
            Statement::ImportDeclaration(import) => {
                for specifier in import.specifiers.iter().flatten() {
                    script.runtime_names.push(specifier.name().to_string());
                }
                let range = import.span.start as usize..import.span.end as usize;
                let specifier = import.source.value.as_str().unwrap_or_default().to_owned();
                // The specifier's quotes included; relative to the import statement's text.
                let specifier_range = (import.source.span.start as usize - range.start)
                    ..(import.source.span.end as usize - range.start);
                if specifier.ends_with(".mnx") {
                    script.components.push(ComponentImport {
                        specifier: specifier.clone(),
                        span: at(import.source.span.start),
                    });
                }
                script.imports.push(Import {
                    text: source[range.clone()].to_owned(),
                    specifier,
                    specifier_range,
                });
                import_ranges.push(range);
            }
            Statement::ExportNamedDeclaration(_)
            | Statement::ExportDeclaration(_)
            | Statement::ExportAllDeclaration(_)
            | Statement::ExportFromDeclaration(_) => {
                return Err(Diagnostic::new(
                    at(statement.span().start),
                    "a component script can't export; declare a prop on the host tag instead, or move shared code to a module and import it",
                ));
            }
            Statement::ExportDefaultDeclaration(export) => {
                return Err(Diagnostic::new(
                    at(export.span.start),
                    "a component script can't have a default export; the host tag defines the component",
                ));
            }
            // Other statements (expression statements, `if`, …) run at runtime and declare nothing.
            _ => {}
        }
    }
    // The body without its imports. Removed imports become blank space of the same shape, so
    // line numbers in the emitted setup function still match the source.
    let mut body = source.to_owned();
    for range in import_ranges.iter().rev() {
        let blank: String = source[range.clone()]
            .chars()
            .map(|character| if character == '\n' { '\n' } else { ' ' })
            .collect();
        body.replace_range(range.clone(), &blank);
    }
    script.body = body;
    Ok(script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_build_time_bindings_and_runtime_names() {
        let script = parse(
            "import { state } from '@mnx/runtime'\nconst title = \"Mikey\"\nlet count = 1 + 2\nconst now = Date.now()\nconst { a, b } = thing\nfunction inc() { emit('valuechange', 1) }\nclass Thing {}\nconsole.log(title)",
            Span::new(2, 1),
        )
        .unwrap();
        let names: Vec<_> = script
            .bindings
            .iter()
            .map(|b| (b.name.as_str(), b.init.is_some(), b.mutable))
            .collect();
        assert_eq!(
            names,
            [
                ("title", true, false),
                ("count", true, true),
                ("now", false, false)
            ]
        );
        assert_eq!(script.runtime_names, ["state", "a", "b", "inc", "Thing"]);
        assert_eq!(script.bindings[1].span, Span::new(4, 5));
        assert_eq!(
            script.imports[0].text,
            "import { state } from '@mnx/runtime'"
        );
        assert_eq!(script.imports[0].specifier, "@mnx/runtime");
        assert_eq!(
            &script.imports[0].text[script.imports[0].specifier_range.clone()],
            "'@mnx/runtime'"
        );
        assert!(script
            .body
            .starts_with("                                    \nconst title"));
    }

    #[test]
    fn reports_syntax_errors_and_unsupported_forms_at_their_position() {
        let error = parse("const ok = 1\nconst = 2", Span::new(5, 3)).unwrap_err();
        assert!(error.message.starts_with("invalid <script>"));
        assert_eq!(error.span.line, 6);
        assert!(parse("var x = 1", Span::new(1, 1))
            .unwrap_err()
            .message
            .contains("`var`"));
        assert!(parse("export const x = 1", Span::new(1, 1))
            .unwrap_err()
            .message
            .contains("can't export"));
        assert!(parse("export default {}", Span::new(1, 1))
            .unwrap_err()
            .message
            .contains("default export"));
    }
}
