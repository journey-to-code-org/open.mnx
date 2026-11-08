//! The JSX front end: a function component in a `.mnx.jsx` / `.mnx.tsx` file, lowered to the
//! `.mnx` format so it shares the parser's checks, the IR and every output.
//!
//! ```jsx
//! /** A two-star rating. */
//! export default function MnxRating({ value = 0, onValueChange }) {
//!   let hovered = null                                  // state
//!   const shown = hovered ?? value                      // derived: stays in sync
//!   function rate(stars) { value = stars; onValueChange(stars) }
//!   return (
//!     <>
//!       <button onClick={() => rate(1)} onMouseEnter={() => (hovered = 1)}>1</button>
//!       <output>{shown}</output>
//!     </>
//!   )
//! }
//! ```
//!
//! - The function's name is the tag (`MnxRating` → `<mnx-rating>`). Returning the host itself
//!   (`<mnx-rating shadow>…</mnx-rating>`) sets its flags.
//! - Destructured parameters are props, with their defaults; one without a default is required.
//!   `on<Name>` parameters are events: calling `onValueChange(x)` fires `valuechange` with
//!   `detail: x` (`plan/decisions/event-declaration.md`). `children` is the default slot.
//! - The body runs once per element. A top-level `let` is state: reading it is reactive and
//!   assigning it updates the DOM. A top-level `const` whose value reads props or state is
//!   derived (a computed), so it stays in sync. Props are names, readable and writable.
//! - In the returned JSX, `cond && <X/>` and `cond ? <A/> : <B/>` are `mnx-if`, and
//!   `list.map((item, i) => <li key={…}>…</li>)` is a keyed `mnx-each`. Imported components are
//!   used by their import name (`<Badge />`).
//!
//! The lowering keeps a map from the generated text back to the JSX source, so diagnostics point
//! at the JSX.

use std::collections::HashMap;
use std::ops::Range;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrowFunctionExpression, BindingPattern, CallExpression,
    ExportDefaultDeclarationKind, Expression, Function, IdentifierReference,
    ImportDeclarationSpecifier, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild,
    JSXElement, JSXElementName, JSXExpression, PropertyKey, Statement, VariableDeclarationKind,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder};
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::{scope::ScopeFlags, symbol::SymbolId};

use crate::{
    components::Loader,
    diagnostic::{Diagnostic, Span},
    reactive::{self, Edit, Kind, COMPUTED, EMIT, HELPERS, STATE},
    scanner::span_after,
};

thread_local! {
    /// Lowered components by path, so errors found later (in an imported JSX component) can be
    /// placed in its JSX source.
    static LOWERED: std::cell::RefCell<HashMap<String, Lowered>> = std::cell::RefCell::new(HashMap::new());
}

/// `diagnostic` from compiling lowered text, placed in the JSX source: an imported JSX
/// component's (by its `file`), or the top-level one (`top`: the source and its lowering).
pub fn remap(mut diagnostic: Diagnostic, top: Option<(&str, &Lowered)>) -> Diagnostic {
    match &diagnostic.file {
        Some((file, source)) if is_jsx(file) => {
            let span = LOWERED.with(|lowered| {
                lowered
                    .borrow()
                    .get(file)
                    .map(|lowered| lowered.original_span(source, diagnostic.span))
            });
            if let Some(span) = span {
                diagnostic.span = span;
            }
        }
        Some(_) => {}
        None => {
            if let Some((source, lowered)) = top {
                diagnostic.span = lowered.original_span(source, diagnostic.span);
            }
        }
    }
    diagnostic
}

/// Whether a source without a path is a JSX component: an `.mnx` file starts with markup.
pub fn looks_like_jsx(source: &str) -> bool {
    let start = source.trim_start();
    [
        "import",
        "export",
        "//",
        "/*",
        "function",
        "const",
        "type",
        "interface",
    ]
    .iter()
    .any(|word| {
        start.starts_with(word)
            && !start[word.len()..]
                .starts_with(|character: char| character.is_alphanumeric() || character == ':')
    })
}

/// Whether `path` is a JSX component (`.mnx.jsx` / `.mnx.tsx`).
pub fn is_jsx(path: &str) -> bool {
    path.ends_with(".mnx.jsx") || path.ends_with(".mnx.tsx")
}

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// The `.mnx` text a JSX component lowers to, and the way back.
#[derive(Clone, Debug)]
pub struct Lowered {
    pub text: String,
    map: SourceMap,
}

#[derive(Clone, Debug, Default)]
struct SourceMap {
    /// `(output offset, original offset, length, exact)`, in output order.
    pieces: Vec<(usize, usize, usize, bool)>,
}

impl Lowered {
    /// A position in the lowered text, as a position in the JSX source.
    pub fn original_span(&self, original: &str, span: Span) -> Span {
        let offset = offset_of(&self.text, span);
        let at = match self
            .map
            .pieces
            .iter()
            .rev()
            .find(|(out, ..)| *out <= offset)
        {
            Some(&(out, from, length, true)) => from + (offset - out).min(length),
            Some(&(_, from, ..)) => from,
            None => 0,
        };
        span_after(Span::new(1, 1), original, at)
    }

    /// `diagnostic` (from compiling the lowered text) with its position in the JSX source.
    pub fn remap(&self, original: &str, mut diagnostic: Diagnostic) -> Diagnostic {
        diagnostic.span = self.original_span(original, diagnostic.span);
        diagnostic
    }
}

fn offset_of(text: &str, span: Span) -> usize {
    let mut line = 1;
    let mut column = 1;
    for (offset, character) in text.char_indices() {
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
    text.len()
}

/// Output text with its source map.
#[derive(Default)]
struct Out {
    text: String,
    map: SourceMap,
}

impl Out {
    fn original(&mut self, source: &str, range: Range<usize>) {
        if range.is_empty() {
            return;
        }
        self.map
            .pieces
            .push((self.text.len(), range.start, range.len(), true));
        self.text.push_str(&source[range]);
    }

    fn synthetic(&mut self, text: &str, at: usize) {
        if text.is_empty() {
            return;
        }
        self.map.pieces.push((self.text.len(), at, 0, false));
        self.text.push_str(text);
    }
}

fn error_at(source: &str, offset: u32, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        span_after(Span::new(1, 1), source, offset as usize),
        message,
    )
}

/// `MnxRating` → `mnx-rating`.
fn tag_of(name: &str) -> String {
    let mut tag = String::new();
    for (i, character) in name.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if i > 0 {
                tag.push('-');
            }
            tag.push(character.to_ascii_lowercase());
        } else {
            tag.push(character);
        }
    }
    tag
}

/// `selectedIndex` → `selected-index` (the attribute for the prop).
fn kebab(name: &str) -> String {
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
}

/// `onValueChange` → `valuechange` (`plan/decisions/event-naming.md`).
fn event_of(name: &str) -> Option<String> {
    let rest = name.strip_prefix("on")?;
    rest.starts_with(|character: char| character.is_ascii_uppercase())
        .then(|| rest.to_ascii_lowercase())
}

fn source_type(path: &str) -> SourceType {
    if path.ends_with(".tsx") {
        SourceType::tsx()
    } else {
        SourceType::jsx()
    }
}

/// The tag a JSX component file defines (from its default-exported function's name).
pub fn tag_in(source: &str, path: &str) -> Result<String, Diagnostic> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path)).parse();
    for statement in &parsed.program.body {
        if let Statement::ExportDefaultDeclaration(export) = statement {
            if let ExportDefaultDeclarationKind::FunctionDeclaration(function) = &export.declaration
            {
                if let Some(id) = &function.id {
                    return Ok(tag_of(id.name.as_str()));
                }
            }
        }
    }
    Err(Diagnostic::new(
        Span::new(1, 1),
        "a JSX component file default-exports a named function, e.g. `export default function MnxCard() {…}`",
    ))
}

/// Lower the JSX component at `path`. `loader` finds imported components (for their tags).
pub fn lower(source: &str, path: &str, loader: Option<Loader<'_>>) -> Result<Lowered, Diagnostic> {
    LOWERED.with(|lowered| lowered.borrow_mut().remove(path));
    let lowered = lower_uncached(source, path, loader, false)?;
    LOWERED.with(|cache| cache.borrow_mut().insert(path.to_owned(), lowered.clone()));
    Ok(lowered)
}

/// The JSX component as a readable `.mnx` file, for `mnx convert --as mnx`: the script as
/// written (`let` state, props by name, `on…` calls as `emit()`), the template with its
/// indentation, and nothing the compiler adds for itself.
pub fn lower_readable(source: &str, path: &str) -> Result<String, Diagnostic> {
    let lowered = lower_uncached(source, path, None, true)?;
    let text = lowered.text.replace(&format!("{EMIT}("), "emit(");
    Ok(dedent_template(&text))
}

/// The template lines (after `</script>`), left with two spaces of indentation at their shallowest.
fn dedent_template(text: &str) -> String {
    let Some(at) = text.find("</script>\n") else {
        return text.to_owned();
    };
    let (script, template) = text.split_at(at + "</script>\n".len());
    let lines: Vec<&str> = template.lines().collect();
    let inner: Vec<&str> = lines
        .iter()
        .copied()
        .skip(1)
        .filter(|line| !line.trim().is_empty() && !line.starts_with("</"))
        .collect();
    let shallowest = inner
        .iter()
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(2);
    let strip = shallowest.saturating_sub(2);
    let mut out = script.to_owned();
    for (index, line) in lines.iter().enumerate() {
        let trimmed_lead = line.len() - line.trim_start().len();
        let line = if index == 0 || line.starts_with("</") {
            (*line).to_owned()
        } else {
            line[trimmed_lead.min(strip)..].to_owned()
        };
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

fn lower_uncached(
    source: &str,
    path: &str,
    loader: Option<Loader<'_>>,
    readable: bool,
) -> Result<Lowered, Diagnostic> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path)).parse();
    if let Some(error) = parsed.diagnostics.first() {
        let offset = error.labels.first().map_or(0, |label| label.offset());
        return Err(error_at(
            source,
            offset,
            format!("invalid JSX: {}", error.message),
        ));
    }
    let program = &parsed.program;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();

    // The module: imports, helpers, and the component.
    let mut imports: Vec<(Range<usize>, Option<String>)> = Vec::new();
    let mut helpers: Vec<Range<usize>> = Vec::new();
    let mut components: HashMap<String, (String, u32)> = HashMap::new(); // local → (specifier, at)
    let mut function = None;
    let mut export_start = 0;
    let mut from_names: Vec<String> = Vec::new(); // `from` from the runtime, by local name
    for statement in &program.body {
        let span = statement.span();
        match statement {
            Statement::ImportDeclaration(import) => {
                let specifier = import.source.value.as_str().unwrap_or_default().to_owned();
                if specifier == crate::script::RUNTIME {
                    for item in import.specifiers.iter().flatten() {
                        if let ImportDeclarationSpecifier::ImportSpecifier(named) = item {
                            if named.imported.name().as_str() == "from" {
                                from_names.push(named.local.name.to_string());
                            }
                            if named.imported.name().as_str() == "emit" {
                                return Err(error_at(
                                    source,
                                    named.span.start,
                                    "a JSX component fires events by calling its `on…` props, not emit()",
                                )
                                .with_help("add `onPick` to the parameters and call `onPick(detail)`"));
                            }
                        }
                    }
                }
                let mut side_effect = false;
                if crate::components::is_component(&specifier) {
                    for item in import.specifiers.iter().flatten() {
                        if let ImportDeclarationSpecifier::ImportDefaultSpecifier(default) = item {
                            components.insert(
                                default.local.name.to_string(),
                                (specifier.clone(), import.source.span.start),
                            );
                        }
                    }
                    // Used only as tags, the binding would look unused (and TypeScript drops
                    // unused imports): import the component for its side effect instead.
                    let specifiers = import.specifiers.as_ref().map(|items| items.as_slice());
                    if let Some([ImportDeclarationSpecifier::ImportDefaultSpecifier(default)]) =
                        specifiers
                    {
                        side_effect = scoping
                            .get_resolved_references(default.local.symbol_id())
                            .all(|reference| {
                                matches!(
                                    semantic.nodes().parent_kind(reference.node_id()),
                                    oxc_ast::AstKind::JSXOpeningElement(_)
                                        | oxc_ast::AstKind::JSXClosingElement(_)
                                )
                            });
                    }
                }
                imports.push((
                    span.start as usize..span.end as usize,
                    side_effect.then(|| {
                        format!(
                            "import {};",
                            serde_json::to_string(&specifier).unwrap_or_default()
                        )
                    }),
                ));
            }
            Statement::ExportDefaultDeclaration(export) => {
                let ExportDefaultDeclarationKind::FunctionDeclaration(declared) =
                    &export.declaration
                else {
                    return Err(error_at(
                        source,
                        export.span.start,
                        "the default export must be the component, as a named function: `export default function MnxCard(…) {…}`",
                    ));
                };
                export_start = export.span.start;
                function = Some(&**declared);
            }
            Statement::FunctionDeclaration(_)
            | Statement::TSTypeAliasDeclaration(_)
            | Statement::TSInterfaceDeclaration(_) => {
                helpers.push(span.start as usize..span.end as usize);
            }
            Statement::VariableDeclaration(declaration)
                if declaration.kind == VariableDeclarationKind::Const =>
            {
                helpers.push(span.start as usize..span.end as usize);
            }
            Statement::VariableDeclaration(declaration) => {
                return Err(error_at(
                    source,
                    declaration.span.start,
                    "module-level `let` would be shared by every element; declare state inside the component function",
                ));
            }
            Statement::EmptyStatement(_) => {}
            Statement::ExportNamedDeclaration(_) | Statement::ExportAllDeclaration(_) => {
                return Err(error_at(
                    source,
                    span.start,
                    "a JSX component file exports only its component; move shared code to a module and import it",
                ));
            }
            _ => {
                return Err(error_at(
                    source,
                    span.start,
                    "only imports, functions, constants and types can be at the top of a JSX component file",
                ));
            }
        }
    }
    let Some(function) = function else {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            "a JSX component file default-exports its component: `export default function MnxCard(…) {…}`",
        ));
    };
    let Some(id) = &function.id else {
        return Err(error_at(
            source,
            function.span.start,
            "name the component function: its name is the tag (`MnxCard` → <mnx-card>)",
        ));
    };
    let name = id.name.as_str();
    let tag = tag_of(name);
    if !tag.contains('-') {
        return Err(error_at(
            source,
            id.span.start,
            format!("`{name}` would be <{tag}>, but a custom element's name needs a hyphen"),
        )
        .with_help(format!("name it with two words, e.g. `Mnx{name}`")));
    }
    if function.r#async || function.generator {
        return Err(error_at(
            source,
            function.span.start,
            "a component function can't be async or a generator: it runs once to set up the element",
        ));
    }

    let mut lowering = Lowering {
        source,
        path,
        scoping,
        symbols: HashMap::new(),
        components,
        loader,
        tags: HashMap::new(),
        props: Vec::new(),
        from: from_names,
        readable,
    };
    lowering.parameters(function)?;
    let body = function
        .body
        .as_ref()
        .expect("a function declaration has a body");
    let (statements, returned) = match body.statements.split_last() {
        Some((Statement::ReturnStatement(last), rest)) => (rest, last.argument.as_ref()),
        _ => {
            return Err(error_at(
                source,
                body.span.end.saturating_sub(1),
                "a component function ends with `return` and its JSX",
            ))
        }
    };
    let mut returns = Returns(Vec::new(), 0);
    for statement in statements {
        returns.visit_statement(statement);
    }
    if let Some(&at) = returns.0.first() {
        return Err(error_at(
            source,
            at,
            "a component function returns once, at the end; use conditionals in the returned JSX",
        ));
    }
    lowering.classify(statements)?;

    let mut out = Out::default();
    // The description: a /** … */ comment right above the component.
    if let Some(comment) = program
        .comments
        .iter()
        .filter(|comment| comment.span.end <= export_start && comment.is_jsdoc())
        .last()
    {
        let text = &source[comment.span.start as usize + 3..comment.span.end as usize - 2];
        let text: Vec<&str> = text
            .lines()
            .map(|line| {
                let line = line.trim();
                line.strip_prefix("* ")
                    .or(line.strip_prefix('*'))
                    .unwrap_or(line)
            })
            .collect();
        let text = text.join("\n");
        if text.contains("-->") {
            return Err(error_at(
                source,
                comment.span.start,
                "the description can't contain `-->`",
            ));
        }
        out.synthetic(
            &format!("<!--\n{}\n-->\n", text.trim()),
            comment.span.start as usize,
        );
    }

    // The script.
    let typescript = path.ends_with(".tsx");
    out.synthetic(
        if typescript {
            "<script lang=\"ts\">\n"
        } else {
            "<script>\n"
        },
        0,
    );
    if readable {
        let emits = lowering
            .symbols
            .values()
            .any(|kind| matches!(kind, Kind::Callback(_)));
        if emits {
            out.synthetic("import { emit } from '@mnx/runtime';\n", 0);
        }
    } else {
        out.synthetic(
            &format!("import {{ state as {STATE}, computed as {COMPUTED}, emit as {EMIT} }} from \"@mnx/runtime\";\n"),
            0,
        );
        out.synthetic(HELPERS, 0);
    }
    for (range, replacement) in &imports {
        match replacement {
            Some(text) => out.synthetic(text, range.start),
            None => out.original(source, range.clone()),
        }
        out.synthetic("\n", range.end);
    }
    for range in &helpers {
        out.original(source, range.clone());
        out.synthetic("\n", range.end);
    }
    for statement in statements {
        let edits = lowering.rewrite_statement(statement, Context::Script)?;
        lowering.copy(
            &mut out,
            statement.span().start as usize..statement.span().end as usize,
            edits,
        );
        out.synthetic("\n", statement.span().end as usize);
    }
    out.synthetic("</script>\n", function.span.start as usize);

    // The host and the template.
    let returned = returned.map(strip_parentheses);
    let (host_flags, template) = match returned {
        Some(Expression::JSXElement(element))
            if element_name(&element.opening_element.name).as_deref() == Some(&tag) =>
        {
            let mut flags = Vec::new();
            for attribute in &element.opening_element.attributes {
                match attribute {
                    JSXAttributeItem::Attribute(attribute) if attribute.value.is_none() => {
                        let name = attribute_name(&attribute.name);
                        if name != "shadow" && name != "form-associated" && name != "formAssociated"
                        {
                            return Err(error_at(source, attribute.span.start, format!("`{name}` on the host: the host takes `shadow` and `form-associated`; props are the function's parameters")));
                        }
                        flags.push(if name == "formAssociated" {
                            "form-associated".to_owned()
                        } else {
                            name
                        });
                    }
                    _ => {
                        return Err(error_at(source, attribute.span().start, "the host takes `shadow` and `form-associated`; props are the function's parameters"));
                    }
                }
            }
            (flags, Template::Children(&element.children))
        }
        Some(expression) => (Vec::new(), Template::Expression(expression)),
        None => (Vec::new(), Template::Empty),
    };
    out.synthetic(&format!("<{tag}"), id.span.start as usize);
    for flag in &host_flags {
        out.synthetic(&format!(" {flag}"), id.span.start as usize);
    }
    for prop in std::mem::take(&mut lowering.props) {
        out.synthetic(
            &format!(
                " {}{}",
                kebab(&prop.name),
                if prop.model { ":model" } else { "" }
            ),
            prop.at as usize,
        );
        if let Some(default) = prop.default {
            out.synthetic("={", default.start);
            let edits = prop.edits;
            lowering.copy(&mut out, default, edits);
            out.synthetic("}", prop.at as usize);
        }
    }
    out.synthetic(">", id.span.start as usize);
    if readable {
        // On its own line, with the indentation it has in the JSX, so the template dedents evenly.
        let start = match &template {
            Template::Children(children) => children.first().map(|child| child.span().start),
            Template::Expression(expression) => Some(expression.span().start),
            Template::Empty => None,
        };
        let indent = start.map_or(2, |start| {
            let line_start = source[..start as usize].rfind('\n').map_or(0, |at| at + 1);
            let lead = &source[line_start..start as usize];
            if lead.trim().is_empty() {
                lead.len()
            } else {
                2
            }
        });
        if !matches!(template, Template::Children(_)) {
            out.synthetic(&format!("\n{}", " ".repeat(indent)), id.span.start as usize);
        }
    }
    match template {
        Template::Children(children) => lowering.children(&mut out, children)?,
        Template::Expression(expression) => lowering.node(&mut out, expression)?,
        Template::Empty => {}
    }
    if readable {
        out.synthetic("\n", function.span.end as usize);
    }
    out.synthetic(&format!("</{tag}>\n"), function.span.end as usize);
    Ok(Lowered {
        text: out.text,
        map: out.map,
    })
}

enum Template<'b, 'a> {
    Children(&'b oxc_allocator::Vec<'a, JSXChild<'a>>),
    Expression(&'b Expression<'a>),
    Empty,
}

/// `return` statements outside nested functions.
struct Returns(Vec<u32>, usize);

impl<'a> Visit<'a> for Returns {
    fn visit_return_statement(&mut self, statement: &oxc_ast::ast::ReturnStatement<'a>) {
        if self.1 == 0 {
            self.0.push(statement.span.start);
        }
    }
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        self.1 += 1;
        walk::walk_function(self, function, flags);
        self.1 -= 1;
    }
    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        self.1 += 1;
        walk::walk_arrow_function_expression(self, arrow);
        self.1 -= 1;
    }
}

fn strip_parentheses<'b, 'a>(mut expression: &'b Expression<'a>) -> &'b Expression<'a> {
    while let Expression::ParenthesizedExpression(inner) = expression {
        expression = &inner.expression;
    }
    expression
}

fn element_name(name: &JSXElementName<'_>) -> Option<String> {
    match name {
        JSXElementName::Identifier(identifier) => Some(identifier.name.to_string()),
        JSXElementName::IdentifierReference(identifier) => Some(identifier.name.to_string()),
        JSXElementName::NamespacedName(name) => {
            Some(format!("{}:{}", name.namespace.name, name.name.name))
        }
        _ => None,
    }
}

fn attribute_name(name: &JSXAttributeName<'_>) -> String {
    match name {
        JSXAttributeName::Identifier(identifier) => identifier.name.to_string(),
        JSXAttributeName::NamespacedName(name) => {
            format!("{}:{}", name.namespace.name, name.name.name)
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Context {
    Script,
    Template,
}

struct PropOut {
    name: String,
    at: u32,
    default: Option<Range<usize>>,
    /// `value = model(0)`: a two-way prop.
    model: bool,
    edits: Vec<Edit>,
}

struct Lowering<'s, 'l> {
    source: &'s str,
    path: &'s str,
    scoping: &'s Scoping,
    symbols: HashMap<SymbolId, Kind>,
    components: HashMap<String, (String, u32)>,
    loader: Option<Loader<'l>>,
    tags: HashMap<String, String>,
    props: Vec<PropOut>,
    /// The local names of the runtime's `from` (`let left = from(seconds)`).
    from: Vec<String>,
    /// `lower_readable`: keep the script as written, apart from `on…` calls, and the template's
    /// whitespace.
    readable: bool,
}

impl Lowering<'_, '_> {
    fn error(&self, offset: u32, message: impl Into<String>) -> Diagnostic {
        error_at(self.source, offset, message)
    }

    fn kind_of(&self, identifier: &IdentifierReference<'_>) -> Option<&Kind> {
        let reference = self.scoping.get_reference(identifier.reference_id());
        reference
            .symbol_id()
            .and_then(|symbol| self.symbols.get(&symbol))
    }

    /// The destructured parameter: props, callbacks and `children`.
    fn parameters(&mut self, function: &Function<'_>) -> Result<(), Diagnostic> {
        let parameters = &function.params;
        if let Some(rest) = &parameters.rest {
            return Err(self.error(
                rest.span.start,
                "a component takes one parameter: its destructured props",
            ));
        }
        let pattern = match parameters.items.as_slice() {
            [] => return Ok(()),
            [parameter] => &parameter.pattern,
            [_, second, ..] => {
                return Err(self.error(
                    second.span.start,
                    "a component takes one parameter: its destructured props",
                ))
            }
        };
        let BindingPattern::ObjectPattern(object) = pattern else {
            return Err(self
                .error(
                    pattern.span().start,
                    "destructure the props in the parameter list",
                )
                .with_help("e.g. `function MnxCard({ heading = \"Hi\", open = false }) {…}`"));
        };
        if let Some(rest) = &object.rest {
            return Err(self.error(
                rest.span.start,
                "`...rest` props aren't supported; name each prop",
            ));
        }
        for property in &object.properties {
            let PropertyKey::StaticIdentifier(key) = &property.key else {
                return Err(self.error(property.span.start, "prop names must be plain identifiers"));
            };
            let name = key.name.to_string();
            let (binding, default) = match &property.value {
                BindingPattern::BindingIdentifier(identifier) => (identifier, None),
                BindingPattern::AssignmentPattern(assignment) => match &assignment.left {
                    BindingPattern::BindingIdentifier(identifier) => {
                        (identifier, Some(&assignment.right))
                    }
                    _ => {
                        return Err(self.error(
                            property.span.start,
                            "destructure a prop's value inside the function",
                        ))
                    }
                },
                _ => {
                    return Err(self.error(
                        property.span.start,
                        "destructure a prop's value inside the function",
                    ))
                }
            };
            if binding.name.as_str() != name {
                return Err(self.error(
                    property.span.start,
                    format!("renaming the prop `{name}` isn't supported; use its own name"),
                ));
            }
            let symbol = binding.symbol_id();
            if name == "children" {
                if default.is_some() {
                    return Err(self.error(property.span.start, "`children` is the default slot; put fallback content in <mnx-slot> instead of a default"));
                }
                self.symbols.insert(symbol, Kind::Children);
                continue;
            }
            if let Some(event) = event_of(&name) {
                if default.is_some() {
                    return Err(self.error(
                        property.span.start,
                        format!("`{name}` is the `{event}` event; it can't have a default"),
                    ));
                }
                self.symbols.insert(symbol, Kind::Callback(event));
                continue;
            }
            self.symbols.insert(symbol, Kind::Prop(name.clone()));
            // `value = model(0)`: two-way, with `0` as the default.
            let (default, model) = match default {
                Some(Expression::CallExpression(call))
                    if matches!(&call.callee, Expression::Identifier(callee) if callee.name == "model")
                        && call.arguments.len() == 1 =>
                {
                    (call.arguments[0].as_expression(), true)
                }
                other => (other, false),
            };
            self.props.push(PropOut {
                name,
                at: property.span.start,
                default: default
                    .map(|default| default.span().start as usize..default.span().end as usize),
                model,
                edits: Vec::new(),
            });
        }
        Ok(())
    }

    /// Top-level `let` is state; a top-level `const` that reads props or state is derived.
    fn classify(&mut self, statements: &[Statement<'_>]) -> Result<(), Diagnostic> {
        for statement in statements {
            let Statement::VariableDeclaration(declaration) = statement else {
                continue;
            };
            for declarator in &declaration.declarations {
                match declaration.kind {
                    VariableDeclarationKind::Let => match &declarator.id {
                        BindingPattern::BindingIdentifier(identifier) => {
                            self.symbols.insert(identifier.symbol_id(), Kind::State);
                        }
                        _ => {
                            return Err(self.error(
                                declarator.span.start,
                                "state is one name per `let`; destructure when you read it",
                            ))
                        }
                    },
                    VariableDeclarationKind::Const => {
                        let Some(init) = &declarator.init else {
                            continue;
                        };
                        let names = JsxNames {
                            lowering: self,
                            context: Context::Script,
                        };
                        if !reactive::reads_reactive(&names, init) {
                            continue;
                        }
                        match &declarator.id {
                            BindingPattern::BindingIdentifier(identifier) => {
                                self.symbols.insert(identifier.symbol_id(), Kind::Derived);
                            }
                            _ => return Err(self.error(declarator.span.start, "a value derived from props or state is one name per `const`; destructure it where you use it")),
                        }
                    }
                    _ => {
                        return Err(self.error(
                            declaration.span.start,
                            "use `let` (state) or `const` in a component function",
                        ))
                    }
                }
            }
        }
        Ok(())
    }

    /// The edits that make `statement` script code.
    fn rewrite_statement(
        &self,
        statement: &Statement<'_>,
        context: Context,
    ) -> Result<Vec<Edit>, Diagnostic> {
        let names = JsxNames {
            lowering: self,
            context,
        };
        reactive::rewrite_statement_with(
            &names,
            statement,
            &|id| {
                matches!(id, BindingPattern::BindingIdentifier(identifier)
                    if self.symbols.get(&identifier.symbol_id()) == Some(&Kind::Derived))
            },
            !self.readable,
        )
    }

    fn rewrite_expression(
        &self,
        expression: &Expression<'_>,
        context: Context,
    ) -> Result<Vec<Edit>, Diagnostic> {
        let names = JsxNames {
            lowering: self,
            context,
        };
        reactive::rewrite_expression(&names, expression)
    }

    /// Copy `range` of the source to `out`, applying `edits`.
    fn copy(&self, out: &mut Out, range: Range<usize>, mut edits: Vec<Edit>) {
        edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
        let mut at = range.start;
        for edit in edits {
            if edit.range.start < at {
                continue; // overlapping (a nested edit inside a replaced range)
            }
            out.original(self.source, at..edit.range.start);
            out.synthetic(&edit.text, edit.range.start);
            at = edit.range.end;
        }
        out.original(self.source, at..range.end);
    }

    /// An expression in the template: `{…}` text, or (JSX, conditionals, lists) markup.
    fn node(&mut self, out: &mut Out, expression: &Expression<'_>) -> Result<(), Diagnostic> {
        let expression = strip_parentheses(expression);
        match expression {
            Expression::JSXElement(element) => self.element(out, element),
            Expression::JSXFragment(fragment) => self.children(out, &fragment.children),
            Expression::NullLiteral(_) => Ok(()),
            Expression::BooleanLiteral(literal) if !literal.value => Ok(()),
            Expression::Identifier(identifier) if identifier.name == "undefined" => Ok(()),
            Expression::Identifier(identifier)
                if self.kind_of(identifier) == Some(&Kind::Children) =>
            {
                out.synthetic("<mnx-slot></mnx-slot>", identifier.span.start as usize);
                Ok(())
            }
            Expression::LogicalExpression(logical)
                if logical.operator == oxc_syntax::operator::LogicalOperator::And
                    && self.is_markup(&logical.right) =>
            {
                self.directive_if(out, &logical.left, &logical.right, None, logical.span.start)
            }
            Expression::ConditionalExpression(conditional)
                if self.is_markup(&conditional.consequent)
                    || self.is_markup(&conditional.alternate) =>
            {
                self.directive_if(
                    out,
                    &conditional.test,
                    &conditional.consequent,
                    Some(&conditional.alternate),
                    conditional.span.start,
                )
            }
            Expression::CallExpression(call) if self.list(call).is_some() => {
                self.directive_each(out, call)
            }
            _ => {
                if let Some(at) = contains_jsx(expression) {
                    return Err(self.error(at, "JSX can be returned, in `&&` / `? :` branches and in `.map()` callbacks; not inside other expressions"));
                }
                self.expression(out, expression, "{", "}")
            }
        }
    }

    /// `{expression}` (with `open` and `close` around it).
    fn expression(
        &self,
        out: &mut Out,
        expression: &Expression<'_>,
        open: &str,
        close: &str,
    ) -> Result<(), Diagnostic> {
        let span = expression.span();
        let edits = self.rewrite_expression(expression, Context::Template)?;
        // Errors about the expression point at its `{`, as in an .mnx file.
        let before = self.source[..span.start as usize].trim_end();
        let brace = if before.ends_with('{') {
            before.len() - 1
        } else {
            span.start as usize
        };
        out.synthetic(open, brace);
        self.copy(out, span.start as usize..span.end as usize, edits);
        out.synthetic(close, span.end as usize);
        Ok(())
    }

    /// Whether an expression is markup (JSX, a list of it, a conditional of it, `children`).
    fn is_markup(&self, expression: &Expression<'_>) -> bool {
        match strip_parentheses(expression) {
            Expression::JSXElement(_) | Expression::JSXFragment(_) | Expression::NullLiteral(_) => {
                true
            }
            Expression::Identifier(identifier) => self.kind_of(identifier) == Some(&Kind::Children),
            Expression::LogicalExpression(logical) => {
                logical.operator == oxc_syntax::operator::LogicalOperator::And
                    && self.is_markup(&logical.right)
            }
            Expression::ConditionalExpression(conditional) => {
                self.is_markup(&conditional.consequent) || self.is_markup(&conditional.alternate)
            }
            Expression::CallExpression(call) => self.list(call).is_some(),
            _ => false,
        }
    }

    fn directive_if(
        &mut self,
        out: &mut Out,
        test: &Expression<'_>,
        consequent: &Expression<'_>,
        alternate: Option<&Expression<'_>>,
        at: u32,
    ) -> Result<(), Diagnostic> {
        out.synthetic("<mnx-if test=", at as usize);
        self.expression(out, test, "{", "}")?;
        out.synthetic(">", at as usize);
        self.branch(out, consequent)?;
        if let Some(alternate) = alternate {
            out.synthetic("<mnx-else>", alternate.span().start as usize);
            self.branch(out, alternate)?;
            out.synthetic("</mnx-else>", alternate.span().end as usize);
        }
        out.synthetic("</mnx-if>", at as usize);
        Ok(())
    }

    /// A conditional's branch: markup, or a value shown as text.
    fn branch(&mut self, out: &mut Out, expression: &Expression<'_>) -> Result<(), Diagnostic> {
        if self.is_markup(expression) {
            self.node(out, expression)
        } else {
            self.expression(out, expression, "{", "}")
        }
    }

    /// `list.map((item, i) => <markup>)`: the list, the item and index names, and the markup.
    fn list<'b, 'a>(
        &self,
        call: &'b CallExpression<'a>,
    ) -> Option<(&'b Expression<'a>, &'b ArrowFunctionExpression<'a>)> {
        let Expression::StaticMemberExpression(member) = &call.callee else {
            return None;
        };
        if member.property.name.as_str() != "map" || call.arguments.len() != 1 {
            return None;
        }
        let Argument::ArrowFunctionExpression(arrow) = &call.arguments[0] else {
            return None;
        };
        let body = arrow_result(arrow)?;
        self.is_markup(body).then_some((&member.object, &**arrow))
    }

    fn directive_each(
        &mut self,
        out: &mut Out,
        call: &CallExpression<'_>,
    ) -> Result<(), Diagnostic> {
        let (items, arrow) = self.list(call).expect("checked by the caller");
        let mut names = Vec::new();
        for parameter in &arrow.params.items {
            match &parameter.pattern {
                BindingPattern::BindingIdentifier(identifier) => names.push(identifier.name.to_string()),
                _ => return Err(self.error(parameter.span.start, "a list callback takes the item (and its index) as plain names; destructure inside")),
            }
        }
        if names.is_empty() || names.len() > 2 {
            return Err(self.error(
                arrow.span.start,
                "a list callback takes the item and, optionally, its index: `(item, i) => …`",
            ));
        }
        let body = strip_parentheses(arrow_result(arrow).expect("checked by list()"));
        out.synthetic("<mnx-each items=", call.span.start as usize);
        self.expression(out, items, "{", "}")?;
        out.synthetic(&format!(" as=\"{}\"", names[0]), arrow.span.start as usize);
        if let Some(index) = names.get(1) {
            out.synthetic(&format!(" index=\"{index}\""), arrow.span.start as usize);
        }
        // The key: on the row's root element.
        let mut keyed = None;
        if let Expression::JSXElement(element) = body {
            for attribute in &element.opening_element.attributes {
                if let JSXAttributeItem::Attribute(attribute) = attribute {
                    if attribute_name(&attribute.name) == "key" {
                        match &attribute.value {
                            Some(JSXAttributeValue::ExpressionContainer(container)) => {
                                if let Some(expression) = container.expression.as_expression() {
                                    keyed = Some(expression);
                                }
                            }
                            _ => {
                                return Err(self.error(
                                    attribute.span.start,
                                    "`key` takes an expression: key={item.id}",
                                ))
                            }
                        }
                    }
                }
            }
        }
        if let Some(key) = keyed {
            out.synthetic(" key=", key.span().start as usize);
            self.expression(out, key, "{", "}")?;
        }
        out.synthetic(">", call.span.start as usize);
        self.node(out, body)?;
        out.synthetic("</mnx-each>", call.span.end as usize);
        Ok(())
    }

    fn children(
        &mut self,
        out: &mut Out,
        children: &oxc_allocator::Vec<'_, JSXChild<'_>>,
    ) -> Result<(), Diagnostic> {
        for child in children {
            match child {
                JSXChild::Text(text) => {
                    let raw = text
                        .raw
                        .as_ref()
                        .map_or(text.value.as_str(), |raw| raw.as_str());
                    if self.readable {
                        out.synthetic(raw, text.span.start as usize);
                    } else {
                        out.synthetic(&clean_text(raw), text.span.start as usize);
                    }
                }
                JSXChild::Element(element) => self.element(out, element)?,
                JSXChild::Fragment(fragment) => self.children(out, &fragment.children)?,
                JSXChild::ExpressionContainer(container) => {
                    if let Some(expression) = container.expression.as_expression() {
                        self.node(out, expression)?;
                    }
                }
                JSXChild::Spread(spread) => {
                    return Err(self.error(
                        spread.span.start,
                        "`{...children}` isn't supported; render the list with .map()",
                    ));
                }
            }
        }
        Ok(())
    }

    fn element(&mut self, out: &mut Out, element: &JSXElement<'_>) -> Result<(), Diagnostic> {
        let opening = &element.opening_element;
        let at = opening.span.start as usize;
        let Some(name) = element_name(&opening.name) else {
            return Err(self.error(opening.span.start, "member expressions as tags (`<a.B>`) aren't supported; import the component and use its name"));
        };
        let tag = if name.starts_with(|character: char| character.is_ascii_uppercase()) {
            self.component_tag(&name, opening.span.start)?
        } else {
            name
        };
        out.synthetic(&format!("<{tag}"), at);
        for attribute in &opening.attributes {
            let attribute = match attribute {
                JSXAttributeItem::Attribute(attribute) => attribute,
                JSXAttributeItem::SpreadAttribute(spread) => {
                    return Err(self.error(
                        spread.span.start,
                        "spread attributes aren't supported; pass each prop",
                    ));
                }
            };
            let mut name = attribute_name(&attribute.name);
            match name.as_str() {
                "key" => continue, // a list row's key (see directive_each)
                "className" => name = "class".to_owned(),
                "htmlFor" => name = "for".to_owned(),
                _ if event_of(&name).is_some() => name = name.to_ascii_lowercase(),
                _ => {}
            }
            let start = attribute.span.start as usize;
            match &attribute.value {
                None => out.synthetic(&format!(" {name}"), start),
                Some(JSXAttributeValue::StringLiteral(literal)) => {
                    let raw = &self.source
                        [literal.span.start as usize + 1..literal.span.end as usize - 1];
                    if raw.contains(['{', '}', '"']) {
                        // Braces would be interpolation in an mnx attribute: pass the string as a value.
                        let value = literal.value.as_str().unwrap_or_default();
                        out.synthetic(
                            &format!(
                                " {name}={{{}}}",
                                serde_json::to_string(value).unwrap_or_default()
                            ),
                            start,
                        );
                    } else {
                        out.synthetic(&format!(" {name}=\""), start);
                        out.original(
                            self.source,
                            literal.span.start as usize + 1..literal.span.end as usize - 1,
                        );
                        out.synthetic("\"", literal.span.end as usize);
                    }
                }
                Some(JSXAttributeValue::ExpressionContainer(container)) => {
                    match &container.expression {
                        JSXExpression::EmptyExpression(_) => {}
                        expression => {
                            let expression = expression.as_expression().expect("not empty");
                            if let Some(jsx) = contains_jsx(expression) {
                                return Err(self.error(jsx, "JSX in an attribute (a render prop) isn't supported; use a named slot"));
                            }
                            if let (true, Expression::Identifier(identifier)) =
                                (name == "ref", expression)
                            {
                                // `ref={box}` names the variable to assign, not a value to read.
                                if self.readable {
                                    out.synthetic(&format!(" ref={{{}}}", identifier.name), start);
                                    continue;
                                }
                                let assign = match self.kind_of(identifier) {
                                    Some(Kind::State) => format!(
                                        "($el) => {}({}, $el)",
                                        reactive::ASSIGN,
                                        identifier.name
                                    ),
                                    _ => format!("($el) => ({} = $el)", identifier.name),
                                };
                                out.synthetic(&format!(" ref={{{assign}}}"), start);
                                continue;
                            }
                            out.synthetic(&format!(" {name}="), start);
                            self.expression(out, expression, "{", "}")?;
                        }
                    }
                }
                Some(_) => {
                    return Err(self.error(
                        attribute.span.start,
                        "JSX in an attribute (a render prop) isn't supported; use a named slot",
                    ))
                }
            }
        }
        out.synthetic(">", at);
        let void = VOID_ELEMENTS.contains(&tag.as_str());
        if void {
            if !element.children.is_empty() {
                return Err(self.error(opening.span.start, format!("<{tag}> can't have children")));
            }
            return Ok(());
        }
        self.children(out, &element.children)?;
        out.synthetic(&format!("</{tag}>"), element.span.end as usize);
        Ok(())
    }

    /// `<Badge />`: the tag of the component imported as `Badge`.
    fn component_tag(&mut self, name: &str, at: u32) -> Result<String, Diagnostic> {
        if let Some(tag) = self.tags.get(name) {
            return Ok(tag.clone());
        }
        let Some((specifier, import_at)) = self.components.get(name).cloned() else {
            return Err(self
                .error(at, format!("<{name}> isn't an imported component"))
                .with_help(format!(
                    "import it: `import {name} from './{}.mnx'`",
                    kebab(name).trim_start_matches('-')
                )));
        };
        let Some(loader) = self.loader else {
            // Without files (typings, the manifest), only this component's interface matters;
            // compiling its markup still needs the import (see `components::load`).
            let _ = import_at;
            return Ok(format!(
                "mnx-unresolved-{}",
                kebab(name).trim_start_matches('-')
            ));
        };
        let (child_path, child_source) = loader(&specifier, self.path).map_err(|message| {
            self.error(import_at, format!("can't load `{specifier}`: {message}"))
        })?;
        let tag = if is_jsx(&child_path) {
            tag_in(&child_source, &child_path)
                .map_err(|error| error.in_file(&child_path, &child_source))?
        } else {
            crate::parser::parse(&child_source)
                .map_err(|error| error.in_file(&child_path, &child_source))?
                .tag
        };
        self.tags.insert(name.to_owned(), tag.clone());
        Ok(tag)
    }
}

/// An arrow function's result: its expression body, or its body's single `return`.
fn arrow_result<'b, 'a>(arrow: &'b ArrowFunctionExpression<'a>) -> Option<&'b Expression<'a>> {
    if let Some(expression) = arrow.get_expression() {
        return Some(expression);
    }
    match arrow.get_function_body()?.statements.as_slice() {
        [Statement::ReturnStatement(statement)] => statement.argument.as_ref(),
        _ => None,
    }
}

/// Where JSX is inside `expression`, if anywhere.
fn contains_jsx(expression: &Expression<'_>) -> Option<u32> {
    struct Finder(Option<u32>);
    impl<'a> Visit<'a> for Finder {
        fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
            self.0.get_or_insert(element.span.start);
        }
        fn visit_jsx_fragment(&mut self, fragment: &oxc_ast::ast::JSXFragment<'a>) {
            self.0.get_or_insert(fragment.span.start);
        }
    }
    let mut finder = Finder(None);
    finder.visit_expression(expression);
    finder.0
}

/// JSX's whitespace rule for text: lines are trimmed, and line breaks between them become one
/// space unless the line is empty.
fn clean_text(raw: &str) -> String {
    let lines: Vec<&str> = raw.split('\n').collect();
    let last_non_empty = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .or(Some(0));
    let mut out = String::new();
    for (index, line) in lines.iter().enumerate() {
        let mut line = line.replace('\t', " ").replace('\r', "");
        if index != 0 {
            line = line.trim_start_matches(' ').to_owned();
        }
        if index != lines.len() - 1 {
            line = line.trim_end_matches(' ').to_owned();
        }
        if !line.is_empty() {
            out.push_str(&line);
            if Some(index) != last_non_empty {
                out.push(' ');
            }
        }
    }
    out
}

/// What names are, for the shared rewriter: from the component's symbols.
struct JsxNames<'r, 's, 'l> {
    lowering: &'r Lowering<'s, 'l>,
    context: Context,
}

impl reactive::Names for JsxNames<'_, '_, '_> {
    fn kind(&self, identifier: &IdentifierReference<'_>) -> Option<Kind> {
        let kind = self.lowering.kind_of(identifier).cloned();
        if self.lowering.readable {
            // Readable output keeps `let`, props and derived consts as written; only `on…`
            // calls become `emit()`.
            kind.filter(|kind| matches!(kind, Kind::Callback(_)))
        } else {
            kind
        }
    }
    fn is_write(&self, identifier: &IdentifierReference<'_>) -> bool {
        self.lowering
            .scoping
            .get_reference(identifier.reference_id())
            .is_write()
    }
    fn source(&self) -> &str {
        self.lowering.source
    }
    fn error(&self, offset: u32, message: String) -> Diagnostic {
        self.lowering.error(offset, message)
    }
    fn in_script(&self) -> bool {
        self.context == Context::Script
    }
    fn is_from(&self, name: &str) -> bool {
        self.lowering.from.iter().any(|from| from == name)
    }
}
