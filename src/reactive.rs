//! Component code as script code: what both front ends do to a component's names.
//!
//! - a prop's name is the prop: `value` becomes `$p.value` in the script (read and write);
//! - a top-level `let` is state: `let n = 0` becomes `const n = state(0)`, reads become
//!   `n.get()`, and assignments set it;
//! - a top-level `const` that reads props or state (outside nested functions) is derived:
//!   `const d = n * 2` becomes `const d = computed(() => (n.get() * 2))`, read with `.get()`;
//! - in JSX, calling an `on<Name>` parameter fires the event: `onPick(x)` becomes
//!   `emit("pick", x)`.
//!
//! Each front end says what a name is ([`Names`]); the rewriting is the same.

use oxc_ast::ast::{
    ArrowFunctionExpression, AssignmentExpression, AssignmentOperator, AssignmentTarget,
    BindingPattern, CallExpression, Expression, Function, IdentifierReference, ObjectProperty,
    SimpleAssignmentTarget, Statement, UpdateExpression, UpdateOperator, VariableDeclarationKind,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use oxc_syntax::scope::ScopeFlags;

use crate::diagnostic::Diagnostic;

pub const STATE: &str = "__mnxState";
pub const COMPUTED: &str = "__mnxComputed";
pub const EMIT: &str = "__mnxEmit";
pub const ASSIGN: &str = "__mnxAssign";
pub const UPDATE: &str = "__mnxUpdate";

/// Assignments to state as expressions: `x = v` is `__mnxAssign(x, v)` (calls, so no line of
/// the output starts with a parenthesis that could join the previous statement).
pub const HELPERS: &str = "function __mnxAssign(signal, value) { signal.set(value); return value }\nfunction __mnxUpdate(signal, delta, prefix) { const old = signal.get(); signal.set(old + delta); return prefix ? old + delta : old }\n";

/// What a component-level name is.
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Prop(String),
    State,
    Derived,
    /// A JSX `on<Name>` parameter, with its event name.
    Callback(String),
    /// JSX `children`.
    Children,
}

/// What the names in some code are, for one front end.
pub trait Names {
    fn kind(&self, identifier: &IdentifierReference<'_>) -> Option<Kind>;
    fn is_write(&self, identifier: &IdentifierReference<'_>) -> bool;
    /// The text the AST's offsets index.
    fn source(&self) -> &str;
    fn error(&self, offset: u32, message: String) -> Diagnostic;
    /// In script code, props are read through `$p`; in templates, the template maps them.
    fn in_script(&self) -> bool;
}

/// A replacement of `range` (empty for an insertion) in the source.
#[derive(Clone, Debug)]
pub struct Edit {
    pub range: std::ops::Range<usize>,
    pub text: String,
}

/// `source[range]` with `edits` applied (edits inside a replaced range are skipped).
pub fn apply(source: &str, range: std::ops::Range<usize>, mut edits: Vec<Edit>) -> String {
    edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
    let mut out = String::new();
    let mut at = range.start;
    for edit in edits {
        if edit.range.start < at {
            continue;
        }
        out.push_str(&source[at..edit.range.start]);
        out.push_str(&edit.text);
        at = edit.range.end;
    }
    out.push_str(&source[at..range.end]);
    out
}

/// Whether `expression` reads props, state or derived values outside nested functions (so a
/// `const` initialized by it is derived).
pub fn reads_reactive(names: &impl Names, expression: &Expression<'_>) -> bool {
    let mut reads = ReactiveReads {
        names,
        depth: 0,
        found: false,
    };
    reads.visit_expression(expression);
    reads.found
}

struct ReactiveReads<'n, N: Names> {
    names: &'n N,
    depth: usize,
    found: bool,
}

impl<'a, N: Names> Visit<'a> for ReactiveReads<'_, N> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if self.depth == 0
            && matches!(
                self.names.kind(identifier),
                Some(Kind::Prop(_) | Kind::State | Kind::Derived)
            )
        {
            self.found = true;
        }
    }
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        self.depth += 1;
        walk::walk_function(self, function, flags);
        self.depth -= 1;
    }
    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        self.depth += 1;
        walk::walk_arrow_function_expression(self, arrow);
        self.depth -= 1;
    }
}

/// The edits that make a top-level `statement` script code. `derived(declarator id)` says
/// whether a `const` is derived.
pub fn rewrite_statement(
    names: &impl Names,
    statement: &Statement<'_>,
    derived: &dyn Fn(&BindingPattern<'_>) -> bool,
) -> Result<Vec<Edit>, Diagnostic> {
    let mut rewriter = Rewriter::new(names);
    if let Statement::VariableDeclaration(declaration) = statement {
        let start = declaration.span.start as usize;
        match declaration.kind {
            VariableDeclarationKind::Let => {
                rewriter.edits.push(Edit {
                    range: start..start + 3,
                    text: "const".to_owned(),
                });
                for declarator in &declaration.declarations {
                    match &declarator.init {
                        Some(init) => {
                            let span = init.span();
                            rewriter.insert(span.start, format!("{STATE}("));
                            rewriter.visit_expression(init);
                            rewriter.insert(span.end, ")".to_owned());
                        }
                        None => {
                            let end = declarator.id.span().end;
                            let end = declarator
                                .type_annotation
                                .as_ref()
                                .map_or(end, |annotation| annotation.span.end);
                            rewriter.insert(end, format!(" = {STATE}(undefined)"));
                        }
                    }
                }
            }
            _ => {
                for declarator in &declaration.declarations {
                    let Some(init) = &declarator.init else {
                        continue;
                    };
                    let derived = derived(&declarator.id);
                    let span = init.span();
                    if derived {
                        rewriter.insert(span.start, format!("{COMPUTED}(() => ("));
                    }
                    rewriter.visit_expression(init);
                    if derived {
                        rewriter.insert(span.end, "))".to_owned());
                    }
                }
            }
        }
    } else {
        rewriter.visit_statement(statement);
    }
    rewriter.finish()
}

/// The edits that make `expression` code (in a template, or a nested statement).
pub fn rewrite_expression(
    names: &impl Names,
    expression: &Expression<'_>,
) -> Result<Vec<Edit>, Diagnostic> {
    let mut rewriter = Rewriter::new(names);
    rewriter.visit_expression(expression);
    rewriter.finish()
}

/// Collects the edits (see the module docs).
pub struct Rewriter<'n, N: Names> {
    names: &'n N,
    pub edits: Vec<Edit>,
    error: Option<Diagnostic>,
}

impl<'n, N: Names> Rewriter<'n, N> {
    pub fn new(names: &'n N) -> Self {
        Self {
            names,
            edits: Vec::new(),
            error: None,
        }
    }

    pub fn finish(self) -> Result<Vec<Edit>, Diagnostic> {
        match self.error {
            Some(error) => Err(error),
            None => Ok(self.edits),
        }
    }

    fn fail(&mut self, offset: u32, message: impl Into<String>) {
        if self.error.is_none() {
            self.error = Some(self.names.error(offset, message.into()));
        }
    }

    fn replace(&mut self, start: u32, end: u32, text: String) {
        self.edits.push(Edit {
            range: start as usize..end as usize,
            text,
        });
    }

    fn insert(&mut self, at: u32, text: String) {
        self.replace(at, at, text);
    }

    /// What reading `identifier` becomes, if it changes.
    fn read(&mut self, identifier: &IdentifierReference<'_>) -> Option<String> {
        let name = identifier.name.as_str();
        match self.names.kind(identifier)? {
            Kind::Prop(prop) => self.names.in_script().then(|| format!("$p.{prop}")),
            Kind::State | Kind::Derived => Some(format!("{name}.get()")),
            Kind::Callback(_) => {
                self.fail(
                    identifier.span.start,
                    format!("call `{name}(…)` to fire the event; passing it on isn't supported"),
                );
                None
            }
            Kind::Children => {
                self.fail(
                    identifier.span.start,
                    "`children` can only be rendered: put `{children}` in the JSX",
                );
                None
            }
        }
    }

    fn state_target<'b>(&self, target: &'b AssignmentTarget<'_>) -> Option<&'b str> {
        let AssignmentTarget::AssignmentTargetIdentifier(identifier) = target else {
            return None;
        };
        (self.names.kind(identifier) == Some(Kind::State)).then(|| identifier.name.as_str())
    }
}

impl<'a, N: Names> Visit<'a> for Rewriter<'_, N> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if self.names.is_write(identifier) {
            match self.names.kind(identifier) {
                Some(Kind::State) => self.fail(
                    identifier.span.start,
                    "assign state with `name = …`, not by destructuring",
                ),
                Some(Kind::Derived) => self.fail(
                    identifier.span.start,
                    format!(
                        "`{}` is derived from props or state, so it can't be assigned; make it a `let`",
                        identifier.name
                    ),
                ),
                Some(Kind::Callback(_) | Kind::Children) => self.fail(
                    identifier.span.start,
                    format!("`{}` can't be assigned", identifier.name),
                ),
                Some(Kind::Prop(prop)) if self.names.in_script() => {
                    let text = format!("$p.{prop}");
                    self.replace(identifier.span.start, identifier.span.end, text);
                }
                _ => {}
            }
            return;
        }
        if let Some(text) = self.read(identifier) {
            self.replace(identifier.span.start, identifier.span.end, text);
        }
    }

    fn visit_object_property(&mut self, property: &ObjectProperty<'a>) {
        if property.shorthand {
            if let Expression::Identifier(identifier) = &property.value {
                if let Some(text) = self.read(identifier) {
                    let name = identifier.name.as_str();
                    self.replace(
                        identifier.span.start,
                        identifier.span.end,
                        format!("{name}: {text}"),
                    );
                }
                return;
            }
        }
        walk::walk_object_property(self, property);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Expression::Identifier(callee) = &call.callee {
            if let Some(Kind::Callback(event)) = self.names.kind(callee) {
                // `onPick(a)` / `onPick?.(a)` → `emit("pick", a)`: replace up to the `(`.
                let rest = &self.names.source()[callee.span.end as usize..];
                let Some(open) = rest.find('(') else { return };
                let mut text = format!("{EMIT}(\"{event}\"");
                if !call.arguments.is_empty() {
                    text.push_str(", ");
                }
                self.replace(callee.span.start, callee.span.end + open as u32 + 1, text);
                self.visit_arguments(&call.arguments);
                return;
            }
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        let Some(name) = self.state_target(&assignment.left) else {
            return walk::walk_assignment_expression(self, assignment);
        };
        let name = name.to_owned();
        let operator = match assignment.operator {
            AssignmentOperator::Assign => None,
            AssignmentOperator::Addition => Some("+"),
            AssignmentOperator::Subtraction => Some("-"),
            AssignmentOperator::Multiplication => Some("*"),
            AssignmentOperator::Division => Some("/"),
            AssignmentOperator::Remainder => Some("%"),
            AssignmentOperator::Exponential => Some("**"),
            AssignmentOperator::ShiftLeft => Some("<<"),
            AssignmentOperator::ShiftRight => Some(">>"),
            AssignmentOperator::ShiftRightZeroFill => Some(">>>"),
            AssignmentOperator::BitwiseOR => Some("|"),
            AssignmentOperator::BitwiseXOR => Some("^"),
            AssignmentOperator::BitwiseAnd => Some("&"),
            AssignmentOperator::LogicalAnd => Some("&&"),
            AssignmentOperator::LogicalOr => Some("||"),
            AssignmentOperator::LogicalNullish => Some("??"),
        };
        let right = assignment.right.span();
        let open = match operator {
            None => format!("{ASSIGN}({name}, "),
            Some(operator) => format!("{ASSIGN}({name}, {name}.get() {operator} ("),
        };
        let close = if operator.is_some() { "))" } else { ")" };
        self.replace(assignment.span.start, right.start, open);
        self.visit_expression(&assignment.right);
        self.replace(right.end, assignment.span.end, close.to_owned());
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        let SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) = &update.argument
        else {
            return walk::walk_update_expression(self, update);
        };
        if self.names.kind(identifier) != Some(Kind::State) {
            return walk::walk_update_expression(self, update);
        }
        let name = identifier.name.as_str();
        let delta = if update.operator == UpdateOperator::Increment {
            "1"
        } else {
            "-1"
        };
        let text = format!("{UPDATE}({name}, {delta}, {})", update.prefix);
        self.replace(update.span.start, update.span.end, text);
    }
}

// ---- `.mnx` scripts (2.0) ------------------------------------------------------------------

/// A component script with 2.0's semantics applied.
#[derive(Debug, Default)]
pub struct ScriptCode {
    /// The script, rewritten.
    pub body: String,
    /// Its top-level `let`s (state) and derived `const`s, which templates read with `.get()`.
    pub state: Vec<String>,
    pub derived: Vec<String>,
}

struct ScriptNames<'s> {
    source: &'s str,
    scoping: &'s oxc_semantic::Scoping,
    kinds: std::collections::HashMap<oxc_syntax::symbol::SymbolId, Kind>,
    props: &'s [String],
    start: crate::diagnostic::Span,
}

impl Names for ScriptNames<'_> {
    fn kind(&self, identifier: &IdentifierReference<'_>) -> Option<Kind> {
        let reference = self.scoping.get_reference(identifier.reference_id());
        match reference.symbol_id() {
            Some(symbol) => self.kinds.get(&symbol).cloned(),
            None => {
                let name = identifier.name.as_str();
                self.props
                    .iter()
                    .any(|prop| prop == name)
                    .then(|| Kind::Prop(name.to_owned()))
            }
        }
    }
    fn is_write(&self, identifier: &IdentifierReference<'_>) -> bool {
        self.scoping
            .get_reference(identifier.reference_id())
            .is_write()
    }
    fn source(&self) -> &str {
        self.source
    }
    fn error(&self, offset: u32, message: String) -> Diagnostic {
        Diagnostic::new(
            crate::scanner::span_after(self.start, self.source, offset as usize),
            message,
        )
    }
    fn in_script(&self) -> bool {
        true
    }
}

/// Rewrite a component's `<script>` body (JavaScript; it starts at `start` in the file) for
/// 2.0: props by name, `let` as state, derived `const`s.
pub fn rewrite_script(
    body: &str,
    props: &[String],
    start: crate::diagnostic::Span,
) -> Result<ScriptCode, Diagnostic> {
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, body, oxc_span::SourceType::mjs()).parse();
    let semantic = oxc_semantic::SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let mut names = ScriptNames {
        source: body,
        scoping: semantic.scoping(),
        kinds: std::collections::HashMap::new(),
        props,
        start,
    };
    let mut code = ScriptCode::default();
    // Classify in order: a derived `const` may read the ones before it.
    for statement in &parsed.program.body {
        let Statement::VariableDeclaration(declaration) = statement else {
            continue;
        };
        for declarator in &declaration.declarations {
            match declaration.kind {
                VariableDeclarationKind::Let => match &declarator.id {
                    BindingPattern::BindingIdentifier(identifier) => {
                        names.kinds.insert(identifier.symbol_id(), Kind::State);
                        code.state.push(identifier.name.to_string());
                    }
                    _ => {
                        return Err(names.error(
                            declarator.span.start,
                            "state is one name per `let`; destructure when you read it".to_owned(),
                        ))
                    }
                },
                VariableDeclarationKind::Const => {
                    let Some(init) = &declarator.init else {
                        continue;
                    };
                    if !reads_reactive(&names, init) {
                        continue;
                    }
                    if let BindingPattern::BindingIdentifier(identifier) = &declarator.id {
                        names.kinds.insert(identifier.symbol_id(), Kind::Derived);
                        code.derived.push(identifier.name.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    let mut edits = Vec::new();
    for statement in &parsed.program.body {
        edits.extend(rewrite_statement(&names, statement, &|id| {
            matches!(id, BindingPattern::BindingIdentifier(identifier)
                if names.kinds.get(&identifier.symbol_id()) == Some(&Kind::Derived))
        })?);
    }
    code.body = apply(body, 0..body.len(), edits);
    Ok(code)
}

struct TemplateNames<'s> {
    source: &'s str,
    scoping: &'s oxc_semantic::Scoping,
    state: &'s [String],
    derived: &'s [String],
}

impl Names for TemplateNames<'_> {
    fn kind(&self, identifier: &IdentifierReference<'_>) -> Option<Kind> {
        let reference = self.scoping.get_reference(identifier.reference_id());
        if reference.symbol_id().is_some() {
            return None; // local to the expression
        }
        let name = identifier.name.as_str();
        if self.state.iter().any(|state| state == name) {
            Some(Kind::State)
        } else if self.derived.iter().any(|derived| derived == name) {
            Some(Kind::Derived)
        } else {
            None
        }
    }
    fn is_write(&self, identifier: &IdentifierReference<'_>) -> bool {
        self.scoping
            .get_reference(identifier.reference_id())
            .is_write()
    }
    fn source(&self) -> &str {
        self.source
    }
    fn error(&self, _offset: u32, message: String) -> Diagnostic {
        Diagnostic::new(crate::diagnostic::Span::new(1, 1), message)
    }
    fn in_script(&self) -> bool {
        false
    }
}

/// A template's runtime expression with the script's state and derived values read with
/// `.get()` and state assigned (2.0). `None` when it uses neither.
pub fn rewrite_template_expression(
    source: &str,
    state: &[String],
    derived: &[String],
) -> Result<Option<String>, String> {
    let wrapped = format!("({source}\n)");
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, &wrapped, oxc_span::SourceType::mjs()).parse();
    let semantic = oxc_semantic::SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let names = TemplateNames {
        source: &wrapped,
        scoping: semantic.scoping(),
        state,
        derived,
    };
    let mut rewriter = Rewriter::new(&names);
    rewriter.visit_program(&parsed.program);
    let edits = rewriter.finish().map_err(|error| error.message)?;
    if edits.is_empty() {
        return Ok(None);
    }
    let text = apply(&wrapped, 0..wrapped.len(), edits);
    // Unwrap the parentheses added above.
    Ok(Some(text[1..text.len() - 2].to_owned()))
}
