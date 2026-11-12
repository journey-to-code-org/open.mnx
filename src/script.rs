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
    ast::{Binding, ComponentImport, Emit, Import, ImportKind, ImportName, Script, ServerExport},
    diagnostic::{Diagnostic, Span},
    expression,
    scanner::span_after,
};

/// Drop the imported names a TypeScript script uses only as types, as TypeScript does, unless
/// the component reads them elsewhere (`used`: every name its host attributes and template
/// read). An import left with no names goes entirely; one that keeps some is rewritten with
/// those. Without this, `import { Option } from './types'` (an interface) would reach the
/// browser, which refuses a module importing a name its source doesn't export.
pub fn elide_type_only_imports(script: &mut Script, used: &std::collections::HashSet<String>) {
    if script.type_only_imports.is_empty() {
        return;
    }
    let elided: Vec<String> = std::mem::take(&mut script.type_only_imports)
        .into_iter()
        .filter(|name| !used.contains(name))
        .collect();
    if elided.is_empty() {
        return;
    }
    let mut kept_imports = Vec::new();
    for mut import in std::mem::take(&mut script.imports) {
        let before = import.names.len();
        import.names.retain(|name| !elided.contains(&name.local));
        if import.names.len() == before {
            kept_imports.push(import);
            continue;
        }
        if import.names.is_empty() {
            continue;
        }
        // `import A, * as B, { c, d as e } from "x" with { … }`, from what's left.
        let mut clauses = Vec::new();
        let named: Vec<&str> = import
            .names
            .iter()
            .filter(|name| name.kind == ImportKind::Named)
            .map(|name| name.text.as_str())
            .collect();
        for name in &import.names {
            if name.kind != ImportKind::Named {
                clauses.push(name.text.clone());
            }
        }
        if !named.is_empty() {
            clauses.push(format!("{{ {} }}", named.join(", ")));
        }
        let head = format!("import {} from ", clauses.join(", "));
        let tail = import.text[import.specifier_range.clone()].to_owned()
            + &import.text[import.specifier_range.end..];
        import.specifier_range = head.len()..head.len() + (import.specifier_range.len());
        import.text = head + &tail;
        kept_imports.push(import);
    }
    script.imports = kept_imports;
    script.runtime_names.retain(|name| !elided.contains(name));
}

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
        type_only_imports: types.type_only.clone(),
        prop_types: types
            .props
            .iter()
            .map(|(name, text, offset)| (name.clone(), text.clone(), at(*offset)))
            .collect(),
        ..Script::default()
    };
    let (collection, unknown) = directive(&parsed.program.directives, &at)?;
    script.collection = collection;
    script.unknown_directives = unknown;
    let mut import_ranges = Vec::new();
    // `'use server'` functions: where they are, and every name they reference.
    let mut import_locals: Vec<Vec<String>> = Vec::new();
    let mut server_ranges: Vec<std::ops::Range<usize>> = Vec::new();
    let mut server_references: std::collections::HashSet<String> = Default::default();
    // `hydrated` imported from @zubra/runtime (its local names), and bindings initialized with a
    // call, by their initializer's text: `const live = hydrated()` is `false` on the server.
    let mut hydrated_names: Vec<String> = Vec::new();
    // `ephemeral` imported from @zubra/sync (its local names).
    let mut ephemeral_names: Vec<String> = Vec::new();
    let mut presence_names: Vec<String> = Vec::new();
    let mut peers_names: Vec<String> = Vec::new();
    let mut calls: Vec<(usize, String)> = Vec::new();
    // `from` imported from @zubra/runtime, and `let x = from(arg)` bindings: (binding, callee,
    // the argument's text, whether it's a `let`, where it is).
    let mut from_names: Vec<String> = Vec::new();
    let mut linked: Vec<(usize, String, String, bool, u32)> = Vec::new();
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
                            if let oxc_ast::ast::Expression::CallExpression(call) = init {
                                calls.push((script.bindings.len(), text.to_owned()));
                                if let (
                                    oxc_ast::ast::Expression::Identifier(callee),
                                    [argument] | [_, argument],
                                ) = (&call.callee, call.arguments.as_slice())
                                {
                                    // `from(() => …)` is already compiled (JSX lowering).
                                    let compiled = matches!(
                                        argument,
                                        oxc_ast::ast::Argument::ArrowFunctionExpression(_)
                                    );
                                    if !argument.is_spread() && !compiled {
                                        let span = argument.span();
                                        linked.push((
                                            script.bindings.len(),
                                            callee.name.to_string(),
                                            source[span.start as usize..span.end as usize]
                                                .to_owned(),
                                            mutable,
                                            call.span.start,
                                        ));
                                    }
                                }
                            }
                            script.bindings.push(Binding {
                                name: identifier.name.to_string(),
                                init: expression::parse(text).ok(),
                                source: Some(text.to_owned()),
                                mutable,
                                span: at(identifier.span.start),
                            });
                        }
                        (Some(identifier), None) => script.bindings.push(Binding {
                            name: identifier.name.to_string(),
                            init: Some(expression::Expression::Null),
                            source: None,
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
                        if import.source.value.as_str() == Some(SYNC)
                            && named.imported.name().as_str() == "ephemeral"
                        {
                            ephemeral_names.push(named.local.name.to_string());
                        }
                        if import.source.value.as_str() == Some(SYNC) {
                            match named.imported.name().as_str() {
                                "presence" => presence_names.push(named.local.name.to_string()),
                                "peers" => peers_names.push(named.local.name.to_string()),
                                _ => {}
                            }
                        }
                        if import.source.value.as_str() == Some(RUNTIME)
                            && named.imported.name().as_str() == "hydrated"
                        {
                            hydrated_names.push(named.local.name.to_string());
                        }
                        if import.source.value.as_str() == Some(RUNTIME)
                            && named.imported.name().as_str() == "from"
                        {
                            from_names.push(named.local.name.to_string());
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
                let names = import
                    .specifiers
                    .iter()
                    .flatten()
                    .map(|specifier| ImportName {
                        local: specifier.name().to_string(),
                        text: source
                            [specifier.span().start as usize..specifier.span().end as usize]
                            .to_owned(),
                        kind: match specifier {
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => {
                                ImportKind::Default
                            }
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                                ImportKind::Namespace
                            }
                            ImportDeclarationSpecifier::ImportSpecifier(_) => ImportKind::Named,
                        },
                    })
                    .collect();
                script.imports.push(Import {
                    text: source[range.clone()].to_owned(),
                    specifier,
                    specifier_range,
                    names,
                });
                import_ranges.push(range);
                import_locals.push(
                    import
                        .specifiers
                        .iter()
                        .flatten()
                        .map(|specifier| specifier.name().to_string())
                        .collect::<Vec<_>>(),
                );
            }
            Statement::ExportDeclaration(export) if server_function(export).is_some() => {
                let function = server_function(export).expect("checked by the guard");
                let name = function
                    .id
                    .as_ref()
                    .map(|id| id.name.to_string())
                    .unwrap_or_default();
                if script
                    .server_exports
                    .iter()
                    .any(|existing: &ServerExport| existing.name == name)
                {
                    return Err(Diagnostic::new(
                        at(function.span.start),
                        format!("`{name}` is exported twice"),
                    ));
                }
                let mut references = References::default();
                references.visit_function(function, oxc_syntax::scope::ScopeFlags::empty());
                server_references.extend(references.names);
                let range = export.span.start as usize..export.span.end as usize;
                script.server_exports.push(ServerExport {
                    name,
                    text: source[function.span.start as usize..function.span.end as usize]
                        .to_owned(),
                    offset: range.start,
                    span: at(function.span.start),
                });
                server_ranges.push(range);
            }
            Statement::ExportNamedDeclaration(_)
            | Statement::ExportDeclaration(_)
            | Statement::ExportAllDeclaration(_)
            | Statement::ExportFromDeclaration(_) => {
                return Err(Diagnostic::new(
                    at(statement.span().start),
                    "a component script can't export; declare a prop on the host tag instead, or move shared code to a module and import it",
                )
                .with_help("only a function marked 'use server' can be exported: `export async function save(formData) { 'use server'; … }`"));
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
    // Imports the server functions use go to the server module; an import that nothing else in
    // the script uses leaves the browser module (`import { db } from './db.js'` must not ship).
    if !script.server_exports.is_empty() {
        let mut elsewhere = References::default();
        for statement in &parsed.program.body {
            let range = statement.span().start as usize..statement.span().end as usize;
            if !matches!(statement, Statement::ImportDeclaration(_))
                && !server_ranges.contains(&range)
            {
                elsewhere.visit_statement(statement);
            }
        }
        let mut kept = Vec::new();
        for (import, local_names) in std::mem::take(&mut script.imports)
            .into_iter()
            .zip(import_locals)
        {
            let for_server = local_names
                .iter()
                .any(|name| server_references.contains(name));
            let for_browser = !for_server
                || local_names
                    .iter()
                    .any(|name| elsewhere.names.contains(name));
            if for_server && !crate::components::is_component(&import.specifier) {
                script.server_imports.push(import.text.clone());
            }
            if for_browser {
                kept.push(import);
            } else {
                script
                    .runtime_names
                    .retain(|name| !local_names.contains(name));
                // Its types stay out of the browser's typings too.
                let quoted = [
                    format!("'{}'", import.specifier),
                    format!("\"{}\"", import.specifier),
                ];
                script
                    .type_imports
                    .retain(|text| !quoted.iter().any(|quoted| text.contains(quoted.as_str())));
            }
        }
        script.imports = kept;
    }
    // The body without its imports. Removed imports become blank space of the same shape, so
    // line numbers in the emitted setup function still match the source. Server functions are
    // blanked the same way.
    let mut body = source.to_owned();
    for range in import_ranges.iter().chain(server_ranges.iter()) {
        let blank: String = source[range.clone()]
            .chars()
            .map(|character| if character == '\n' { '\n' } else { ' ' })
            .collect();
        body.replace_range(range.clone(), &blank);
    }
    script.body = body;
    script.hydrated = hydrated_names.clone();
    // `hydrated()` is false until the element starts, so on the server it's `false`.
    for (index, text) in calls.clone() {
        let call = text.split_whitespace().collect::<String>();
        if hydrated_names
            .iter()
            .any(|name| call == format!("{name}()"))
        {
            script.bindings[index].init = Some(expression::Expression::Boolean(false));
        }
    }
    // `let editing = ephemeral(false)` is state that isn't stored; on the server it's its value.
    for (index, callee, argument, _, _) in &linked {
        if ephemeral_names.contains(callee) {
            script.bindings[*index].init = expression::parse(argument).ok();
            script.ephemeral.push(script.bindings[*index].name.clone());
        }
        // `let cursor = presence(v)`: shared live, not stored; on the server it's `v`.
        if presence_names.contains(callee) {
            script.bindings[*index].init = expression::parse(argument).ok();
            script.presence.push(script.bindings[*index].name.clone());
        }
    }
    // `let others = peers()`: nobody else is there on the server.
    for (index, text) in &calls {
        let Some(callee) = text.strip_suffix("()") else {
            continue;
        };
        if !peers_names.iter().any(|name| name == callee.trim()) {
            continue;
        }
        let binding = &mut script.bindings[*index];
        if script.peers.is_some() {
            return Err(Diagnostic::new(
                binding.span,
                "`peers()` once per component is enough",
            ));
        }
        binding.init = expression::parse("[]").ok();
        script.peers = Some(binding.name.clone());
    }
    // `let x = from(prop)` starts as `prop`, so on the server it's the argument's value.
    for (index, callee, argument, mutable, offset) in linked {
        if !from_names.contains(&callee) {
            continue;
        }
        if !mutable {
            return Err(Diagnostic::new(
                at(offset),
                format!("`{callee}()` makes state that follows a prop until it's assigned; declare it with `let`"),
            )
            .with_help(format!(
                "a `const` that reads the prop already follows it: `const {} = {argument}`",
                script.bindings[index].name
            )));
        }
        script.bindings[index].init = expression::parse(&argument).ok();
        script.bindings[index].source = Some(argument);
    }
    script.from = from_names;
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
pub const RUNTIME: &str = "@zubra/runtime";
/// The package that keeps `'use collection'` components' state.
pub const SYNC: &str = "@zubra/sync";

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
            error.with_help(format!("use `{fixed}`: a lowercase name is what `on{fixed}` attributes, Vue's `@{fixed}`, Angular's `({fixed})` and React 19 can all listen for; `valueChange`-style names reach only JavaScript listeners"))
        } else {
            error.with_help("lowercase names are what HTML `on…` attributes and every framework's template syntax can listen for")
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

/// What to say about a directive Zubra doesn't know: what it probably meant, or why it isn't
/// needed, and the two it does know.
fn unknown_directive(text: &str, span: Span) -> Diagnostic {
    const KNOWN: &str = "Zubra knows two directives: 'use collection <name>' first in a script, to keep its state on the device (@zubra/sync), and 'use server' first in an exported function, to run it on the server (@zubra/actions)";
    let word = text
        .strip_prefix("use ")
        .unwrap_or(text)
        .split_whitespace()
        .next()
        .unwrap_or_default();
    const SERVER: &str = "'use server' goes first in an exported function's body, not the script: `export async function save(formData) { 'use server'; … }`";
    let rest: Vec<&str> = text.split_whitespace().skip(2).collect();
    let help = match word {
        "server" => SERVER.to_owned(),
        "client" => format!("a Zubra component already runs in the browser, so 'use client' isn't needed: remove it. {KNOWN}"),
        _ if close_to(word, "collection") => {
            let name = if rest.is_empty() { "<name>".to_owned() } else { rest.join(" ") };
            format!("did you mean 'use collection {name}'?")
        }
        _ if close_to(word, "server") => format!("did you mean 'use server'? {SERVER}"),
        _ => KNOWN.to_owned(),
    };
    Diagnostic::new(span, format!("unknown directive '{text}'")).with_help(help)
}

/// A typo away (at most two edits, for words of four letters or more).
fn close_to(word: &str, known: &str) -> bool {
    if word.len() < 4 || word == known {
        return false;
    }
    let (a, b): (Vec<char>, Vec<char>) = (word.chars().collect(), known.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let here = row[j + 1];
            row[j + 1] = (previous + usize::from(ca != cb))
                .min(row[j] + 1)
                .min(here + 1);
            previous = here;
        }
    }
    row[b.len()] <= 2
}

/// The script's own directives: `'use collection <name>'` (keyed by the `doc` prop, or by the props
/// after `by`: `'use collection tasks by list, item'`). Any
/// other `'use …'` is a mistake worth naming, not something to ignore: it comes back as a warning
/// (an error from 6.0; in 5.2 it was ignored, so it still compiles).
#[allow(clippy::type_complexity)]
fn directive(
    directives: &[oxc_ast::ast::Directive<'_>],
    at: &dyn Fn(u32) -> Span,
) -> Result<(Option<crate::ast::Collection>, Vec<Diagnostic>), Diagnostic> {
    let mut found = None;
    let mut unknown = Vec::new();
    for directive in directives {
        let text = directive.directive.as_str().trim();
        let span = at(directive.span.start);
        if text == "use strict" {
            continue;
        }
        let Some(rest) = text.strip_prefix("use collection") else {
            unknown.push(unknown_directive(text, span));
            continue;
        };
        if found.is_some() {
            return Err(Diagnostic::new(
                span,
                "a component belongs to one collection",
            ));
        }
        let (name, keys) = match rest.trim().split_once(" by ") {
            Some((name, keys)) => (
                name.trim(),
                keys.split(',')
                    .map(|key| key.trim().to_owned())
                    .collect::<Vec<_>>(),
            ),
            None => (rest.trim(), vec!["doc".to_owned()]),
        };
        let identifier = |word: &str| {
            !word.is_empty()
                && word.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && word
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        };
        if !identifier(name) || name.contains(char::is_whitespace) {
            return Err(Diagnostic::new(
                span,
                "name the collection: 'use collection tasks' (letters, digits, - and _)",
            ));
        }
        if keys.iter().any(|key| !identifier(key) || key.contains('-')) {
            return Err(Diagnostic::new(
                span,
                "`by` lists the props that key a document: 'use collection tasks by projectId, id'",
            ));
        }
        found = Some(crate::ast::Collection {
            name: name.to_owned(),
            keys,
            span,
        });
    }
    Ok((found, unknown))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_build_time_bindings_and_runtime_names() {
        let script = parse(
            "import { state } from '@zubra/runtime'\nconst title = \"Mikey\"\nlet count = 1 + 2\nconst now = Date.now()\nconst { a, b } = thing\nfunction inc() { emit('valuechange', 1) }\nclass Thing {}\nconsole.log(title)",
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
            "import { state } from '@zubra/runtime'"
        );
        assert_eq!(script.imports[0].specifier, "@zubra/runtime");
        assert_eq!(
            &script.imports[0].text[script.imports[0].specifier_range.clone()],
            "'@zubra/runtime'"
        );
        assert!(script.body.starts_with(&format!(
            "{}\nconst title",
            " ".repeat("import { state } from '@zubra/runtime'".len())
        )));
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

/// The function an `export` declares, when it's marked `'use server'`.
pub(crate) fn server_function<'a>(
    export: &'a oxc_ast::ast::ExportDeclaration<'a>,
) -> Option<&'a oxc_ast::ast::Function<'a>> {
    let oxc_ast::ast::Declaration::FunctionDeclaration(function) = &export.declaration else {
        return None;
    };
    let body = function.body.as_ref()?;
    body.directives
        .iter()
        .any(|directive| directive.directive.as_str() == "use server")
        .then_some(&**function)
}

/// Every identifier a piece of the script reads.
#[derive(Default)]
struct References {
    names: std::collections::HashSet<String>,
}

impl<'a> Visit<'a> for References {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        self.names.insert(identifier.name.to_string());
    }
}
