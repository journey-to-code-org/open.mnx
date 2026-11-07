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
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BinaryOperator, CallExpression, Expression,
    IdentifierReference, ImportDeclarationSpecifier, ObjectPropertyKind, Statement, UnaryOperator,
    VariableDeclarationKind,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};

use crate::{
    ast::{Binding, ComponentImport, Emit, Import, Script},
    diagnostic::{Diagnostic, Span},
    expression,
    scanner::span_after,
};

/// Parse `source` (the text between `<script>` and `</script>`), which begins at `start` in the
/// component file.
pub fn parse(source: &str, start: Span, typescript: bool) -> Result<Script, Diagnostic> {
    // TypeScript is reduced to JavaScript in place (same positions); its types are kept aside.
    let (stripped, types) = if typescript {
        crate::typescript::strip(source, start)?
    } else {
        (source.to_owned(), crate::typescript::Types::default())
    };
    let source = stripped.as_str();
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

    let mut script = Script {
        start: Some(start),
        declared_types: types.bindings.clone(),
        type_declarations: types.declarations.clone(),
        type_imports: types.imports.clone(),
        prop_types: types
            .props
            .iter()
            .map(|(name, text, offset)| (name.clone(), text.clone(), at(*offset)))
            .collect(),
        ..Script::default()
    };
    let mut import_ranges = Vec::new();
    // `hydrated` imported from @mnx/runtime (its local names), and bindings initialized with a
    // call, by their initializer's text: `const live = hydrated()` is `false` on the server.
    let mut hydrated_names: Vec<String> = Vec::new();
    let mut calls: Vec<(usize, String)> = Vec::new();
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
                            if matches!(init, oxc_ast::ast::Expression::CallExpression(_)) {
                                calls.push((script.bindings.len(), text.to_owned()));
                            }
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
                    if let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier {
                        if import.source.value.as_str() == Some(RUNTIME)
                            && named.imported.name().as_str() == "emit"
                        {
                            script.emit = Some(named.local.name.to_string());
                        }
                        if import.source.value.as_str() == Some(RUNTIME)
                            && named.imported.name().as_str() == "hydrated"
                        {
                            hydrated_names.push(named.local.name.to_string());
                        }
                    }
                }
                let range = import.span.start as usize..import.span.end as usize;
                let specifier = import.source.value.as_str().unwrap_or_default().to_owned();
                // The specifier's quotes included; relative to the import statement's text.
                let specifier_range = (import.source.span.start as usize - range.start)
                    ..(import.source.span.end as usize - range.start);
                if crate::components::is_component(&specifier) {
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
    if let Some(emit) = script.emit.clone() {
        let mut finder = EmitFinder {
            emit: &emit,
            declared: &types.emits,
            at: &at,
            emits: Vec::new(),
            error: None,
        };
        finder.visit_program(&parsed.program);
        if let Some(error) = finder.error {
            return Err(error);
        }
        script.emits = finder.emits;
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
    // `hydrated()` is false until the element starts, so on the server it's `false`.
    for (index, text) in calls {
        let call = text.split_whitespace().collect::<String>();
        if hydrated_names.iter().any(|name| call == format!("{name}()")) {
            script.bindings[index].init = Some(expression::Expression::Boolean(false));
        }
    }
    Ok(script)
}

/// `emit("name", detail)` calls in a template's runtime expression (`onclick={() => emit(…)}`),
/// located at the expression.
pub fn template_emits(source: &str, emit: &str, span: Span) -> Result<Vec<Emit>, Diagnostic> {
    let wrapped = format!("({source}\n)");
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &wrapped, SourceType::mjs()).parse();
    let declared = std::collections::HashMap::new();
    let at = |_: u32| span;
    let mut finder = EmitFinder {
        emit,
        declared: &declared,
        at: &at,
        emits: Vec::new(),
        error: None,
    };
    finder.visit_program(&parsed.program);
    match finder.error {
        Some(error) => Err(error),
        None => Ok(finder.emits),
    }
}

/// The module components import hooks from.
pub const RUNTIME: &str = "@mnx/runtime";

/// Finds `emit("name", detail)` calls; `emit` used any other way can't be analyzed.
struct EmitFinder<'s, F: Fn(u32) -> Span> {
    emit: &'s str,
    /// `emit<Detail>(…)` types, by call offset (TypeScript scripts).
    declared: &'s std::collections::HashMap<u32, String>,
    at: &'s F,
    emits: Vec<Emit>,
    error: Option<Diagnostic>,
}

impl<'a, F: Fn(u32) -> Span> Visit<'a> for EmitFinder<'_, F> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let Expression::Identifier(callee) = &call.callee else {
            return walk::walk_call_expression(self, call);
        };
        if callee.name.as_str() != self.emit {
            return walk::walk_call_expression(self, call);
        }
        if self.error.is_none() {
            match emitted(call, self.at) {
                Ok(mut emit) => {
                    if let Some(declared) = self.declared.get(&call.span.start) {
                        emit.detail.clone_from(declared);
                    }
                    self.emits.push(emit);
                }
                Err(error) => self.error = Some(error),
            }
        }
        // Not the callee: that's this call. The arguments may emit too.
        self.visit_arguments(&call.arguments);
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if identifier.name.as_str() == self.emit && self.error.is_none() {
            self.error = Some(Diagnostic::new(
                (self.at)(identifier.span.start),
                format!("call `{}(\"name\", detail)` directly, so the compiler can see which events the component fires", self.emit),
            ));
        }
    }
}

fn emitted(call: &CallExpression<'_>, at: &impl Fn(u32) -> Span) -> Result<Emit, Diagnostic> {
    let span = at(call.span.start);
    let name =
        match call.arguments.first().and_then(Argument::as_expression) {
            Some(Expression::StringLiteral(literal)) => {
                literal.value.as_str().unwrap_or_default().to_owned()
            }
            Some(Expression::TemplateLiteral(template)) if template.expressions.is_empty() => {
                template.quasis[0].value.raw.to_string()
            }
            _ => return Err(Diagnostic::new(
                span,
                "the event name must be a string literal, so the compiler can declare the event",
            )),
        };
    if !is_event_name(&name) {
        let fixed: String = name
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_lowercase();
        let error = Diagnostic::new(
            span,
            format!("event names are lowercase letters and digits, like the DOM's own (`input`, `selectionchange`); got `{name}`"),
        );
        return Err(if is_event_name(&fixed) {
            error.with_help(format!("use `{fixed}`"))
        } else {
            error
        });
    }
    if call.arguments.len() > 2 {
        return Err(Diagnostic::new(
            span,
            "emit takes an event name and one detail value",
        ));
    }
    let detail = match call.arguments.get(1) {
        None => "null".to_owned(),
        Some(argument) => argument
            .as_expression()
            .map_or_else(|| "unknown".to_owned(), detail_type),
    };
    Ok(Emit { name, detail, span })
}

/// `valuechange`, `beforetoggle`: what the DOM's own event names look like.
pub fn is_event_name(name: &str) -> bool {
    name.starts_with(|first: char| first.is_ascii_lowercase())
        && name
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

/// The TypeScript type of an event's detail, from the shape of the expression that makes it.
fn detail_type(expression: &Expression<'_>) -> String {
    match expression {
        Expression::StringLiteral(_) | Expression::TemplateLiteral(_) => "string".to_owned(),
        Expression::NumericLiteral(_) => "number".to_owned(),
        Expression::BooleanLiteral(_) => "boolean".to_owned(),
        Expression::NullLiteral(_) => "null".to_owned(),
        Expression::ParenthesizedExpression(inner) => detail_type(&inner.expression),
        Expression::UnaryExpression(unary) => match unary.operator {
            UnaryOperator::LogicalNot | UnaryOperator::Delete => "boolean".to_owned(),
            UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus => "number".to_owned(),
            UnaryOperator::Typeof => "string".to_owned(),
            _ => "unknown".to_owned(),
        },
        Expression::BinaryExpression(binary) => {
            let operator = binary.operator;
            if operator.is_equality() || operator.is_compare() || operator.is_relational() {
                "boolean".to_owned()
            } else if operator == BinaryOperator::Addition {
                match (
                    detail_type(&binary.left).as_str(),
                    detail_type(&binary.right).as_str(),
                ) {
                    ("string", _) | (_, "string") => "string".to_owned(),
                    ("number", "number") => "number".to_owned(),
                    _ => "unknown".to_owned(),
                }
            } else if operator.is_arithmetic() {
                "number".to_owned()
            } else {
                "unknown".to_owned()
            }
        }
        Expression::ConditionalExpression(conditional) => union([
            detail_type(&conditional.consequent),
            detail_type(&conditional.alternate),
        ]),
        Expression::ArrayExpression(array) => {
            let types: Vec<String> = array
                .elements
                .iter()
                .map(|element| match element {
                    ArrayExpressionElement::SpreadElement(_)
                    | ArrayExpressionElement::Elision(_) => "unknown".to_owned(),
                    element => element
                        .as_expression()
                        .map_or_else(|| "unknown".to_owned(), detail_type),
                })
                .collect();
            match union(types).as_str() {
                "never" => "unknown[]".to_owned(),
                one if !one.contains(" | ") => format!("{one}[]"),
                many => format!("({many})[]"),
            }
        }
        Expression::ObjectExpression(object) => {
            let mut members = Vec::new();
            for property in &object.properties {
                let ObjectPropertyKind::ObjectProperty(property) = property else {
                    return "Record<string, unknown>".to_owned();
                };
                let Some(key) = property.key.static_name().filter(|_| !property.computed) else {
                    return "Record<string, unknown>".to_owned();
                };
                let value = if property.method {
                    "(...args: any[]) => unknown".to_owned()
                } else {
                    detail_type(&property.value)
                };
                members.push(format!(
                    "{}: {value}",
                    crate::emit_interface::property_key(
                        key.as_js_str().as_str().unwrap_or_default()
                    )
                ));
            }
            if members.is_empty() {
                "Record<string, unknown>".to_owned()
            } else {
                format!("{{ {} }}", members.join("; "))
            }
        }
        _ => "unknown".to_owned(),
    }
}

/// `a | b` without repeats; `unknown` absorbs everything.
pub fn union(types: impl IntoIterator<Item = String>) -> String {
    let mut seen: Vec<String> = Vec::new();
    for type_ in types {
        if type_ == "unknown" {
            return type_;
        }
        if !seen.contains(&type_) {
            seen.push(type_);
        }
    }
    if seen.is_empty() {
        "never".to_owned()
    } else {
        seen.join(" | ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_build_time_bindings_and_runtime_names() {
        let script = parse(
            "import { state } from '@mnx/runtime'\nconst title = \"Mikey\"\nlet count = 1 + 2\nconst now = Date.now()\nconst { a, b } = thing\nfunction inc() { emit('valuechange', 1) }\nclass Thing {}\nconsole.log(title)",
            Span::new(2, 1),
            false,
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
        let error = parse("const ok = 1\nconst = 2", Span::new(5, 3), false).unwrap_err();
        assert!(error.message.starts_with("invalid <script>"));
        assert_eq!(error.span.line, 6);
        assert!(parse("var x = 1", Span::new(1, 1), false)
            .unwrap_err()
            .message
            .contains("`var`"));
        assert!(parse("export const x = 1", Span::new(1, 1), false)
            .unwrap_err()
            .message
            .contains("can't export"));
        assert!(parse("export default {}", Span::new(1, 1), false)
            .unwrap_err()
            .message
            .contains("default export"));
    }
}
