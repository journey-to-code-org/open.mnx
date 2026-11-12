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

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    AccessorPropertyType, BindingPattern, CallExpression, Class, ClassElement, Declaration,
    ExportDefaultDeclarationKind, Expression, FormalParameter, Function, FunctionType,
    ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind, MethodDefinitionKind,
    MethodDefinitionType, PropertyDefinitionType, Statement, TSAsExpression, TSEnumDeclaration,
    TSExternalModuleDeclaration, TSGlobalDeclaration, TSImportEqualsDeclaration,
    TSInterfaceDeclaration, TSModuleReference, TSNamespaceDeclaration, TSNamespaceDeclarationBody,
    TSNonNullExpression, TSSatisfiesExpression, TSTypeAliasDeclaration, TSTypeAnnotation,
    TSTypeAssertion, TSTypeParameterDeclaration, TSTypeParameterInstantiation, VariableDeclaration,
    VariableDeclarator,
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
    /// The script's enums, in declaration order (a merged enum appears once per declaration).
    pub enums: Vec<crate::enums::EnumInfo>,
    /// Every named or default import, type-only ones included: (local, imported, specifier,
    /// offset). The compiler reads relative TypeScript modules for the enums among them.
    pub imported: Vec<(String, String, String, u32)>,
    /// `verbatimModuleSyntax`: imports stay as written (a type imported without `type` is an
    /// error instead of being dropped).
    pub verbatim: bool,
    /// `interface Props { … }` (or `type Props = { … }`): each member's name and type, and where
    /// the declaration starts. The props, typed in one place.
    pub props_interface: Option<(Vec<(String, String)>, u32)>,
    /// `interface Props extends …` (or `type Props = A & B`): it has members the script doesn't
    /// list, so a host prop it doesn't name is typed `Props["name"]`, for TypeScript to resolve.
    pub props_open: bool,
}

/// Strip the types from `source` (a `<script lang="ts">` body starting at `start`).
pub fn strip(source: &str, start: Span) -> Result<(String, Types), Diagnostic> {
    let options = crate::tsconfig::current();
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
        replacements: Vec::new(),
        types: Types::default(),
        error: None,
        depth: 0,
        seen: Vec::new(),
        value_aliases: HashSet::new(),
        define_fields: options.define_class_fields,
        copies: Vec::new(),
        experimental_decorators: options.experimental_decorators,
        decorator_helpers: HashSet::new(),
        field_wraps: HashMap::new(),
        class_names: HashMap::new(),
        default_exports: HashMap::new(),
        namespace_enums: Vec::new(),
        qualified_enums: Vec::new(),
        namespace_path: Vec::new(),
        constants: HashMap::new(),
    };
    stripper.types.verbatim = options.verbatim_module_syntax;
    collect_constants(&parsed.program.body, &[], &mut stripper.constants);
    if source.contains("namespace") || source.contains("module") || source.contains("import") {
        for (span, text) in crate::namespaces::reference_rewrites(&parsed.program) {
            stripper.replacements.push((span, text));
        }
        stripper.value_aliases = crate::namespaces::value_aliases(&parsed.program);
    }
    stripper.visit_program(&parsed.program);
    // The legacy decorator helpers, TypeScript's own, on the first line (so no line moves).
    let mut helpers = String::new();
    if stripper.decorator_helpers.contains("decorate") {
        helpers.push_str(DECORATE);
    }
    if stripper.decorator_helpers.contains("param") {
        helpers.push_str(PARAM);
    }
    standard_decorators::helpers(&stripper.decorator_helpers, &mut helpers);
    if !helpers.is_empty() {
        stripper.replacements.push((Range::new(0, 0), helpers));
    }
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
    let blanked =
        String::from_utf8(bytes).expect("blanking ASCII-bounded ranges keeps UTF-8 valid");
    // Generated code (enums) goes in last. It keeps the lines but not the byte offsets, so the
    // offsets recorded in `types` move with it.
    // Moved text, now that its types are blanked: with the rewrites inside it, on one line, so
    // the lines it leaves and the lines it joins keep their count (see `moved.rs`).
    let copies = std::mem::take(&mut stripper.copies);
    let mut moved = Vec::with_capacity(copies.len());
    {
        let edits = moved::Edits {
            blanked: &blanked,
            blanks: &stripper.blanks,
            replacements: &stripper.replacements,
            copies: &copies,
        };
        for (index, (offset_at, ..)) in copies.iter().enumerate() {
            match edits.copy_text(index) {
                Ok(text) => moved.push((Range::new(*offset_at, *offset_at), text)),
                Err((offset, message)) => {
                    return Err(Diagnostic::new(at(offset), message)
                        .with_help("write it on one line; see docs/typescript.md"));
                }
            }
        }
    }
    stripper.replacements.extend(moved);
    // Computed enum members' code, now that it's known (see `enums::placeholder`).
    let filled: Vec<Option<String>> = {
        let edits = moved::Edits {
            blanked: &blanked,
            blanks: &stripper.blanks,
            replacements: &stripper.replacements,
            copies: &[],
        };
        let mut filled = Vec::new();
        for (_, text) in &stripper.replacements {
            if !text.contains('\u{E000}') {
                filled.push(None);
                continue;
            }
            let mut out = String::new();
            let mut rest = text.as_str();
            while let Some(open) = rest.find('\u{E000}') {
                out.push_str(&rest[..open]);
                let after = &rest[open + '\u{E000}'.len_utf8()..];
                let close = after.find('\u{E001}').expect("a placeholder closes");
                let (start, end) = after[..close].split_once('-').expect("start-end");
                let range = Range::new(
                    start.parse().expect("an offset"),
                    end.parse().expect("an offset"),
                );
                match edits.code(range) {
                    Ok(code) => out.push_str(&code),
                    Err((offset, message)) => {
                        return Err(Diagnostic::new(at(offset), message)
                            .with_help("write it on one line; see docs/typescript.md"));
                    }
                }
                rest = &after[close + '\u{E001}'.len_utf8()..];
            }
            out.push_str(rest);
            filled.push(Some(out));
        }
        filled
    };
    for ((_, text), filled) in stripper.replacements.iter_mut().zip(filled) {
        if let Some(filled) = filled {
            *text = filled;
        }
    }
    // A rewrite inside removed text (a reference in a type, in a `declare` block) or inside a
    // construct that's generated whole (an enum) has nothing left to change.
    let blanks = std::mem::take(&mut stripper.blanks);
    let whole: Vec<Range> = stripper
        .replacements
        .iter()
        .map(|(range, _)| *range)
        .filter(|range| range.end > range.start)
        .collect();
    stripper.replacements.retain(|(range, _)| {
        // An insertion (an empty range) is inside only strictly; a change, when it's covered.
        let inside = |outer: &Range| {
            if range.start == range.end {
                outer.start < range.start && range.start < outer.end
            } else {
                outer.start <= range.start && range.end <= outer.end && outer != range
            }
        };
        !blanks.iter().any(inside) && !whole.iter().any(inside)
    });
    stripper.blanks = blanks;
    // (An insertion at the start of a removed range goes before it.)
    stripper
        .replacements
        .sort_by_key(|(range, _)| (range.start, range.end));
    let mut stripped = String::with_capacity(blanked.len());
    let mut shifts: Vec<(u32, i64)> = Vec::new();
    let mut at_byte = 0usize;
    let mut shift = 0i64;
    for (range, text) in &stripper.replacements {
        stripped.push_str(&blanked[at_byte..range.start as usize]);
        stripped.push_str(text);
        at_byte = range.end as usize;
        shift += text.len() as i64 - i64::from(range.end - range.start);
        shifts.push((range.end, shift));
    }
    stripped.push_str(&blanked[at_byte..]);
    if !shifts.is_empty() {
        let moved = |offset: u32| -> u32 {
            let shift = shifts
                .iter()
                .take_while(|(end, _)| *end <= offset)
                .last()
                .map_or(0, |(_, shift)| *shift);
            u32::try_from(i64::from(offset) + shift).expect("script fits in u32")
        };
        stripper.types.emits = std::mem::take(&mut stripper.types.emits)
            .into_iter()
            .map(|(offset, text)| (moved(offset), text))
            .collect();
        for prop in &mut stripper.types.props {
            prop.2 = moved(prop.2);
        }
        for import in &mut stripper.types.imported {
            import.3 = moved(import.3);
        }
        if let Some((_, start)) = &mut stripper.types.props_interface {
            *start = moved(*start);
        }
    }
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

/// Generated text, or a copy of the script's own JavaScript.
enum Piece {
    Text(String),
    Copy(Range),
}

/// `a, b, c` from pieces that are each one item (a copy, or a `__param(…)` call of three).
fn join(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut depth = 0;
    for piece in pieces {
        let starts_item = depth == 0;
        if starts_item && !out.is_empty() {
            out.push(Piece::Text(", ".to_owned()));
        }
        if let Piece::Text(text) = &piece {
            if text.starts_with("__zubraParam(") {
                depth = 2;
            } else if depth > 0 {
                depth -= 1;
            }
        } else if depth > 0 {
            depth -= 1;
        }
        out.push(piece);
    }
    out
}

/// TypeScript's `__decorate` helper, for legacy decorators.
const DECORATE: &str = "const __zubraDecorate = function (decorators, target, key, desc) { var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d; if (typeof Reflect === \"object\" && typeof Reflect.decorate === \"function\") r = Reflect.decorate(decorators, target, key, desc); else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r; return c > 3 && r && Object.defineProperty(target, key, r), r; }; ";

/// TypeScript's `__param` helper, for parameter decorators.
const PARAM: &str = "const __zubraParam = function (paramIndex, decorator) { return function (target, key) { decorator(target, key, paramIndex); } }; ";

/// Where a constructor's `super(…);` statement ends.
#[path = "moved.rs"]
mod moved;
#[path = "standard_decorators.rs"]
mod standard_decorators;

/// The `const`s in `statements` (in namespace `path`) whose values are constants, by path.
fn collect_constants(
    statements: &[Statement<'_>],
    path: &[String],
    out: &mut HashMap<String, crate::enums::EnumValue>,
) {
    for statement in statements {
        let declaration = match statement {
            Statement::VariableDeclaration(declaration) => Some(&**declaration),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::VariableDeclaration(declaration) => Some(&**declaration),
                _ => None,
            },
            _ => None,
        };
        if let Some(declaration) = declaration {
            if declaration.kind != oxc_ast::ast::VariableDeclarationKind::Const
                || declaration.declare
            {
                continue;
            }
            for declarator in &declaration.declarations {
                let (BindingPattern::BindingIdentifier(id), Some(init)) =
                    (&declarator.id, &declarator.init)
                else {
                    continue;
                };
                let constants = visible_constants(out, path);
                let scope = crate::enums::Scope {
                    enum_name: "",
                    current: &HashMap::new(),
                    others: &HashMap::new(),
                    constants: &constants,
                };
                if let Some(value) = crate::enums::evaluate(init, &scope) {
                    let mut key = path.join(".");
                    if !key.is_empty() {
                        key.push('.');
                    }
                    key.push_str(&id.name);
                    out.insert(key, value);
                }
            }
            continue;
        }
        let namespace = match statement {
            Statement::TSNamespaceDeclaration(namespace) => &**namespace,
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::TSNamespaceDeclaration(namespace) => &**namespace,
                _ => continue,
            },
            _ => continue,
        };
        let mut inner = path.to_vec();
        let mut current = namespace;
        loop {
            inner.push(current.id.name.to_string());
            match &current.body {
                TSNamespaceDeclarationBody::TSNamespaceDeclaration(next) => current = next,
                TSNamespaceDeclarationBody::TSModuleBlock(block) => {
                    collect_constants(&block.body, &inner, out);
                    break;
                }
            }
        }
    }
}

/// The constants read by name inside namespace `path`: each by its full path, and by its bare
/// name where it's in scope (the innermost namespace's winning).
fn visible_constants(
    constants: &HashMap<String, crate::enums::EnumValue>,
    path: &[String],
) -> HashMap<String, crate::enums::EnumValue> {
    let mut visible = constants.clone();
    for depth in 0..=path.len() {
        let prefix = path[..depth].join(".");
        for (key, value) in constants {
            let bare = if prefix.is_empty() {
                Some(key.as_str())
            } else {
                key.strip_prefix(&prefix)
                    .and_then(|rest| rest.strip_prefix('.'))
            };
            if let Some(bare) = bare.filter(|bare| !bare.contains('.')) {
                visible.insert(bare.to_owned(), value.clone());
            }
        }
    }
    visible
}

/// A decorated field's value, assigned in the constructor: through its decorators'
/// initializers, with their extra initializers right after (`open` value `close`).
fn wrapped_value(wrap: Option<usize>, no_value: bool) -> (String, String) {
    match wrap {
        Some(n) => (
            format!(
                "__zubraRunInitializers(this, _zb_i{n}, {}",
                if no_value { "void 0" } else { "" }
            ),
            format!("); __zubraRunInitializers(this, _zb_e{n})"),
        ),
        None => (String::new(), String::new()),
    }
}

fn super_call_end(body: &oxc_ast::ast::FunctionBody<'_>) -> Option<u32> {
    body.statements
        .iter()
        .find_map(|statement| match statement {
            Statement::ExpressionStatement(expression) => match &expression.expression {
                Expression::CallExpression(call) if matches!(call.callee, Expression::Super(_)) => {
                    Some(expression.span.end)
                }
                _ => None,
            },
            _ => None,
        })
}

/// The names a statement declares in its block (for namespaces merging into them).
pub(crate) fn declared_names(statement: &Statement<'_>) -> Vec<String> {
    let declaration = match statement {
        Statement::ExportDeclaration(export) => &export.declaration,
        other => match other.as_declaration() {
            Some(declaration) => declaration,
            None => return Vec::new(),
        },
    };
    match declaration {
        Declaration::FunctionDeclaration(function) => {
            function.id.iter().map(|id| id.name.to_string()).collect()
        }
        Declaration::ClassDeclaration(class) => {
            class.id.iter().map(|id| id.name.to_string()).collect()
        }
        Declaration::TSEnumDeclaration(declaration) if !declaration.declare => {
            vec![declaration.id.name.to_string()]
        }
        Declaration::TSNamespaceDeclaration(namespace)
            if crate::namespaces::instantiated(namespace) =>
        {
            vec![namespace.id.name.to_string()]
        }
        Declaration::VariableDeclaration(variables) if !variables.declare => variables
            .declarations
            .iter()
            .flat_map(|declarator| declarator.id.get_binding_identifiers())
            .map(|identifier| identifier.name.to_string())
            .collect(),
        _ => Vec::new(),
    }
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
        replacements: Vec::new(),
        types: Types::default(),
        error: None,
        depth: 0,
        seen: Vec::new(),
        value_aliases: HashSet::new(),
        define_fields: true,
        copies: Vec::new(),
        experimental_decorators: false,
        decorator_helpers: HashSet::new(),
        field_wraps: HashMap::new(),
        class_names: HashMap::new(),
        default_exports: HashMap::new(),
        namespace_enums: Vec::new(),
        qualified_enums: Vec::new(),
        namespace_path: Vec::new(),
        constants: HashMap::new(),
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
    /// Code generated in place of a construct (an enum), with the same number of lines.
    replacements: Vec<(Range, String)>,
    types: Types,
    error: Option<(u32, String, Option<String>)>,
    /// Inside a namespace's body (its types and enums aren't the component's).
    depth: usize,
    /// The names each enclosing block has declared so far: a namespace with one of them merges
    /// into it.
    seen: Vec<HashSet<String>>,
    /// `import X = A.B` aliases read as values (by their start): the rest are types only.
    value_aliases: HashSet<u32>,
    /// `useDefineForClassFields` (TypeScript's default for modern targets): a parameter property
    /// is a class field too. Without it, fields are assignments in the constructor.
    define_fields: bool,
    /// Text moved within the script (a field's initializer into the constructor): inserted at the
    /// offset, as `prefix` + the range's JavaScript + `suffix`, once the types are blanked.
    copies: Vec<(u32, String, Range, String)>,
    /// `experimentalDecorators`: `@` means TypeScript's legacy decorators.
    experimental_decorators: bool,
    /// The decorator helpers the lowering used (`decorate` and `param` for legacy decorators,
    /// `esDecorate`, `runInitializers`, `setFunctionName` and `propKey` for standard ones).
    decorator_helpers: HashSet<&'static str>,
    /// A decorated field assigned in the constructor (without `useDefineForClassFields`), by its
    /// start: the number its initializers are kept under.
    field_wraps: HashMap<u32, usize>,
    /// The name an anonymous class gets from where it is (`const X = class {}`), by its start.
    class_names: HashMap<u32, String>,
    /// `export default class A`, by the class's start: the `export default` to take out.
    default_exports: HashMap<u32, Range>,
    /// The enums each enclosing namespace's block has declared so far.
    namespace_enums: Vec<Vec<crate::enums::EnumInfo>>,
    /// Enums declared in namespaces, named by their path (`NS.Inner`).
    qualified_enums: Vec<crate::enums::EnumInfo>,
    /// The enclosing namespaces' names, outermost first.
    namespace_path: Vec<String>,
    /// `const`s with constant values (an enum member can be computed from one), by their path
    /// (`base`, `NS.base`).
    constants: HashMap<String, crate::enums::EnumValue>,
}

impl Stripper<'_> {
    /// An enum (with `export` before it when `exported`): lowered in place, its values kept.
    fn enum_declaration(&mut self, it: &TSEnumDeclaration<'_>, span: Range, exported: bool) {
        if it.declare {
            let info = crate::enums::declared(it, &self.types.enums);
            self.types.declarations.push(info.declaration());
            self.types.enums.push(info);
            return self.blank(span);
        }
        // The enums declared before it in the same block (a namespace's are its own).
        let previous = match self.namespace_enums.last() {
            Some(frame) if self.depth > 0 => frame.clone(),
            _ => self.types.enums.clone(),
        };
        let mut previous = previous;
        previous.extend(self.qualified_enums.iter().cloned());
        let constants = visible_constants(&self.constants, &self.namespace_path);
        match crate::enums::lower(self.source, it, span.start, exported, &previous, &constants) {
            Ok(lowered) => {
                // A computed member's code is the script's own (types stripped, with every
                // rewrite inside it), with its bare member names qualified.
                self.replacements.extend(lowered.edits.iter().cloned());
                for member in &it.body.members {
                    if let Some(initializer) = &member.initializer {
                        if lowered.computed.contains(&initializer.span()) {
                            self.visit_expression(initializer);
                        }
                    }
                }
                if self.depth > 0 {
                    let mut qualified = lowered.info.clone();
                    qualified.name =
                        format!("{}.{}", self.namespace_path.join("."), qualified.name);
                    self.qualified_enums.push(qualified);
                }
                // A namespace's enum is the namespace's, not the component's.
                if self.depth == 0 {
                    self.types.declarations.push(lowered.info.declaration());
                    self.types.enums.push(lowered.info);
                } else if let Some(frame) = self.namespace_enums.last_mut() {
                    frame.push(lowered.info);
                }
                self.replacements.push((span, lowered.text));
            }
            Err((offset, message, help)) => self.fail(offset, message, help.as_deref()),
        }
    }

    /// A namespace (`statement` is its whole statement, `export` included), lowered in place to
    /// TypeScript's function wrapper: `const N = {}; (function (N) {` for its header, `})(N);` for
    /// its closing brace, and each exported member assigned to `N`. `parent` is the namespace
    /// this one is an exported member of.
    fn namespace(
        &mut self,
        it: &TSNamespaceDeclaration<'_>,
        statement: Range,
        parent: Option<&str>,
    ) {
        if it.declare || !crate::namespaces::instantiated(it) {
            // Types only: TypeScript writes nothing for it.
            return self.blank(statement);
        }
        let mut chain = vec![it];
        let block = loop {
            match &chain[chain.len() - 1].body {
                TSNamespaceDeclarationBody::TSNamespaceDeclaration(inner) => chain.push(inner),
                TSNamespaceDeclarationBody::TSModuleBlock(block) => break block,
            }
        };
        let first = it.id.name.as_str();
        // A second declaration of a name in the same block (a namespace, or a class or function
        // it merges into) reuses the first's object.
        let merged = self.seen.last().is_some_and(|names| names.contains(first));
        // Each function's parameter: the namespace's name, unless its block declares that name
        // itself (then `N_1`, as `tsc` renames it).
        let params: Vec<String> = chain
            .iter()
            .enumerate()
            .map(|(index, namespace)| {
                if index + 1 == chain.len() {
                    crate::namespaces::parameter(namespace)
                } else {
                    namespace.id.name.to_string()
                }
            })
            .collect();
        let mut header = String::new();
        for (index, namespace) in chain.iter().enumerate() {
            let name = namespace.id.name.as_str();
            let outer = if index == 0 {
                parent
            } else {
                Some(params[index - 1].as_str())
            };
            match outer {
                _ if index == 0 && merged => header.push(';'),
                Some(outer) => header.push_str(&format!(
                    "const {name} = {outer}.{name} ?? ({outer}.{name} = {{}}); "
                )),
                None => header.push_str(&format!("const {name} = {{}}; ")),
            }
            header.push_str(&format!("(function ({}) {{", params[index]));
        }
        let header_range = Range::new(statement.start, block.span.start + 1);
        header.push_str(&"\n".repeat(self.text(header_range).matches('\n').count()));
        self.replacements.push((header_range, header));
        let footer = chain
            .iter()
            .rev()
            .map(|namespace| format!("}})({});", namespace.id.name))
            .collect::<Vec<_>>()
            .join(" ");
        self.replacements
            .push((Range::new(block.span.end - 1, block.span.end), footer));

        let param = params[params.len() - 1].clone();
        self.depth += 1;
        self.seen.push(HashSet::new());
        self.namespace_enums.push(Vec::new());
        let path_length = self.namespace_path.len();
        self.namespace_path
            .extend(chain.iter().map(|namespace| namespace.id.name.to_string()));
        for member in &block.body {
            self.namespace_member(member, &param);
            let names = declared_names(member);
            if let Some(frame) = self.seen.last_mut() {
                frame.extend(names);
            }
        }
        self.namespace_path.truncate(path_length);
        self.namespace_enums.pop();
        self.seen.pop();
        self.depth -= 1;
    }

    /// One statement in a namespace whose parameter is `param`.
    fn namespace_member(&mut self, statement: &Statement<'_>, param: &str) {
        let Statement::ExportDeclaration(export) = statement else {
            return self.visit_statement(statement);
        };
        let declaration = &export.declaration;
        let keyword = Range::new(export.span.start, declaration.span().start);
        match declaration {
            Declaration::TSTypeAliasDeclaration(_) | Declaration::TSInterfaceDeclaration(_) => {
                self.blank(export.span)
            }
            Declaration::VariableDeclaration(variables) if variables.declare => {
                self.blank(export.span)
            }
            // `export const x = 1, y = 2` → `N.x = 1, N.y = 2`.
            Declaration::VariableDeclaration(variables) => {
                let Some(first) = variables.declarations.first() else {
                    return;
                };
                let keyword = Range::new(export.span.start, first.id.span().start);
                let newlines = "\n".repeat(self.text(keyword).matches('\n').count());
                self.replacements.push((keyword, newlines));
                for declarator in &variables.declarations {
                    match &declarator.id {
                        BindingPattern::BindingIdentifier(identifier) => self.replacements.push((
                            Range::new(identifier.span.start, identifier.span.start),
                            format!("{param}."),
                        )),
                        other => {
                            return self.fail(
                                other.span().start,
                                "a namespace can't export a destructured variable here",
                                Some("export each name: `export const a = value.a`"),
                            )
                        }
                    }
                }
                self.visit_variable_declaration(variables);
            }
            Declaration::FunctionDeclaration(function)
                if function.declare || function.body.is_none() =>
            {
                self.blank(export.span)
            }
            Declaration::ClassDeclaration(class) if class.declare => self.blank(export.span),
            Declaration::FunctionDeclaration(function) => {
                self.blank(keyword);
                if let Some(id) = &function.id {
                    self.replacements.push((
                        Range::new(function.span.end, function.span.end),
                        format!(" {param}.{0} = {0};", id.name),
                    ));
                }
                self.visit_declaration(declaration);
            }
            Declaration::ClassDeclaration(class) => {
                self.blank(keyword);
                self.visit_declaration(declaration);
                // After what the class's decorators write there.
                if let Some(id) = &class.id {
                    self.copies.push((
                        class.span.end,
                        format!(" {param}.{0} = {0};", id.name),
                        Range::new(0, 0),
                        String::new(),
                    ));
                }
            }
            Declaration::TSEnumDeclaration(declaration) if declaration.declare => {
                self.blank(export.span)
            }
            Declaration::TSEnumDeclaration(declaration) => {
                self.blank(keyword);
                self.enum_declaration(declaration, declaration.span, false);
                self.replacements.push((
                    Range::new(declaration.span.end, declaration.span.end),
                    format!(" {param}.{0} = {0};", declaration.id.name),
                ));
            }
            Declaration::TSNamespaceDeclaration(inner) => {
                self.namespace(inner, export.span, Some(param))
            }
            // `export import X = A.B` → `N.X = A.B;`
            Declaration::TSImportEqualsDeclaration(alias) => match &alias.module_reference {
                TSModuleReference::ExternalModuleReference(_) => self.import_alias(alias),
                reference => {
                    let target = self.text(reference.span()).to_owned();
                    let mut text = format!("{param}.{} = {target};", alias.id.name);
                    text.push_str(&"\n".repeat(self.text(export.span).matches('\n').count()));
                    self.replacements.push((export.span, text));
                }
            },
            _ => self.visit_statement(statement),
        }
    }

    /// `import X = A.B`: `const X = A.B` when it's read as a value, nothing when it's a type.
    /// `import x = require("…")` is CommonJS, which TypeScript refuses in an ES module too.
    fn import_alias(&mut self, alias: &TSImportEqualsDeclaration<'_>) {
        match &alias.module_reference {
            TSModuleReference::ExternalModuleReference(_) => self.fail(
                alias.span.start,
                "`import x = require(…)` is CommonJS, which TypeScript refuses in an ES module too (TS1202)",
                Some("use `import x from \"…\"`"),
            ),
            _ if alias.import_kind.is_type() || !self.value_aliases.contains(&alias.span.start) => {
                self.blank(alias.span)
            }
            _ => self
                .replacements
                .push((Range::new(alias.span.start, alias.span.start + 6), "const ".to_owned())),
        }
    }

    /// `constructor(private x: number)`: TypeScript declares `x` as a field (with
    /// `useDefineForClassFields`, its default for modern targets) and assigns it first thing in
    /// the constructor, or right after `super(…)` in a subclass.
    fn parameter_properties(&mut self, class: &Class<'_>) {
        // (The constructor with a body: the others are overloads.)
        let Some(constructor) = class.body.body.iter().find_map(|element| match element {
            ClassElement::MethodDefinition(method)
                if method.kind == MethodDefinitionKind::Constructor
                    && method.value.body.is_some() =>
            {
                Some(method)
            }
            _ => None,
        }) else {
            return;
        };
        let names: Vec<String> = constructor
            .value
            .params
            .items
            .iter()
            .filter(|param| param.accessibility.is_some() || param.readonly || param.r#override)
            .filter_map(|param| param.pattern.get_binding_identifier())
            .map(|identifier| identifier.name.to_string())
            .collect();
        let Some(body) = &constructor.value.body else {
            return;
        };
        if names.is_empty() {
            return;
        }
        if self.define_fields {
            let at = class.body.span.start + 1;
            self.replacements
                .push((Range::new(at, at), format!(" {};", names.join("; "))));
        }
        let assignments = names
            .iter()
            .map(|name| format!("this.{name} = {name};"))
            .collect::<Vec<_>>()
            .join(" ");
        // After the `super(…)` call, in a subclass.
        let after_super = class.heritage.as_ref().and_then(|_| super_call_end(body));
        match after_super {
            Some(at) => self
                .replacements
                .push((Range::new(at, at), format!("; {assignments}"))),
            None => {
                let at = body.span.start + 1;
                self.replacements
                    .push((Range::new(at, at), format!(" {assignments}")));
            }
        }
    }

    /// Without `useDefineForClassFields` (an older `target`, or set false), TypeScript assigns
    /// fields rather than defining them: an instance field's initializer moves into the
    /// constructor (`this.y = …`, after `super(…)` and the parameter properties; a constructor
    /// is written if there's none), a static one becomes `static { this.s = …; }`, and a field
    /// with no initializer goes. `#private` fields stay fields, as in `tsc`.
    fn assigned_fields(&mut self, class: &Class<'_>) {
        if self.define_fields {
            return;
        }
        let mut instance: Vec<(String, Range, String, String)> = Vec::new();
        for element in &class.body.body {
            // An `accessor`'s storage is an instance field like any other: declared where it is,
            // and assigned in the constructor (its getter and setter are `accessor`'s).
            if let ClassElement::AccessorProperty(accessor) = element {
                if accessor.r#static
                    || accessor.r#type == AccessorPropertyType::TSAbstractAccessorProperty
                {
                    continue;
                }
                let key = standard_decorators::Key::of(&accessor.key, accessor.computed);
                let Some(storage) = standard_decorators::storage(&key, accessor.span.start) else {
                    continue;
                };
                let wrap = self.field_wraps.get(&accessor.span.start).copied();
                let value = accessor.value.as_ref().map(GetSpan::span);
                if let Some(value) = value {
                    // `= value` goes (into the constructor).
                    let removed = Range::new(accessor.key.span().end, value.end);
                    let newlines = "\n".repeat(self.text(removed).matches('\n').count());
                    self.replacements.push((removed, newlines));
                } else if wrap.is_none() {
                    continue;
                }
                let (open, close) = wrapped_value(wrap, value.is_none());
                instance.push((
                    format!(".{storage}"),
                    value.unwrap_or(Range::new(0, 0)),
                    open,
                    close,
                ));
                continue;
            }
            let ClassElement::PropertyDefinition(property) = element else {
                continue;
            };
            let private = matches!(
                property.key,
                oxc_ast::ast::PropertyKey::PrivateIdentifier(_)
            );
            // (A static `#private` field stays a field, as in `tsc`.)
            if property.declare
                || property.r#type == PropertyDefinitionType::TSAbstractPropertyDefinition
                || (private && property.r#static)
            {
                continue;
            }
            let key = self.text(property.key.span()).to_owned();
            let target = match &property.key {
                oxc_ast::ast::PropertyKey::StaticIdentifier(_) if !property.computed => {
                    format!(".{key}")
                }
                oxc_ast::ast::PropertyKey::PrivateIdentifier(_) => format!(".{key}"),
                _ => format!("[{key}]"),
            };
            let span = Range::new(property.span.start, property.span.end);
            let newlines = "\n".repeat(self.text(span).matches('\n').count());
            // A `#private` field has to be declared: `#p;`, then assigned in the constructor.
            let declared = if private {
                format!("{key};")
            } else {
                String::new()
            };
            self.replacements
                .push((span, format!("{declared}{newlines}")));
            // A decorated field: its value goes through the decorators' initializers, and their
            // extra initializers run right after it's assigned.
            let wrap = self.field_wraps.get(&property.span.start).copied();
            let value = property.value.as_ref().map(GetSpan::span);
            if value.is_none() && wrap.is_none() {
                continue;
            }
            let (open, close) = wrapped_value(wrap, value.is_none());
            let value = value.unwrap_or(Range::new(0, 0));
            if property.r#static {
                self.copies.push((
                    span.start,
                    format!("static {{ this{target} = {open}"),
                    value,
                    format!("{close}; }}"),
                ));
            } else {
                instance.push((target, value, open, close));
            }
        }
        if instance.is_empty() {
            return;
        }
        let constructor = class.body.body.iter().find_map(|element| match element {
            ClassElement::MethodDefinition(method)
                if method.kind == MethodDefinitionKind::Constructor =>
            {
                method.value.body.as_ref()
            }
            _ => None,
        });
        let derived = class.heritage.is_some();
        let mut close = None;
        let at = match constructor {
            Some(body) => match derived.then(|| super_call_end(body)).flatten() {
                Some(at) => at,
                None => body.span.start + 1,
            },
            None => {
                let at = class.body.span.start + 1;
                let open = if derived {
                    " constructor() { super(...arguments);"
                } else {
                    " constructor() {"
                };
                self.copies
                    .push((at, open.to_owned(), Range::new(0, 0), String::new()));
                close = Some(" }");
                at
            }
        };
        // Right after `super(…)`, a `;` first (the statement may not end with one), unless the
        // parameter properties already wrote one there.
        let separated = constructor.is_some()
            && derived
            && !self
                .replacements
                .iter()
                .any(|(range, text)| range.start == at && range.end == at && text.starts_with(';'));
        for (index, (target, value, open, close)) in instance.into_iter().enumerate() {
            let prefix = if index == 0 && separated {
                format!("; this{target} = {open}")
            } else {
                format!(" this{target} = {open}")
            };
            self.copies.push((at, prefix, value, format!("{close};")));
        }
        if let Some(close) = close {
            self.copies
                .push((at, close.to_owned(), Range::new(0, 0), String::new()));
        }
    }

    /// Decorators on a class and its members. With `experimentalDecorators` they're TypeScript's
    /// legacy ones, written as `tsc` writes them: each `@` goes, and `__decorate` calls follow
    /// the class (instance members, then static ones, then the class itself, its constructor's
    /// parameter decorators with it). Without it they're standard decorators, lowered as `tsc`
    /// lowers them for ES2022 (see `standard_decorators.rs`).
    fn decorators(&mut self, class: &Class<'_>) {
        if !self.experimental_decorators {
            return self.standard_decorators(class);
        }
        let decorated_member = class.body.body.iter().any(|element| match element {
            ClassElement::MethodDefinition(method) => {
                !method.decorators.is_empty()
                    || method
                        .value
                        .params
                        .items
                        .iter()
                        .any(|param| !param.decorators.is_empty())
            }
            ClassElement::PropertyDefinition(property) => !property.decorators.is_empty(),
            ClassElement::AccessorProperty(accessor) => !accessor.decorators.is_empty(),
            _ => false,
        });
        self.auto_accessors(class);
        if class.decorators.is_empty() && !decorated_member {
            return;
        }
        let first = class
            .decorators
            .first()
            .map(|decorator| decorator.span.start)
            .unwrap_or(class.span.start);
        if class.r#type == oxc_ast::ast::ClassType::ClassExpression {
            // (`tsc` writes nothing for them.)
            return self.fail(
                first,
                "legacy decorators aren't valid on a class expression (TS1206)",
                Some("declare the class: `@decorator class Name { … }`"),
            );
        }
        // A class declaration's calls name it; `export default class {}` is passed to a
        // function that decorates it as `__zb_c`.
        let declared =
            class.r#type == oxc_ast::ast::ClassType::ClassDeclaration && class.id.is_some();
        let name = match (&class.id, declared) {
            (Some(id), true) => id.name.to_string(),
            _ => "__zb_c".to_owned(),
        };
        // Each decorator goes from where it was; its expression is copied into the call.
        let mut calls: Vec<(bool, Vec<Piece>)> = Vec::new(); // (static, call)
        let mut class_level: Vec<Piece> = class
            .decorators
            .iter()
            .map(|decorator| Piece::Copy(decorator.expression.span()))
            .collect();
        for decorator in &class.decorators {
            self.remove(decorator.span);
        }
        for element in &class.body.body {
            let (decorators, key, computed, is_static, descriptor, params) = match element {
                ClassElement::MethodDefinition(method) => (
                    &method.decorators,
                    &method.key,
                    method.computed,
                    method.r#static,
                    "null",
                    Some((
                        &method.value.params,
                        method.kind == MethodDefinitionKind::Constructor,
                    )),
                ),
                ClassElement::PropertyDefinition(property) => (
                    &property.decorators,
                    &property.key,
                    property.computed,
                    property.r#static,
                    "void 0",
                    None,
                ),
                ClassElement::AccessorProperty(accessor) => (
                    &accessor.decorators,
                    &accessor.key,
                    accessor.computed,
                    accessor.r#static,
                    "void 0",
                    None,
                ),
                _ => continue,
            };
            let mut pieces: Vec<Piece> = decorators
                .iter()
                .map(|decorator| Piece::Copy(decorator.expression.span()))
                .collect();
            for decorator in decorators {
                self.remove(decorator.span);
            }
            let mut constructor = false;
            if let Some((params, is_constructor)) = params {
                constructor = is_constructor;
                for (index, param) in params.items.iter().enumerate() {
                    for decorator in &param.decorators {
                        self.decorator_helpers.insert("param");
                        let call = vec![
                            Piece::Text(format!("__zubraParam({index}, ")),
                            Piece::Copy(decorator.expression.span()),
                            Piece::Text(")".to_owned()),
                        ];
                        if is_constructor {
                            class_level.extend(call);
                        } else {
                            pieces.extend(call);
                        }
                        self.remove(decorator.span);
                    }
                }
            }
            if constructor || pieces.is_empty() {
                continue;
            }
            if computed || matches!(key, oxc_ast::ast::PropertyKey::PrivateIdentifier(_)) {
                return self.fail(
                    key.span().start,
                    "a legacy decorator on a computed or private member isn't supported",
                    Some("give the member a plain name"),
                );
            }
            let key_text = match key {
                oxc_ast::ast::PropertyKey::StaticIdentifier(identifier) => {
                    serde_json::to_string(identifier.name.as_str()).unwrap_or_default()
                }
                other => self.text(other.span()).to_owned(),
            };
            self.decorator_helpers.insert("decorate");
            let target = if is_static {
                name.clone()
            } else {
                format!("{name}.prototype")
            };
            let mut call = vec![Piece::Text("__zubraDecorate([".to_owned())];
            call.extend(join(pieces));
            call.push(Piece::Text(format!(
                "], {target}, {key_text}, {descriptor});"
            )));
            calls.push((is_static, call));
        }
        // Instance members, then static ones.
        calls.sort_by_key(|(is_static, _)| *is_static);
        let mut after: Vec<Piece> = Vec::new();
        for (_, call) in calls {
            after.push(Piece::Text(" ".to_owned()));
            after.extend(call);
        }
        let class_keyword = class
            .decorators
            .last()
            .map_or(class.span.start, |decorator| decorator.span.end);
        let class_keyword = class_keyword
            + u32::try_from(
                self.source[class_keyword as usize..class.body.span.start as usize]
                    .find("class")
                    .unwrap_or(0),
            )
            .unwrap_or(0);
        if !declared {
            // `export default ((__zb_c) => { …; return __zb_c; })(class { … })`, named
            // `default` as it would have been.
            let mut before = vec![Piece::Text("((__zb_c) => {".to_owned())];
            before.extend(after);
            if class_level.is_empty() {
                before.push(Piece::Text(" return __zb_c; })(".to_owned()));
            } else {
                self.decorator_helpers.insert("decorate");
                before.push(Piece::Text(" return __zubraDecorate([".to_owned()));
                before.extend(join(class_level));
                before.push(Piece::Text("], __zb_c); })(".to_owned()));
            }
            self.insert_pieces(class_keyword, before);
            if class.id.is_none() {
                if let Some(contextual) = self.class_names.get(&class.span.start).cloned() {
                    self.insert_pieces(
                        class.body.span.start + 1,
                        vec![Piece::Text(format!(
                            " static {{ Object.defineProperty(this, \"name\", {{ value: {}, configurable: true }}); }}",
                            serde_json::to_string(&contextual).unwrap_or_default()
                        ))],
                    );
                }
            }
            self.insert_pieces(class.span.end, vec![Piece::Text(")".to_owned())]);
            return;
        }
        if class_level.is_empty() {
            self.insert_pieces(class.span.end, after);
            return;
        }
        // A class decorator may return another class, which the class's own references see too
        // (`tsc` renames them `A_1`): `const A = (() => { var A = class { static { A = this; } …
        // }; …; return A = __decorate([…], A); })();`, on the class's own lines.
        self.decorator_helpers.insert("decorate");
        if let Some(id) = &class.id {
            self.blank(id.span);
        }
        let default_export = self.default_exports.get(&class.span.start).copied();
        if let Some(range) = default_export {
            self.blank(range);
        }
        self.insert_pieces(
            class_keyword,
            vec![Piece::Text(format!(
                "const {name} = (() => {{ var {name} = "
            ))],
        );
        self.insert_pieces(
            class.body.span.start + 1,
            vec![Piece::Text(format!(" static {{ {name} = this; }}"))],
        );
        let mut close = vec![Piece::Text(";".to_owned())];
        close.extend(after);
        close.push(Piece::Text(format!(" return {name} = __zubraDecorate([")));
        close.extend(join(class_level));
        close.push(Piece::Text(format!("], {name}); }})();")));
        if default_export.is_some() {
            close.push(Piece::Text(format!(" export {{ {name} as default }};")));
        }
        self.insert_pieces(class.span.end, close);
    }

    /// The members of `interface Props` (or `type Props = { … }`): name and type text.
    fn props_interface<'m, 'a: 'm>(
        &mut self,
        members: impl IntoIterator<Item = &'m oxc_ast::ast::TSSignature<'a>>,
        start: u32,
    ) {
        let mut props = Vec::new();
        for member in members {
            // `pick(item: Item): void`: a function prop, typed as `Props` has it.
            if let oxc_ast::ast::TSSignature::TSMethodSignature(method) = member {
                if let oxc_ast::ast::PropertyKey::StaticIdentifier(identifier) = &method.key {
                    let name = identifier.name.to_string();
                    let text = format!(
                        "Props[{}]",
                        serde_json::to_string(&name).unwrap_or_default()
                    );
                    props.push((name, text));
                }
                continue;
            }
            if let oxc_ast::ast::TSSignature::TSPropertySignature(property) = member {
                let name = match &property.key {
                    oxc_ast::ast::PropertyKey::StaticIdentifier(identifier) => {
                        identifier.name.to_string()
                    }
                    oxc_ast::ast::PropertyKey::StringLiteral(literal) => {
                        literal.value.as_str().unwrap_or_default().to_owned()
                    }
                    _ => continue,
                };
                let text = property.type_annotation.as_ref().map_or_else(
                    || "unknown".to_owned(),
                    |annotation| self.text(annotation.type_annotation.span()).to_owned(),
                );
                props.push((name, text));
            }
        }
        self.types.props_interface = Some((props, start));
    }

    /// Take out `range` (a decorator), keeping its line breaks.
    fn remove(&mut self, range: Range) {
        let newlines = "\n".repeat(self.text(range).matches('\n').count());
        self.replacements.push((range, newlines));
    }

    /// Insert text and copies of the script's JavaScript (types blanked) at `at`, in order.
    fn insert_pieces(&mut self, at: u32, pieces: Vec<Piece>) {
        for piece in pieces {
            match piece {
                Piece::Text(text) => self
                    .copies
                    .push((at, text, Range::new(0, 0), String::new())),
                Piece::Copy(range) => self.copies.push((at, String::new(), range, String::new())),
            }
        }
    }

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
        // A namespace's own types aren't the component's.
        if self.depth > 0 {
            return self.blank(it.span);
        }
        if it.id.name == "Props" {
            match &it.type_annotation {
                oxc_ast::ast::TSType::TSTypeLiteral(literal) => {
                    self.props_interface(&literal.members, it.span.start);
                }
                // `type Props = Base & { … }`: its literal parts are listed; the rest are
                // TypeScript's to resolve.
                oxc_ast::ast::TSType::TSIntersectionType(intersection) => {
                    let members: Vec<&oxc_ast::ast::TSSignature<'_>> = intersection
                        .types
                        .iter()
                        .filter_map(|part| match part {
                            oxc_ast::ast::TSType::TSTypeLiteral(literal) => Some(&literal.members),
                            _ => None,
                        })
                        .flatten()
                        .collect();
                    self.props_interface(members, it.span.start);
                    self.types.props_open = true;
                }
                _ => {}
            }
        }
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
        if self.depth > 0 {
            return self.blank(it.span);
        }
        if it.id.name == "Props" {
            self.props_interface(&it.body.body, it.span.start);
            self.types.props_open = !it.extends.is_empty();
        }
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

    fn visit_ts_enum_declaration(&mut self, it: &TSEnumDeclaration<'a>) {
        self.enum_declaration(it, it.span, false);
    }

    fn visit_ts_namespace_declaration(&mut self, it: &TSNamespaceDeclaration<'a>) {
        self.namespace(it, it.span, None);
    }

    fn visit_statements(&mut self, it: &oxc_allocator::Vec<'a, Statement<'a>>) {
        self.seen.push(HashSet::new());
        for statement in it {
            self.visit_statement(statement);
            let names = declared_names(statement);
            if let Some(frame) = self.seen.last_mut() {
                frame.extend(names);
            }
        }
        self.seen.pop();
    }

    fn visit_ts_type_assertion(&mut self, it: &TSTypeAssertion<'a>) {
        // `<T>value` (a `.ts` script, where it isn't JSX): `(value)`. The parentheses keep what
        // it means where the `<T>` mattered: after `return` and a line break, before `{` in an
        // arrow's body, or starting a statement with `function` or `{`.
        let head = Range::new(it.span.start, it.expression.span().start);
        let newlines = "\n".repeat(self.text(head).matches('\n').count());
        self.replacements.push((head, format!("({newlines}")));
        let end = it.expression.span().end;
        self.replacements
            .push((Range::new(end, end), ")".to_owned()));
        self.visit_expression(&it.expression);
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
                return self.import_alias(declaration);
            }
            Statement::TSExportAssignment(assignment) => {
                return self.fail(
                    assignment.span.start,
                    "`export =` is CommonJS, and TypeScript refuses it in an ES module too (TS1203)",
                    Some("a component script exports nothing: declare props on the host tag"),
                );
            }
            Statement::ExportDeclaration(export)
                if matches!(export.declaration, Declaration::TSNamespaceDeclaration(_)) =>
            {
                return self.fail(
                    export.span.start,
                    "a component script can't export a namespace: its exports are the component's interface, and only an `export enum` belongs there",
                    Some("drop `export` (the namespace works inside the component), or move it to a module and import it"),
                );
            }
            // `export default class …`: a decorated class is wrapped, so a named one is declared
            // and exported by name, and an anonymous one is named `default`.
            Statement::ExportDefaultDeclaration(export) => {
                if let ExportDefaultDeclarationKind::ClassDeclaration(class) = &export.declaration {
                    if class.id.is_some() {
                        let text = self.text(export.span);
                        // (From `export`, which a decorator may come before.)
                        let index = text.find("default");
                        let from = index.and_then(|index| text[..index].rfind("export"));
                        if let (Some(from), Some(index)) = (from, index) {
                            let at = |offset: usize| {
                                export.span.start + u32::try_from(offset).expect("fits")
                            };
                            self.default_exports.insert(
                                class.span.start,
                                Range::new(at(from), at(index + "default".len())),
                            );
                        }
                    } else {
                        self.class_names
                            .insert(class.span.start, "default".to_owned());
                    }
                }
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
            // `export enum Size { … }`: the element module exports it (see `script.rs`).
            Statement::ExportDeclaration(export)
                if matches!(export.declaration, Declaration::TSEnumDeclaration(_)) =>
            {
                if let Declaration::TSEnumDeclaration(declaration) = &export.declaration {
                    self.enum_declaration(declaration, export.span, true);
                }
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
        let specifier = it.source.value.as_str().unwrap_or_default().to_owned();
        for item in it.specifiers.iter().flatten() {
            let imported = match item {
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    named.imported.name().as_str().to_owned()
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => "default".to_owned(),
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => continue,
            };
            self.types.imported.push((
                item.local().name.to_string(),
                imported,
                specifier.clone(),
                it.span.start,
            ));
        }
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
        // `import { type A, type B } from "…"`: nothing's left to import, so the whole import
        // goes, as `tsc` drops it (`verbatimModuleSyntax` keeps `import {} from "…"`).
        let specifiers: Vec<_> = it.specifiers.iter().flatten().collect();
        let all_types = !specifiers.is_empty()
            && specifiers.iter().all(|specifier| {
                matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(named) if named.import_kind.is_type())
            });
        if all_types && !self.types.verbatim {
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
        // `const X = class { … }`: the class is named `X` (kept when decorators wrap it).
        if let (Some(Expression::ClassExpression(class)), Some(name)) =
            (&it.init, it.id.get_binding_identifier())
        {
            if class.id.is_none() {
                self.class_names
                    .insert(class.span.start, name.name.to_string());
            }
        }
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
        // `function f(this: Window, a)`: a `this` parameter is a type only.
        if let Some(this) = &it.this_param {
            let end = self.following_comma(this.span.end).unwrap_or(this.span.end);
            self.blank(Range::new(this.span.start, end));
        }
        walk::walk_function(self, it, flags);
    }

    fn visit_formal_parameter(&mut self, it: &FormalParameter<'a>) {
        // A parameter property (`constructor(private x)`): the modifiers go here; the field and
        // the assignment are written by `visit_class`.
        if it.accessibility.is_some() || it.readonly || it.r#override {
            self.blank_modifiers(Range::new(it.span.start, it.pattern.span().start));
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
        self.parameter_properties(it);
        // (Decorators first: a decorated field assigned in the constructor is wrapped there.)
        self.decorators(it);
        self.assigned_fields(it);
        if it.r#abstract {
            // `abstract class` → `class`: blank the keyword.
            // (After the decorators, whose names may contain the word.)
            let from = it
                .decorators
                .last()
                .map_or(it.span.start, |decorator| decorator.span.end);
            let text = self.text(Range::new(from, it.body.span.start)).to_owned();
            if let Some(index) = text.find("abstract") {
                let start = from + u32::try_from(index).expect("fits");
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
        let source = "interface Picked {\n  option: string\n  index: number\n}\ntype Pair =\n  | [number, number]\n  | null\nimport x = require('x')";
        same_shape(&format!(
            "{}\nconst after = 1",
            &source[..source.find("import").unwrap()]
        ));
        let error = strip(source, Span::new(1, 1)).unwrap_err();
        assert_eq!(error.span.line, 8, "the import is still on line 8");
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
    fn what_runs_is_written_in_place_keeping_lines() {
        for (source, expected) in [
            (
                "namespace N {\n  export const x = 1\n}",
                "const N = {}; (function (N) {\n  N.x = 1\n})(N);",
            ),
            (
                "namespace T { export type A = 1 }",
                "                                 ",
            ),
            (
                "class A { constructor(public x: number) {} }",
                "class A { x; constructor(       x        ) { this.x = x;} }",
            ),
            ("function f(this: A, b) {}", "function f(         b) {}"),
            ("const v = <T>w", "const v = (w)"),
            ("const f = () => <T>{ a: 1 }", "const f = () => ({ a: 1 })"),
        ] {
            let out = stripped(source);
            assert_eq!(out, expected);
            assert_eq!(out.matches('\n').count(), source.matches('\n').count());
        }
    }

    #[test]
    fn rejects_what_it_can_t_reduce_and_says_what_to_write() {
        for (source, expected, line) in [
            (
                "const a = 1\nenum Color { Red = \"r\", Green }",
                "needs an initializer",
                3,
            ),
            ("import fs = require('fs')", "TS1202", 2),
            ("export = 1", "TS1203", 2),
        ] {
            let error = strip(source, Span::new(2, 1)).unwrap_err();
            assert!(
                error.message.contains(expected),
                "{source}: {}",
                error.message
            );
            let help = error.help.as_deref().unwrap_or_default();
            assert!(help.ends_with("see docs/typescript.md"), "{source}: {help}");
            // (`needs an initializer` is the enum rule TypeScript has too.)
            assert_eq!(error.span.line, line, "{source}");
        }
        let error = strip("const = 1", Span::new(1, 1)).unwrap_err();
        assert!(error.message.starts_with("invalid <script lang=\"ts\">"));
    }
}
