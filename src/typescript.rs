//! `<script lang="ts">`: TypeScript, reduced to JavaScript by blanking out its types.
//!
//! Type annotations, type-only declarations and imports, `as`/`satisfies`/`!` and type
//! arguments are replaced by spaces of the same length (newlines kept), so the JavaScript that
//! remains has every token at its original line and column, and diagnostics still point into the
//! TypeScript source. This is the "erasable syntax only" subset that Node's type stripping and
//! TypeScript's `erasableSyntaxOnly` accept; syntax that would need code generated for it (`enum`,
//! `namespace`, parameter properties, `<T>x` assertions, `import x = require()`) is an error that
//! says what to write instead.
//!
//! The types aren't thrown away: annotated `const`/`let` bindings keep their type text (a prop
//! whose default is such a binding is declared with that type), and `emit<T>("name", …)` gives
//! the event's `detail` type.

use std::collections::HashMap;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    CallExpression, Class, ClassElement, Declaration, Expression, FormalParameter, Function,
    FunctionType, ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind,
    MethodDefinitionType, PropertyDefinitionType, Statement, TSAsExpression, TSEnumDeclaration,
    TSExternalModuleDeclaration, TSGlobalDeclaration, TSInterfaceDeclaration,
    TSNamespaceDeclaration, TSNonNullExpression, TSSatisfiesExpression, TSTypeAliasDeclaration,
    TSTypeAnnotation, TSTypeAssertion, TSTypeParameterDeclaration, TSTypeParameterInstantiation,
    VariableDeclaration, VariableDeclarator,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span as Range};

use crate::{
    diagnostic::{Diagnostic, Span},
    scanner::span_after,
};

/// What the types said, kept for the interface.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Types {
    /// `const title: string = …` → `title` → `string`.
    pub bindings: HashMap<String, String>,
    /// `emit<Detail>(…)`: the call's start offset → `Detail`.
    pub emits: HashMap<u32, String>,
    /// `declare const value: number | null`: a prop's type, by name, with where it's declared.
    pub props: Vec<(String, String, u32)>,
    /// For the typings: the script's `type` and `interface` declarations, exported, and its
    /// imports as `import type`, so the types the interface mentions resolve.
    pub declarations: Vec<String>,
    pub imports: Vec<String>,
    /// Imported names the script uses only as types (one type reference or more, no value
    /// reference). TypeScript drops these imports; the compiler drops them too once it knows the
    /// template doesn't read them (see `script::elide_type_only_imports`), since otherwise the
    /// browser would import a name the module doesn't export at runtime.
    pub type_only: Vec<String>,
}

/// Strip the types from `source` (a `<script lang="ts">` body starting at `start`).
pub fn strip(source: &str, start: Span) -> Result<(String, Types), Diagnostic> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::ts()).parse();
    let at = |offset: u32| span_after(start, source, offset as usize);
    if let Some(error) = parsed.diagnostics.first() {
        let offset = error.labels.first().map_or(0, |label| label.offset());
        return Err(Diagnostic::new(
            at(offset),
            format!("invalid <script lang=\"ts\">: {}", error.message),
        ));
    }
    let mut stripper = Stripper {
        source,
        blanks: Vec::new(),
        types: Types::default(),
        error: None,
    };
    stripper.visit_program(&parsed.program);
    stripper.types.type_only = type_only_imports(&parsed.program);
    if let Some((offset, message, help)) = stripper.error {
        // Types are removed, never compiled (the "erasable syntax only" rule); each refusal says
        // what to write and where the rule is explained.
        let error = Diagnostic::new(at(offset), message);
        return Err(match help {
            Some(help) => error.with_help(format!("{help}; see docs/typescript.md")),
            None => error.with_help("see docs/typescript.md"),
        });
    }
    let mut bytes = source.as_bytes().to_vec();
    for range in &stripper.blanks {
        for byte in &mut bytes[range.start as usize..range.end as usize] {
            // Spaces for everything but line breaks, so lines and columns stay where they were.
            // (Whole UTF-8 sequences are covered, since ranges are token boundaries.)
            if *byte != b'\n' && *byte != b'\r' {
                *byte = b' ';
            }
        }
    }
    let stripped =
        String::from_utf8(bytes).expect("blanking ASCII-bounded ranges keeps UTF-8 valid");
    // What's left must be JavaScript; if it isn't, this is a construct the stripper missed.
    let check = Allocator::default();
    if let Some(error) = Parser::new(&check, &stripped, SourceType::mjs())
        .parse()
        .diagnostics
        .first()
    {
        let offset = error.labels.first().map_or(0, |label| label.offset());
        return Err(Diagnostic::new(
            at(offset),
            format!("this TypeScript can't be reduced to JavaScript by removing its types: {}", error.message),
        )
        .with_help("use only erasable TypeScript syntax (as with Node's type stripping or `erasableSyntaxOnly`); docs/typescript.md has the rule"));
    }
    Ok((stripped, stripper.types))
}

/// Imported bindings referenced only in type positions (`x: Option`, `typeof thing` in a type),
/// with at least one such reference. An import with no references at all is kept: the template
/// may read it, and if not, it's what TypeScript keeps under `verbatimModuleSyntax` anyway.
pub(crate) fn type_only_imports(program: &oxc_ast::ast::Program<'_>) -> Vec<String> {
    let semantic = oxc_semantic::SemanticBuilder::new().build(program).semantic;
    let scoping = semantic.scoping();
    let mut names = Vec::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind.is_type() {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier {
                if named.import_kind.is_type() {
                    continue;
                }
            }
            let local = specifier.local();
            let Some(symbol) = local.symbol_id.get() else {
                continue;
            };
            let references = scoping.get_resolved_references(symbol).collect::<Vec<_>>();
            // (`typeof thing` in a type is flagged as a type reference, not a read.)
            let value = references
                .iter()
                .any(|reference| reference.flags().is_value());
            if !references.is_empty() && !value {
                names.push(local.name.to_string());
            }
        }
    }
    names
}

/// The type syntax in a TSX file (`as T`, annotations, type arguments): ranges to blank. For a
/// JSX component's template expressions, which are copied into the template and must be
/// JavaScript. (Errors are left to the script's own stripping.)
pub fn type_ranges_tsx(source: &str) -> Vec<std::ops::Range<usize>> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
    if !parsed.diagnostics.is_empty() {
        return Vec::new();
    }
    let mut stripper = Stripper {
        source,
        blanks: Vec::new(),
        types: Types::default(),
        error: None,
    };
    stripper.visit_program(&parsed.program);
    stripper
        .blanks
        .iter()
        .map(|range| range.start as usize..range.end as usize)
        .collect()
}

struct Stripper<'s> {
    source: &'s str,
    blanks: Vec<Range>,
    types: Types,
    error: Option<(u32, String, Option<String>)>,
}

impl Stripper<'_> {
    fn blank(&mut self, range: Range) {
        if range.start < range.end {
            self.blanks.push(range);
        }
    }

    fn fail(&mut self, offset: u32, message: impl Into<String>, help: Option<&str>) {
        if self.error.is_none() {
            self.error = Some((offset, message.into(), help.map(str::to_owned)));
        }
    }

    fn text(&self, range: Range) -> &str {
        &self.source[range.start as usize..range.end as usize]
    }

    /// Blank `?` (optional) or `!` (definite) between `from` and `to`, if that's all there is.
    fn blank_marker(&mut self, from: u32, to: u32) {
        let between = &self.source[from as usize..to as usize];
        if let Some(index) = between.find(['?', '!']) {
            if between.trim() == "?" || between.trim() == "!" {
                let offset = from + u32::try_from(index).expect("script fits in u32");
                self.blank(Range::new(offset, offset + 1));
            }
        }
    }

    /// Blank TypeScript-only modifier keywords in `range` (before a class member's name).
    fn blank_modifiers(&mut self, range: Range) {
        let text = self.text(range).to_owned();
        let mut offset = 0;
        for word in text.split_inclusive(|character: char| character.is_whitespace()) {
            let keyword = word.trim_end();
            if matches!(
                keyword,
                "public" | "private" | "protected" | "readonly" | "override"
            ) {
                let start = range.start + u32::try_from(offset).expect("script fits in u32");
                self.blank(Range::new(
                    start,
                    start + u32::try_from(keyword.len()).expect("fits"),
                ));
            }
            offset += word.len();
        }
    }

    /// The end of the comma after `end`, if the next non-space character is one.
    fn following_comma(&self, end: u32) -> Option<u32> {
        let rest = &self.source[end as usize..];
        let skipped = rest.len() - rest.trim_start().len();
        rest.trim_start()
            .starts_with(',')
            .then(|| end + u32::try_from(skipped + 1).expect("fits"))
    }
}

impl<'a> Visit<'a> for Stripper<'_> {
    fn visit_ts_type_annotation(&mut self, it: &TSTypeAnnotation<'a>) {
        self.blank(it.span);
    }

    fn visit_ts_type_parameter_declaration(&mut self, it: &TSTypeParameterDeclaration<'a>) {
        self.blank(it.span);
    }

    fn visit_ts_type_parameter_instantiation(&mut self, it: &TSTypeParameterInstantiation<'a>) {
        self.blank(it.span);
    }

    fn visit_ts_type_alias_declaration(&mut self, it: &TSTypeAliasDeclaration<'a>) {
        let text = format!(
            "export {}",
            self.text(it.span)
                .trim_start_matches("declare ")
                .trim_end_matches(';')
        );
        self.types.declarations.push(text);
        self.blank(it.span);
    }

    fn visit_ts_interface_declaration(&mut self, it: &TSInterfaceDeclaration<'a>) {
        let text = format!(
            "export {}",
            self.text(it.span).trim_start_matches("declare ")
        );
        self.types.declarations.push(text);
        self.blank(it.span);
    }

    fn visit_ts_as_expression(&mut self, it: &TSAsExpression<'a>) {
        self.visit_expression(&it.expression);
        self.blank(Range::new(it.expression.span().end, it.span.end));
    }

    fn visit_ts_satisfies_expression(&mut self, it: &TSSatisfiesExpression<'a>) {
        self.visit_expression(&it.expression);
        self.blank(Range::new(it.expression.span().end, it.span.end));
    }

    fn visit_ts_non_null_expression(&mut self, it: &TSNonNullExpression<'a>) {
        self.visit_expression(&it.expression);
        self.blank(Range::new(it.expression.span().end, it.span.end));
    }

    fn visit_ts_type_assertion(&mut self, it: &TSTypeAssertion<'a>) {
        self.fail(
            it.span.start,
            "`<T>value` type assertions aren't supported",
            Some("write `value as T`"),
        );
    }

    fn visit_ts_enum_declaration(&mut self, it: &TSEnumDeclaration<'a>) {
        self.fail(
            it.span.start,
            "`enum` needs code generated for it, so it isn't supported in a component script",
            Some(
                "use a `const` object (`const Color = { Red: \"red\" } as const`) and a union type",
            ),
        );
    }

    fn visit_ts_namespace_declaration(&mut self, it: &TSNamespaceDeclaration<'a>) {
        if it.declare {
            self.blank(it.span);
        } else {
            self.fail(
                it.span.start,
                "`namespace` isn't supported in a component script",
                Some("use an object or a module"),
            );
        }
    }

    fn visit_ts_global_declaration(&mut self, it: &TSGlobalDeclaration<'a>) {
        self.blank(it.span);
    }

    fn visit_ts_external_module_declaration(&mut self, it: &TSExternalModuleDeclaration<'a>) {
        self.blank(it.span);
    }

    fn visit_statement(&mut self, it: &Statement<'a>) {
        match it {
            Statement::TSImportEqualsDeclaration(declaration) => {
                return self.fail(
                    declaration.span.start,
                    "`import x = require(…)` isn't supported",
                    Some("use `import x from \"…\"`"),
                );
            }
            // `export type T = …` and `export interface I { … }` are type-only, so they're
            // erasable: the declaration goes to the typings (exported, as every declaration is)
            // and the whole statement, `export` included, is blanked. (A component script
            // exports no values; that check runs on the JavaScript left after stripping.)
            Statement::ExportDeclaration(export)
                if matches!(
                    export.declaration,
                    Declaration::TSTypeAliasDeclaration(_) | Declaration::TSInterfaceDeclaration(_)
                ) =>
            {
                walk::walk_declaration(self, &export.declaration);
                self.blank(export.span);
                return;
            }
            // `export type { A, B }`: re-exported names, kept for the typings.
            Statement::ExportNamedDeclaration(export)
                if export.export_kind == ImportOrExportKind::Type =>
            {
                self.types
                    .declarations
                    .push(self.text(export.span).trim_end_matches(';').to_owned());
                self.blank(export.span);
                return;
            }
            _ => {}
        }
        walk::walk_statement(self, it);
    }

    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        // The same bindings as `import type`, for the typings (a type-only import can't have a
        // default and named bindings at once, so those are split).
        let from = self.text(it.source.span).to_owned();
        let mut named = Vec::new();
        for specifier in it.specifiers.iter().flatten() {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                    let imported = self.text(specifier.imported.span()).to_owned();
                    let local = specifier.local.name.to_string();
                    named.push(if imported == local {
                        local
                    } else {
                        format!("{imported} as {local}")
                    });
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    self.types
                        .imports
                        .push(format!("import type {} from {from};", default.local.name));
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    self.types.imports.push(format!(
                        "import type * as {} from {from};",
                        namespace.local.name
                    ));
                }
            }
        }
        if !named.is_empty() {
            self.types.imports.push(format!(
                "import type {{ {} }} from {from};",
                named.join(", ")
            ));
        }
        if it.import_kind.is_type() {
            return self.blank(it.span);
        }
        for specifier in it.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier {
                if named.import_kind.is_type() {
                    let end = self
                        .following_comma(named.span.end)
                        .unwrap_or(named.span.end);
                    self.blank(Range::new(named.span.start, end));
                }
            }
        }
    }

    fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
        if it.declare {
            // `declare const value: T` types the prop `value` (it declares nothing at runtime).
            for declarator in &it.declarations {
                if let (Some(name), Some(annotation)) = (
                    declarator.id.get_binding_identifier(),
                    &declarator.type_annotation,
                ) {
                    let text = self.text(annotation.type_annotation.span()).to_owned();
                    self.types
                        .props
                        .push((name.name.to_string(), text, declarator.span.start));
                }
            }
            return self.blank(it.span);
        }
        walk::walk_variable_declaration(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let Some(annotation) = &it.type_annotation {
            if let Some(name) = it.id.get_binding_identifier() {
                let text = self.text(annotation.type_annotation.span()).to_owned();
                self.types.bindings.insert(name.name.to_string(), text);
            }
            if it.definite {
                self.blank_marker(it.id.span().end, annotation.span.start);
            }
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_function(&mut self, it: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        // Overload signatures and `declare function`: no body, nothing at runtime.
        if it.declare || it.body.is_none() || it.r#type == FunctionType::TSDeclareFunction {
            return self.blank(it.span);
        }
        if let Some(this) = &it.this_param {
            return self.fail(
                this.span.start,
                "a `this` parameter isn't supported",
                Some("remove it, or pass the value as a normal parameter"),
            );
        }
        walk::walk_function(self, it, flags);
    }

    fn visit_formal_parameter(&mut self, it: &FormalParameter<'a>) {
        if it.accessibility.is_some() || it.readonly || it.r#override {
            return self.fail(
                it.span.start,
                "parameter properties (`constructor(private x)`) need code generated for them",
                Some("declare the field and assign it in the constructor"),
            );
        }
        if it.optional {
            let to = it
                .type_annotation
                .as_ref()
                .map_or(it.span.end, |annotation| annotation.span.start);
            self.blank_marker(it.pattern.span().end, to);
        }
        walk::walk_formal_parameter(self, it);
    }

    fn visit_class(&mut self, it: &Class<'a>) {
        if it.declare {
            return self.blank(it.span);
        }
        if it.r#abstract {
            // `abstract class` → `class`: blank the keyword.
            let text = self.text(it.span).to_owned();
            if let Some(index) = text.find("abstract") {
                let start = it.span.start + u32::try_from(index).expect("fits");
                self.blank(Range::new(start, start + 8));
            }
        }
        if let (Some(first), Some(last)) = (it.implements.first(), it.implements.last()) {
            // `implements A, B`: from the keyword to the last interface.
            let before = &self.source[..first.span.start as usize];
            if let Some(index) = before.rfind("implements") {
                self.blank(Range::new(
                    u32::try_from(index).expect("fits"),
                    last.span.end,
                ));
            }
        }
        walk::walk_class(self, it);
    }

    fn visit_class_element(&mut self, it: &ClassElement<'a>) {
        match it {
            ClassElement::PropertyDefinition(property) => {
                if property.declare
                    || property.r#type == PropertyDefinitionType::TSAbstractPropertyDefinition
                {
                    return self.blank(property.span);
                }
                self.blank_modifiers(Range::new(property.span.start, property.key.span().start));
                if property.optional || property.definite {
                    let to = property
                        .type_annotation
                        .as_ref()
                        .map_or(property.span.end, |annotation| annotation.span.start);
                    self.blank_marker(property.key.span().end, to);
                }
            }
            ClassElement::MethodDefinition(method) => {
                if method.r#type == MethodDefinitionType::TSAbstractMethodDefinition
                    || method.value.body.is_none()
                {
                    return self.blank(method.span);
                }
                self.blank_modifiers(Range::new(method.span.start, method.key.span().start));
            }
            ClassElement::TSIndexSignature(signature) => return self.blank(signature.span),
            ClassElement::AccessorProperty(accessor) => {
                self.blank_modifiers(Range::new(accessor.span.start, accessor.key.span().start));
            }
            ClassElement::StaticBlock(_) => {}
        }
        walk::walk_class_element(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let (Expression::Identifier(_), Some(arguments)) = (&it.callee, &it.type_arguments) {
            if let Some(first) = arguments.params.first() {
                let text = self.text(first.span()).to_owned();
                self.types.emits.insert(it.span.start, text);
            }
        }
        walk::walk_call_expression(self, it);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripped(source: &str) -> String {
        strip(source, Span::new(1, 1)).unwrap().0
    }

    /// Every token outside the types stays at its byte offset.
    fn same_shape(source: &str) {
        let out = stripped(source);
        assert_eq!(out.len(), source.len());
        assert_eq!(out.matches('\n').count(), source.matches('\n').count());
    }

    #[test]
    fn removes_erasable_types_in_place() {
        let cases = [
            ("const a: number = 1", "const a         = 1"),
            ("let b: string[] = []", "let b           = []"),
            (
                "function f(x: number, y?: string): void {}",
                "function f(x        , y         )       {}",
            ),
            (
                "const g = <T,>(x: T): T => x",
                "const g =     (x   )    => x",
            ),
            (
                "const h = value as unknown as string",
                "const h = value                     ",
            ),
            (
                "const i = config satisfies Config",
                "const i = config                 ",
            ),
            ("const j = maybe!.name", "const j = maybe .name"),
            (
                "type Id = string\nconst k = 1",
                "                \nconst k = 1",
            ),
            (
                "interface P { a: number }\nconst l = 1",
                "                         \nconst l = 1",
            ),
            (
                "import type { A } from './a'\nconst m = 1",
                "                            \nconst m = 1",
            ),
            (
                "import { type A, state } from '@zubra/runtime'",
                "import {         state } from '@zubra/runtime'",
            ),
            (
                "import { state, type A } from '@zubra/runtime'",
                "import { state,        } from '@zubra/runtime'",
            ),
            ("const n = state<number>(0)", "const n = state        (0)"),
            (
                "declare const o: string\nconst p = 1",
                "                       \nconst p = 1",
            ),
            (
                "function q(a: string): void\nfunction q(a: unknown) {}",
                "                           \nfunction q(a         ) {}",
            ),
            ("let r!: number", "let r         "),
        ];
        for (source, expected) in cases {
            assert_eq!(stripped(source), expected, "{source}");
        }
    }

    #[test]
    fn classes_lose_their_type_only_parts() {
        let source = "abstract class A<T> implements B, C {\n  private readonly x: number = 1\n  declare y: string\n  z?: T\n  public static make(): A<number> { return null! }\n  abstract go(): void\n  [key: string]: unknown\n}";
        let out = stripped(source);
        same_shape(source);
        assert_eq!(
            out.split('\n').map(str::trim_end).collect::<Vec<_>>(),
            [
                "         class A                    {",
                "                   x         = 1",
                "",
                "  z",
                "         static make()            { return null  }",
                "",
                "",
                "}"
            ]
        );
    }

    #[test]
    fn multi_line_types_keep_their_line_breaks() {
        let source = "interface Picked {\n  option: string\n  index: number\n}\ntype Pair =\n  | [number, number]\n  | null\nenum E { A }";
        same_shape(&format!(
            "{}\nconst after = 1",
            &source[..source.find("enum").unwrap()]
        ));
        let error = strip(source, Span::new(1, 1)).unwrap_err();
        assert_eq!(error.span.line, 8, "the enum is still on line 8");
    }

    #[test]
    fn keeps_the_types_for_the_interface() {
        let (_, types) = strip("const title: string = 'x'\nconst data: { a: number } = { a: 1 }\nemit<Detail>('pick', v)", Span::new(1, 1)).unwrap();
        assert_eq!(
            types.bindings.get("title").map(String::as_str),
            Some("string")
        );
        assert_eq!(
            types.bindings.get("data").map(String::as_str),
            Some("{ a: number }")
        );
        assert_eq!(types.emits.values().collect::<Vec<_>>(), ["Detail"]);
    }

    #[test]
    fn rejects_syntax_that_needs_code_generated() {
        for (source, expected, line) in [
            ("const a = 1\nenum Color { Red }", "`enum`", 3),
            ("namespace N { export const x = 1 }", "`namespace`", 2),
            (
                "class A { constructor(private x: number) {} }",
                "parameter properties",
                2,
            ),
            ("const v = <string>thing", "type assertions", 2),
            ("import fs = require('fs')", "require", 2),
            ("function f(this: Window) {}", "`this` parameter", 2),
        ] {
            let error = strip(source, Span::new(2, 1)).unwrap_err();
            assert!(
                error.message.contains(expected),
                "{source}: {}",
                error.message
            );
            let help = error.help.as_deref().unwrap_or_default();
            assert!(help.ends_with("see docs/typescript.md"), "{source}: {help}");
            assert_eq!(error.span.line, line, "{source}");
        }
        let error = strip("const = 1", Span::new(1, 1)).unwrap_err();
        assert!(error.message.starts_with("invalid <script lang=\"ts\">"));
    }
}
