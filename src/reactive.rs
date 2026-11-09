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

/// What `@zubra/runtime` exports for scripts (runtime/src/index.js): called without an import,
/// each would throw in the browser.
pub const RUNTIME_EXPORTS: &[&str] = &[
    "state",
    "computed",
    "watch",
    "onMount",
    "onUnmount",
    "id",
    "props",
    "host",
    "emit",
    "adoptStyles",
    "createContext",
    "provide",
    "inject",
    "formValue",
    "validity",
    "onFormReset",
    "onFormRestore",
    "onFormDisabled",
    "prevent",
    "stop",
    "selfOnly",
    "submit",
    "keys",
    "model",
    "hasSlot",
    "hydrated",
    "signal",
    "from",
    "raw",
    "resource",
    "effect",
    "scope",
    "flush",
    "tick",
];

/// The local names an import statement binds (`import a, { b as c } from "x"` → a, c).
pub fn imported_names(text: &str) -> Vec<String> {
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, text, oxc_span::SourceType::mjs()).parse();
    let mut names = Vec::new();
    for statement in &parsed.program.body {
        if let Statement::ImportDeclaration(import) = statement {
            for specifier in import.specifiers.iter().flatten() {
                names.push(specifier.local().name.to_string());
            }
        }
    }
    names
}

pub const STATE: &str = "__zubraState";
pub const COMPUTED: &str = "__zubraComputed";
pub const EMIT: &str = "__zubraEmit";
pub const ASSIGN: &str = "__zubraAssign";
pub const UPDATE: &str = "__zubraUpdate";

/// Assignments to state as expressions: `x = v` is `__zubraAssign(x, v)` (calls, so no line of
/// the output starts with a parenthesis that could join the previous statement).
pub const HELPERS: &str = "function __zubraAssign(signal, value) { signal.set(value); return value }\nfunction __zubraUpdate(signal, delta, prefix) { const old = signal.get(); signal.set(old + delta); return prefix ? old + delta : old }\n";

/// How compiled code spells props and state. `@zubra/runtime` output reads props through `$p`
/// and state with `.get()`/`.set()`; `--emit element` output, written to be read, uses a named
/// element (`element.value`) and `.value` (`count.value++`).
#[derive(Clone, Copy, Debug)]
pub struct Lowering<'a> {
    /// What the script reads props from: `$p`, or the element's name.
    pub props: &'a str,
    /// Two-way props, whose writes from the script go through the element's private `#prop`
    /// accessor (which fires `<prop>change`). Only with `value`.
    pub models: &'a [String],
    /// The local names that make state and derived values.
    pub state: &'a str,
    pub computed: &'a str,
    /// `.value` (read and assigned) instead of `.get()` and `.set()`.
    pub value: bool,
}

/// What `@zubra/runtime` output uses.
pub const RUNTIME_LOWERING: Lowering<'static> = Lowering {
    props: "$p",
    models: &[],
    state: STATE,
    computed: COMPUTED,
    value: false,
};

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
    /// A top-level `const` holding a signal from `state()`, `computed()`, `inject()`, `hasSlot()`
    /// or `hydrated()`: the script and the template read it like a value (since 3.0; `.get()`
    /// and `.set()` written out stay, and `signal(name)` is the signal), and a `const` that reads
    /// it is derived.
    Signal,
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
    /// Whether `name` is `from` from the runtime: `let x = from(prop)` passes the prop as a
    /// function, so the state can follow it.
    fn is_from(&self, _name: &str) -> bool {
        false
    }
    /// How props and state are spelled (see [`Lowering`]).
    fn lowering(&self) -> &Lowering<'_> {
        &RUNTIME_LOWERING
    }
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
                Some(Kind::Prop(_) | Kind::State | Kind::Derived | Kind::Signal)
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
    rewrite_statement_with(names, statement, derived, true)
}

/// As [`rewrite_statement`]; with `declarations` false, `let` and derived `const`s are left as
/// written and only the names are rewritten (readable JSX lowering).
pub fn rewrite_statement_with(
    names: &impl Names,
    statement: &Statement<'_>,
    derived: &dyn Fn(&BindingPattern<'_>) -> bool,
    declarations: bool,
) -> Result<Vec<Edit>, Diagnostic> {
    let mut rewriter = Rewriter::new(names);
    if !declarations {
        rewriter.visit_statement(statement);
    } else if let Statement::VariableDeclaration(declaration) = statement {
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
                            // `let x = from(prop)`: `from(() => (prop))`, already state.
                            if let Expression::CallExpression(call) = init.without_parentheses() {
                                if let Expression::Identifier(callee) = &call.callee {
                                    let arguments = call.arguments.as_slice();
                                    if names.is_from(&callee.name)
                                        && (1..=2).contains(&arguments.len())
                                        && !arguments.iter().any(|argument| argument.is_spread())
                                    {
                                        for argument in arguments {
                                            let span = argument.span();
                                            rewriter.insert(span.start, "() => (".to_owned());
                                            rewriter.insert(span.end, ")".to_owned());
                                        }
                                        rewriter.visit_expression(init);
                                        continue;
                                    }
                                }
                            }
                            let span = init.span();
                            rewriter.insert(span.start, format!("{}(", names.lowering().state));
                            rewriter.visit_expression(init);
                            rewriter.insert(span.end, ")".to_owned());
                        }
                        None => {
                            let end = declarator.id.span().end;
                            let end = declarator
                                .type_annotation
                                .as_ref()
                                .map_or(end, |annotation| annotation.span.end);
                            rewriter
                                .insert(end, format!(" = {}(undefined)", names.lowering().state));
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
                        rewriter
                            .insert(span.start, format!("{}(() => (", names.lowering().computed));
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
            Kind::Prop(prop) => self
                .names
                .in_script()
                .then(|| format!("{}.{prop}", self.names.lowering().props)),
            Kind::State | Kind::Derived => Some(self.signal_read(name)),
            // A signal reads like a value, in the template and (since 3.0) in the script.
            // `.get()`/`.set()` written out stay, and `signal(count)` is the signal itself.
            Kind::Signal => {
                let source = self.names.source();
                let rest = source[identifier.span.end as usize..].trim_start();
                let explicit = [".get(", ".set(", "?.get("]
                    .iter()
                    .any(|call| rest.starts_with(call));
                let passed = source[..identifier.span.start as usize]
                    .trim_end()
                    .strip_suffix('(')
                    .is_some_and(|before| {
                        before.ends_with("signal")
                            && !before[..before.len() - "signal".len()].ends_with(|c: char| {
                                c.is_alphanumeric() || c == '_' || c == '$' || c == '.'
                            })
                    })
                    && rest.starts_with(')');
                (!explicit && !passed).then(|| self.signal_read(name))
            }
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

    /// Reading a signal's value.
    fn signal_read(&self, name: &str) -> String {
        if self.names.lowering().value {
            format!("{name}.value")
        } else {
            format!("{name}.get()")
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
                    let lowering = self.names.lowering();
                    // A two-way prop written by the component itself: its private accessor.
                    let private = if lowering.value && lowering.models.contains(&prop) {
                        "#"
                    } else {
                        ""
                    };
                    let text = format!("{}.{private}{prop}", lowering.props);
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
        if self.names.lowering().value {
            // `count = 1`, `count += 1` as they are, on `count.value`.
            let target = assignment.left.span();
            self.replace(target.start, target.end, format!("{name}.value"));
            self.visit_expression(&assignment.right);
            return;
        }
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
        if self.names.lowering().value {
            let text = format!("{name}.value");
            self.replace(identifier.span.start, identifier.span.end, text);
            return;
        }
        let delta = if update.operator == UpdateOperator::Increment {
            "1"
        } else {
            "-1"
        };
        let text = format!("{UPDATE}({name}, {delta}, {})", update.prefix);
        self.replace(update.span.start, update.span.end, text);
    }
}

// ---- `.zb` scripts (2.0) ------------------------------------------------------------------

/// A component script with 2.0's semantics applied.
#[derive(Debug, Default)]
pub struct ScriptCode {
    /// The script, rewritten.
    pub body: String,
    /// Its top-level `let`s (state) and derived `const`s, which templates read with `.get()`.
    pub state: Vec<String>,
    pub derived: Vec<String>,
    /// Its top-level `const`s that hold a signal (`state()`, `computed()`, `inject()`).
    pub signals: Vec<String>,
}

struct ScriptNames<'s> {
    lowering: Lowering<'s>,
    source: &'s str,
    scoping: &'s oxc_semantic::Scoping,
    kinds: std::collections::HashMap<oxc_syntax::symbol::SymbolId, Kind>,
    props: &'s [String],
    from: &'s [String],
    start: crate::diagnostic::Span,
}

impl Names for ScriptNames<'_> {
    fn lowering(&self) -> &Lowering<'_> {
        &self.lowering
    }
    fn is_from(&self, name: &str) -> bool {
        self.from.iter().any(|from| from == name)
    }
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
    makers: &[String],
    imported: &[String],
    from: &[String],
    start: crate::diagnostic::Span,
) -> Result<ScriptCode, Diagnostic> {
    rewrite_script_with(body, props, makers, imported, from, start, RUNTIME_LOWERING)
}

/// [`rewrite_script`], spelling props and state as `lowering` says.
pub fn rewrite_script_with(
    body: &str,
    props: &[String],
    makers: &[String],
    imported: &[String],
    from: &[String],
    start: crate::diagnostic::Span,
    lowering: Lowering<'_>,
) -> Result<ScriptCode, Diagnostic> {
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, body, oxc_span::SourceType::mjs()).parse();
    let semantic = oxc_semantic::SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let mut names = ScriptNames {
        lowering,
        source: body,
        scoping: semantic.scoping(),
        kinds: std::collections::HashMap::new(),
        props,
        from,
        start,
    };
    // A runtime hook called but never imported (or declared) would throw in the browser.
    let scoping = semantic.scoping();
    let mut unimported: Vec<(u32, &str)> = Vec::new();
    for (name, references) in scoping.root_unresolved_references() {
        let name: &str = name;
        if !RUNTIME_EXPORTS.contains(&name)
            || props.iter().any(|prop| prop == name)
            || imported.iter().any(|local| local == name)
        {
            continue;
        }
        if let Some(first) = references.first() {
            let node = semantic
                .nodes()
                .get_node(scoping.get_reference(*first).node_id());
            unimported.push((oxc_span::GetSpan::span(&node.kind()).start, name));
        }
    }
    if let Some((offset, name)) = unimported.into_iter().min() {
        return Err(Diagnostic::new(
            crate::scanner::span_after(start, body, offset as usize),
            format!("`{name}` is a hook from @zubra/runtime, but the script doesn't import it"),
        )
        .with_help(format!(
            "import it: `import {{ {name} }} from '@zubra/runtime'`"
        )));
    }
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
                    if let (
                        Expression::CallExpression(call),
                        BindingPattern::BindingIdentifier(identifier),
                    ) = (init.without_parentheses(), &declarator.id)
                    {
                        if matches!(&call.callee, Expression::Identifier(callee) if makers.iter().any(|maker| maker == callee.name.as_str()))
                        {
                            names.kinds.insert(identifier.symbol_id(), Kind::Signal);
                            code.signals.push(identifier.name.to_string());
                            continue;
                        }
                    }
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
    lowering: Lowering<'s>,
    source: &'s str,
    scoping: &'s oxc_semantic::Scoping,
    state: &'s [String],
    derived: &'s [String],
    signals: &'s [String],
}

impl Names for TemplateNames<'_> {
    fn lowering(&self) -> &Lowering<'_> {
        &self.lowering
    }
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
        } else if self.signals.iter().any(|signal| signal == name) {
            Some(Kind::Signal)
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
    signals: &[String],
) -> Result<Option<String>, String> {
    rewrite_template_expression_with(source, state, derived, signals, RUNTIME_LOWERING)
}

/// [`rewrite_template_expression`], spelling state as `lowering` says.
pub fn rewrite_template_expression_with(
    source: &str,
    state: &[String],
    derived: &[String],
    signals: &[String],
    lowering: Lowering<'_>,
) -> Result<Option<String>, String> {
    let wrapped = format!("({source}\n)");
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, &wrapped, oxc_span::SourceType::mjs()).parse();
    let semantic = oxc_semantic::SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let names = TemplateNames {
        lowering,
        source: &wrapped,
        scoping: semantic.scoping(),
        state,
        derived,
        signals,
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
