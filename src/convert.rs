//! `mnx convert`: a React function component, rewritten as an mnx JSX component
//! (`.mnx.jsx` / `.mnx.tsx`), which compiles to a custom element.
//!
//! The function body of an mnx component runs once per element, so React's hooks become what
//! they stand for:
//!
//! ```jsx
//! const [count, setCount] = useState(0)        →   let count = 0
//! setCount(count + 1); setCount((c) => c + 1)  →   (count = count + 1); (count = ((c) => c + 1)(count))
//! const doubled = useMemo(() => count * 2, [count])   →   const doubled = count * 2
//! const save = useCallback(() => …, [])        →   const save = () => …
//! const input = useRef(null); input.current    →   let input = null; input
//! useEffect(() => …, [])                       →   onMount(() => …)
//! useEffect(() => …, [count])                  →   onMount(() => effect(() => …))   (it tracks what it reads)
//! const [s, dispatch] = useReducer(r, init)   →   let s = init; const dispatch = (action) => (s = r(s, action))
//! const Ctx = createContext(x); useContext(Ctx) →   createContext(x) and inject(Ctx) from @mnx/runtime
//! <Child onClose={onClose}>                    →   onClose={(event) => onClose(event)} (a received event prop, passed on)
//! ```
//!
//! `onChange` on a text field becomes `onInput` (React's `onChange` fires on every keystroke; the
//! DOM's `change` waits for the field to lose focus), and `onDoubleClick` becomes `onDblClick`. A one-word name gets a prefix, since a custom
//! element's name needs a hyphen. What it can't convert (other hooks, props not destructured,
//! spread attributes, `dangerouslySetInnerHTML`) is reported, not guessed, and the result is
//! compiled to check it.
//!
//! The rewrite is a set of small edits to the source, so comments, formatting and everything it
//! doesn't touch stay as they were.

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::{
    ast::{
        Argument, BindingPattern, CallExpression, ExportDefaultDeclarationKind, Expression,
        FunctionBody, ImportDeclarationSpecifier, JSXAttributeItem, JSXAttributeName,
        JSXElementName, JSXOpeningElement, Statement, VariableDeclaration,
    },
    AstKind,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::symbol::SymbolId;

use crate::{
    diagnostic::{Diagnostic, Span},
    scanner::span_after,
};

/// What converting one component does.
#[derive(Debug, Default)]
pub struct Conversion {
    /// The mnx JSX component.
    pub output: String,
    /// Its tag (`<todo-item>`), and the file name to give it (`todo-item.mnx.jsx`).
    pub tag: String,
    pub file_name: String,
    /// One line per kind of rewrite.
    pub changes: Vec<String>,
    /// What wasn't converted, at its place in the React source.
    pub unsupported: Vec<Diagnostic>,
    /// When everything was converted but the output doesn't compile: why, at its place in the
    /// output.
    pub compile_error: Option<Diagnostic>,
}

const CONVERTED: &[&str] = &[
    "useState",
    "useMemo",
    "useCallback",
    "useRef",
    "useEffect",
    "useLayoutEffect",
    "useReducer",
    "useContext",
    "createContext",
];

/// Convert the React component in `source` (`path` gives the dialect: .jsx, .tsx, .js, .ts).
/// `prefix` names a one-word component (`Counter` with prefix `app` → `<app-counter>`).
pub fn convert(source: &str, path: &str, prefix: Option<&str>) -> Result<Conversion, Diagnostic> {
    convert_component(source, path, prefix, None)
}

/// As [`convert`], converting the exported component named `component` when a file exports
/// several (`mnx convert Menu.tsx --component MenuItem`).
pub fn convert_component(
    source: &str,
    path: &str,
    prefix: Option<&str>,
    component: Option<&str>,
) -> Result<Conversion, Diagnostic> {
    let typescript = path.ends_with(".tsx") || path.ends_with(".ts");
    let source_type = if typescript {
        SourceType::tsx()
    } else {
        SourceType::jsx()
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if let Some(error) = parsed.diagnostics.first() {
        let at = error.labels.first().map_or(0, |label| label.offset());
        return Err(Diagnostic::new(
            at_offset(source, at),
            error.message.to_string(),
        ));
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();

    let mut work = Work {
        source,
        edits: Vec::new(),
        removed: Vec::new(),
        changes: Vec::new(),
        unsupported: Vec::new(),
        used: HashSet::new(),
    };

    // The component: `export default function Name(…)`, or a function exported by default later.
    let mut function = None;
    let mut default_name = None;
    for statement in &parsed.program.body {
        if let Statement::ExportDefaultDeclaration(export) = statement {
            match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(declaration) => {
                    function = Some(&**declaration);
                }
                ExportDefaultDeclarationKind::Identifier(identifier) => {
                    default_name = Some(identifier.name.as_str());
                }
                _ => {}
            }
        }
    }
    if let (None, Some(name)) = (function, default_name) {
        for statement in &parsed.program.body {
            if let Statement::FunctionDeclaration(declaration) = statement {
                if declaration.id.as_ref().is_some_and(|id| id.name == name) {
                    function = Some(&**declaration);
                }
            }
        }
    }
    // Otherwise the file's one exported component (`export function CardEditor`), which becomes
    // the default export.
    if function.is_none() {
        // `export function X` and `function X … export { X }`: (where `export` goes, the function).
        let mut exported_names: Vec<String> = Vec::new();
        let mut specifier_exports: Vec<(u32, u32)> = Vec::new();
        for statement in &parsed.program.body {
            if let Statement::ExportNamedDeclaration(export) = statement {
                specifier_exports.push((export.span.start, export.span.end));
                for specifier in &export.specifiers {
                    exported_names.push(specifier.local.name().to_string());
                }
            }
        }
        let named: Vec<(u32, &oxc_ast::ast::Function<'_>, bool)> = parsed
            .program
            .body
            .iter()
            .filter_map(|statement| match statement {
                Statement::ExportDeclaration(export) => match &export.declaration {
                    oxc_ast::ast::Declaration::FunctionDeclaration(declaration)
                        if declaration
                            .id
                            .as_ref()
                            .is_some_and(|id| id.name.starts_with(char::is_uppercase)) =>
                    {
                        Some((export.span.start, &**declaration, false))
                    }
                    _ => None,
                },
                Statement::FunctionDeclaration(declaration)
                    if declaration.id.as_ref().is_some_and(|id| {
                        id.name.starts_with(char::is_uppercase)
                            && exported_names.iter().any(|name| name == id.name.as_str())
                    }) =>
                {
                    Some((declaration.span.start, &**declaration, true))
                }
                _ => None,
            })
            .collect();
        let make_default = |work: &mut Work<'_>, at: u32, via_specifier: bool| {
            if via_specifier {
                work.edit(at, at, "export default ");
            } else {
                work.edit(at, at + "export".len() as u32, "export default");
            }
        };
        let names = |several: &[(u32, &oxc_ast::ast::Function<'_>, bool)]| {
            several
                .iter()
                .filter_map(|(_, declaration, _)| {
                    declaration.id.as_ref().map(|id| format!("`{}`", id.name))
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        match (named.as_slice(), component) {
            ([(export, declaration, via_specifier)], None) => {
                make_default(&mut work, *export, *via_specifier);
                for (start, end) in &specifier_exports {
                    work.remove(*start, *end);
                }
                work.changes
                    .push("made the component the file's default export".to_owned());
                function = Some(*declaration);
            }
            (several, Some(wanted)) if !several.is_empty() => {
                match several.iter().find(|(_, declaration, _)| {
                    declaration.id.as_ref().is_some_and(|id| id.name == wanted)
                }) {
                    Some((export, declaration, via_specifier)) => {
                        make_default(&mut work, *export, *via_specifier);
                        // The other components leave with the file; what they used stays and
                        // is reported by the compile check if the chosen one needs it.
                        for (other, declaration, _) in several {
                            if other != export {
                                work.remove(*other, declaration.span.end);
                            }
                        }
                        for (start, end) in &specifier_exports {
                            work.remove(*start, *end);
                        }
                        work.changes.push(format!(
                            "converted `{wanted}` of the {} components this file exports; the others are left out of the result",
                            several.len()
                        ));
                        function = Some(*declaration);
                    }
                    None => {
                        return Err(Diagnostic::new(
                            Span::new(1, 1),
                            format!("no exported component named `{wanted}` in this file"),
                        )
                        .with_help(format!("it exports {}", names(several))));
                    }
                }
            }
            (several, None) if several.len() > 1 => {
                return Err(Diagnostic::new(
                    Span::new(1, 1),
                    format!(
                        "this file exports {} components; `mnx convert` converts one at a time",
                        several.len()
                    ),
                )
                .with_help(format!(
                    "pass `--component <Name>`, one of {}",
                    names(several)
                )));
            }
            _ => {}
        }
    }
    let Some(function) = function else {
        return Err(Diagnostic::new(Span::new(1, 1), "no component to convert: `mnx convert` takes a file whose default export is a function component")
            .with_help("write it as `export default function TodoItem({ … }) { … }` (an arrow function or a class isn't converted)"));
    };
    let Some(id) = &function.id else {
        return Err(Diagnostic::new(
            at_offset(source, function.span.start),
            "the component function needs a name: it becomes the tag",
        ));
    };

    // The name: two words or more make a custom element name (`TodoItem` → `todo-item`).
    let name = id.name.to_string();
    let words = name.chars().filter(char::is_ascii_uppercase).count();
    let name = if words >= 2 {
        name
    } else if let Some(prefix) = prefix.filter(|prefix| !prefix.is_empty()) {
        let renamed = format!("{}{}{name}", prefix[..1].to_uppercase(), &prefix[1..]);
        work.edit(id.span.start, id.span.end, &renamed);
        for reference in scoping.get_resolved_references(id.symbol_id()) {
            let span = nodes.get_node(reference.node_id()).kind().span();
            work.edit(span.start, span.end, &renamed);
        }
        work.changes.push(format!(
            "renamed `{name}` to `{renamed}`: a custom element's name needs a hyphen"
        ));
        renamed
    } else {
        return Err(Diagnostic::new(
            at_offset(source, id.span.start),
            format!("`{name}` is one word, and a custom element's name needs a hyphen"),
        )
        .with_help(format!(
            "pass a prefix (`--prefix app` makes it `App{name}`, `<app-{}>`), or rename the function",
            name.to_lowercase()
        )));
    };
    let tag = kebab(&name);

    // Props must be destructured: their names are the props. The `on<Name>` ones are events,
    // which the component may only call; passing one on (`onClose={onClose}`) becomes a call.
    let mut callbacks: HashSet<SymbolId> = HashSet::new();
    if let Some(parameter) = function.params.items.first() {
        if let BindingPattern::ObjectPattern(pattern) = &parameter.pattern {
            for property in &pattern.properties {
                let binding = match &property.value {
                    BindingPattern::BindingIdentifier(identifier) => Some(identifier),
                    BindingPattern::AssignmentPattern(assignment) => match &assignment.left {
                        BindingPattern::BindingIdentifier(identifier) => Some(identifier),
                        _ => None,
                    },
                    _ => None,
                };
                if let Some(binding) = binding {
                    let name = binding.name.as_str();
                    if name.len() > 2
                        && name.starts_with("on")
                        && name[2..].starts_with(char::is_uppercase)
                    {
                        callbacks.insert(binding.symbol_id());
                    }
                }
            }
        }
        if let BindingPattern::BindingIdentifier(identifier) = &parameter.pattern {
            work.unsupported(
                identifier.span.start,
                format!("props as one object (`{}`) aren't converted", identifier.name),
                "destructure them in the parameters, as `function TodoItem({ text, done = false })`: each name is a prop",
            );
        }
    }

    // React's hooks, by local name (`useState`, or `React.useState` through a default import).
    let mut hooks: HashMap<SymbolId, String> = HashMap::new();
    let mut react_namespace = None;
    let mut react_import = None;
    for statement in &parsed.program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        // React's hooks, or Preact's (the same API).
        let module =
            &source[import.source.span.start as usize + 1..import.source.span.end as usize - 1];
        if !matches!(module, "react" | "preact/hooks" | "preact/compat") {
            continue;
        }
        react_import = Some(import);
        for specifier in import.specifiers.iter().flatten() {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    hooks.insert(named.local.symbol_id(), named.imported.name().to_string());
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    react_namespace = Some(default.local.symbol_id());
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    react_namespace = Some(namespace.local.symbol_id());
                }
            }
        }
    }
    let hook_of = |callee: &Expression<'_>| -> Option<String> {
        match callee {
            Expression::Identifier(identifier) => {
                let symbol = scoping
                    .get_reference(identifier.reference_id())
                    .symbol_id()?;
                hooks.get(&symbol).cloned()
            }
            Expression::StaticMemberExpression(member) => {
                let Expression::Identifier(object) = &member.object else {
                    return None;
                };
                let symbol = scoping.get_reference(object.reference_id()).symbol_id()?;
                (Some(symbol) == react_namespace).then(|| member.property.name.to_string())
            }
            _ => None,
        }
    };

    // `const Ctx = createContext(x)` at module level: the runtime's `createContext`, so
    // `inject(Ctx)` (from `useContext`) and `provide(Ctx, v)` elsewhere share it.
    let mut contexts: HashSet<SymbolId> = HashSet::new();
    for statement in &parsed.program.body {
        let (declaration, exported) = match statement {
            Statement::VariableDeclaration(declaration) => (&**declaration, false),
            Statement::ExportDeclaration(export) => match &export.declaration {
                oxc_ast::ast::Declaration::VariableDeclaration(declaration) => {
                    (&**declaration, true)
                }
                _ => continue,
            },
            _ => continue,
        };
        for declarator in &declaration.declarations {
            let Some(Expression::CallExpression(call)) = &declarator.init else {
                continue;
            };
            if hook_of(&call.callee).as_deref() != Some("createContext") {
                continue;
            }
            let callee = call.callee.span();
            work.edit(callee.start, callee.end, "createContext");
            work.used.insert("createContext");
            if exported {
                // A JSX component file exports only its component.
                work.unsupported(
                    statement.span().start,
                    "an exported context can't stay in a component file",
                    "move `createContext` (from @mnx/runtime) to its own module and import the context here and in the providers",
                );
                continue;
            }
            if let BindingPattern::BindingIdentifier(binding) = &declarator.id {
                contexts.insert(binding.symbol_id());
            }
            work.changes.push("`createContext` is the runtime's (the Context Protocol): `inject()` reads it, and a parent calls `provide(context, value)`".to_owned());
        }
    }

    // The body's top-level statements: where hooks are called.
    let mut setters: HashMap<SymbolId, String> = HashMap::new();
    let mut refs: HashSet<SymbolId> = HashSet::new();
    // A `useState` value's initial expression (its span), by state name.
    let mut inits: HashMap<String, (u32, u32)> = HashMap::new();
    if let Some(body) = &function.body {
        for statement in &body.statements {
            match statement {
                Statement::VariableDeclaration(declaration) => {
                    convert_declaration(declaration, &hook_of, &mut work, &mut setters, &mut refs);
                    convert_context_and_reducer(
                        declaration,
                        &hook_of,
                        scoping,
                        &contexts,
                        &mut work,
                    );
                    record_inits(declaration, &hook_of, &mut inits);
                }
                Statement::ExpressionStatement(expression) => {
                    if let Expression::CallExpression(call) = &expression.expression {
                        if let Some(hook) = hook_of(&call.callee) {
                            let setter_of = |callee: &Expression<'_>| match callee {
                                Expression::Identifier(identifier) => scoping
                                    .get_reference(identifier.reference_id())
                                    .symbol_id()
                                    .and_then(|symbol| setters.get(&symbol).cloned()),
                                _ => None,
                            };
                            if !convert_reset(
                                call,
                                &hook,
                                statement.span(),
                                &setter_of,
                                &inits,
                                &mut work,
                            ) {
                                convert_effect(call, &hook, &mut work);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // Setter calls: `setCount(x)` → `(count = x)`; a setter passed along becomes a function.
    for (symbol, state) in &setters {
        for reference in scoping.get_resolved_references(*symbol) {
            let node = nodes.get_node(reference.node_id());
            let span = node.kind().span();
            match nodes.parent_kind(reference.node_id()) {
                AstKind::CallExpression(call) if call.callee.span() == span => {
                    let Some(argument) = call.arguments.first() else {
                        continue;
                    };
                    let argument_span = argument.span();
                    // As a statement, the assignment needs no parentheses.
                    let call_id = nodes.parent_id(reference.node_id());
                    let statement = matches!(nodes.parent_kind(call_id), AstKind::ExpressionStatement(_));
                    let (open, close) = if statement { ("", "") } else { ("(", ")") };
                    if matches!(
                        argument,
                        Argument::ArrowFunctionExpression(_) | Argument::FunctionExpression(_)
                    ) {
                        work.edit(span.start, argument_span.start, &format!("{open}{state} = ("));
                        work.edit(argument_span.end, call.span.end, &format!(")({state}){close}"));
                    } else {
                        work.edit(span.start, argument_span.start, &format!("{open}{state} = "));
                        work.edit(argument_span.end, call.span.end, close);
                    }
                }
                _ => work.edit(
                    span.start,
                    span.end,
                    &format!("((value) => ({state} = typeof value === \"function\" ? value({state}) : value))"),
                ),
            }
        }
    }
    if !setters.is_empty() {
        work.changes
            .push("`useState` became a `let` (state), and its setter calls assignments".to_owned());
    }
    // `ref.current` → `ref`.
    for symbol in &refs {
        for reference in scoping.get_resolved_references(*symbol) {
            let span = nodes.get_node(reference.node_id()).kind().span();
            match nodes.parent_kind(reference.node_id()) {
                AstKind::StaticMemberExpression(member)
                    if member.property.name == "current" && member.object.span() == span =>
                {
                    work.edit(member.span.start, member.span.end, &source[span.start as usize..span.end as usize]);
                }
                AstKind::JSXExpressionContainer(_) => {}
                _ => work.unsupported(
                    span.start,
                    "a ref used other than through `.current` or `ref={…}` isn't converted",
                    "an mnx ref is the element itself: `let input = null` with `ref={input}`, then `input.focus()`",
                ),
            }
        }
    }
    if !refs.is_empty() {
        work.changes.push(
            "`useRef` became a `let` holding the element or value, without `.current`".to_owned(),
        );
    }

    // Hooks left over: anything `use…` that wasn't converted.
    let mut leftovers = Leftovers {
        hook_of: &hook_of,
        calls: Vec::new(),
    };
    if let Some(body) = &function.body {
        leftovers.visit_function_body(body);
    }
    for (start, hook, converted) in leftovers.calls {
        if !converted || !work.covered(start) {
            if converted {
                work.unsupported(start, format!("`{hook}` isn't converted here"), "call hooks at the top of the component, as React requires; `mnx convert` converts them there");
            } else {
                work.unsupported(start, format!("`{hook}` isn't converted"), match hook.as_str() {
                    "useContext" => "use `inject(context)` from @mnx/runtime with `createContext` and `provide` (README, Context)",
                    "useReducer" => "keep the state in a `let` and write the reducer's cases as functions that assign it",
                    _ => "a custom hook can stay a function: call it once in the body, and have it use `let` state or `state()` signals",
                });
            }
        }
    }

    // JSX: `onChange` on text fields, a received event prop passed on, and what has no mnx
    // equivalent.
    let mut jsx = Jsx {
        work: &mut work,
        scoping,
        callbacks: &callbacks,
        contexts: &contexts,
    };
    jsx.visit_program(&parsed.program);

    // Imports: the converted hooks leave `react`; what's used comes from @mnx/runtime, in its
    // place.
    let mut runtime: Vec<&str> = work.used.iter().copied().collect();
    runtime.sort_unstable();
    let runtime_line = (!runtime.is_empty())
        .then(|| format!("import {{ {} }} from '@mnx/runtime';", runtime.join(", ")));
    if let Some(import) = react_import {
        let specifiers = import
            .specifiers
            .as_ref()
            .map_or(&[][..], |items| items.as_slice());
        let mut default = None;
        let mut named = Vec::new();
        for specifier in specifiers {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named_specifier) => {
                    if !CONVERTED.contains(&named_specifier.imported.name().as_str()) {
                        named.push(
                            &source[named_specifier.span.start as usize
                                ..named_specifier.span.end as usize],
                        );
                    }
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                    // `React` itself: kept only if something other than converted hooks uses it.
                    let used = scoping.get_resolved_references(specifier.local.symbol_id()).any(|reference| {
                        !matches!(nodes.parent_kind(reference.node_id()), AstKind::StaticMemberExpression(member) if CONVERTED.contains(&member.property.name.as_str()))
                    });
                    if used {
                        default = Some(specifier.local.name.as_str());
                    }
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {}
            }
        }
        let mut lines = Vec::new();
        if default.is_some() || !named.is_empty() {
            let mut parts: Vec<String> = default.map(str::to_owned).into_iter().collect();
            if !named.is_empty() {
                parts.push(format!("{{ {} }}", named.join(", ")));
            }
            let module =
                &source[import.source.span.start as usize + 1..import.source.span.end as usize - 1];
            lines.push(format!("import {} from '{module}';", parts.join(", ")));
        }
        lines.extend(runtime_line.clone());
        let mut end = import.span.end as usize;
        if lines.is_empty() {
            while source[end..].starts_with('\n') {
                end += 1;
            }
        }
        work.edit(import.span.start, end as u32, &lines.join("\n"));
    } else if let Some(line) = runtime_line {
        let after = parsed
            .program
            .body
            .iter()
            .filter(|statement| matches!(statement, Statement::ImportDeclaration(_)))
            .map(|statement| statement.span().end)
            .max();
        match after {
            Some(end) => work.edit(end, end, &format!("\n{line}")),
            None => work.edit(0, 0, &format!("{line}\n\n")),
        }
    }

    let output = work.apply();
    let extension = if typescript { "tsx" } else { "jsx" };
    let mut unsupported = work.unsupported;
    // The proof: does it compile as an mnx component?
    let compile_error = if unsupported.is_empty() {
        crate::compile_js(&output, "@mnx/runtime", &format!("{tag}.mnx.{extension}")).err()
    } else {
        None
    };
    unsupported.sort_by_key(|diagnostic| (diagnostic.span.line, diagnostic.span.column));
    let mut changes = Vec::new();
    for change in work.changes {
        if !changes.contains(&change) {
            changes.push(change);
        }
    }
    Ok(Conversion {
        output,
        file_name: format!("{tag}.mnx.{extension}"),
        tag,
        changes,
        unsupported,
        compile_error,
    })
}

struct Work<'s> {
    source: &'s str,
    edits: Vec<(u32, u32, String)>,
    /// Spans removed outright (a hook's dependency array): edits inside them are dropped.
    removed: Vec<(u32, u32)>,
    changes: Vec<String>,
    unsupported: Vec<Diagnostic>,
    used: HashSet<&'static str>,
}

impl Work<'_> {
    fn edit(&mut self, start: u32, end: u32, text: &str) {
        self.edits.push((start, end, text.to_owned()));
    }
    fn remove(&mut self, start: u32, end: u32) {
        self.removed.push((start, end));
        self.edit(start, end, "");
    }
    /// Whether `at` is the start of a converted hook call.
    fn covered(&self, at: u32) -> bool {
        self.edits.iter().any(|(start, _, _)| *start == at)
    }
    fn unsupported(&mut self, at: u32, message: impl Into<String>, help: &str) {
        self.unsupported
            .push(Diagnostic::new(at_offset(self.source, at), message).with_help(help));
    }
    fn apply(&self) -> String {
        let mut edits: Vec<&(u32, u32, String)> = self
            .edits
            .iter()
            .filter(|(start, end, _)| {
                !self
                    .removed
                    .iter()
                    .any(|(from, to)| (from, to) != (start, end) && from <= start && end <= to)
            })
            .collect();
        edits.sort_by_key(|(start, end, _)| (*start, *end));
        let mut output = String::with_capacity(self.source.len());
        let mut at = 0usize;
        for (start, end, text) in edits {
            let (start, end) = (*start as usize, *end as usize);
            if start < at {
                continue; // overlaps an earlier edit
            }
            output.push_str(&self.source[at..start]);
            output.push_str(text);
            at = end;
        }
        output.push_str(&self.source[at..]);
        output
    }
}

/// `const [a, setA] = useState(x)`, `const v = useMemo(…)`, `useCallback`, `useRef`.
fn convert_declaration<'a>(
    declaration: &VariableDeclaration<'a>,
    hook_of: &dyn Fn(&Expression<'a>) -> Option<String>,
    work: &mut Work<'_>,
    setters: &mut HashMap<SymbolId, String>,
    refs: &mut HashSet<SymbolId>,
) {
    for declarator in &declaration.declarations {
        let Some(Expression::CallExpression(call)) = &declarator.init else {
            continue;
        };
        let Some(hook) = hook_of(&call.callee) else {
            continue;
        };
        if !CONVERTED.contains(&hook.as_str()) {
            continue;
        }
        if declaration.declarations.len() > 1 {
            work.unsupported(
                declaration.span.start,
                format!("`{hook}` in a declaration of several names isn't converted"),
                "declare it on its own: `const [a, setA] = useState(0)`",
            );
            continue;
        }
        let first = call.arguments.first();
        let unwrap = |work: &mut Work<'_>| {
            // `hook(` … `)`, keeping the first argument.
            match first {
                Some(argument) => {
                    work.edit(call.span.start, argument.span().start, "");
                    work.remove(argument.span().end, call.span.end);
                }
                None => work.edit(call.span.start, call.span.end, "undefined"),
            }
        };
        let keyword = declaration.span.start;
        let keyword_end = keyword + declaration.kind.as_str().len() as u32;
        match hook.as_str() {
            "useState" => {
                let BindingPattern::ArrayPattern(pattern) = &declarator.id else {
                    work.unsupported(
                        declarator.span.start,
                        "`useState` not destructured into `[value, setValue]` isn't converted",
                        "write `const [count, setCount] = useState(0)`",
                    );
                    continue;
                };
                let Some(Some(BindingPattern::BindingIdentifier(state))) =
                    pattern.elements.first().map(|element| element.as_ref())
                else {
                    continue;
                };
                work.edit(keyword, keyword_end, "let");
                work.edit(pattern.span.start, pattern.span.end, &state.name);
                if let Some(Some(BindingPattern::BindingIdentifier(setter))) =
                    pattern.elements.get(1).map(|element| element.as_ref())
                {
                    setters.insert(setter.symbol_id(), state.name.to_string());
                }
                // A lazy initializer runs once anyway: `useState(() => x)` → `x`.
                match first {
                    Some(Argument::ArrowFunctionExpression(arrow))
                        if arrow.get_expression().is_some() && arrow.params.items.is_empty() =>
                    {
                        let body = arrow.get_expression().map_or(arrow.span, GetSpan::span);
                        work.edit(call.span.start, body.start, "");
                        work.remove(body.end, call.span.end);
                    }
                    Some(
                        Argument::ArrowFunctionExpression(_) | Argument::FunctionExpression(_),
                    ) => {
                        work.edit(call.span.start, first.unwrap().span().start, "(");
                        work.remove(first.unwrap().span().end, call.span.end);
                        work.edit(call.span.end, call.span.end, ")()");
                    }
                    _ => unwrap(work),
                }
            }
            "useMemo" => {
                match first {
                    Some(Argument::ArrowFunctionExpression(arrow))
                        if arrow.get_expression().is_some() =>
                    {
                        let body = arrow.get_expression().map_or(arrow.span, GetSpan::span);
                        work.edit(call.span.start, body.start, "");
                        work.remove(body.end, call.span.end);
                    }
                    Some(argument) => {
                        work.edit(call.span.start, argument.span().start, "(");
                        work.remove(argument.span().end, call.span.end);
                        work.edit(call.span.end, call.span.end, ")()");
                    }
                    None => continue,
                }
                work.changes.push(
                    "`useMemo` became a derived `const`: it stays in sync by itself".to_owned(),
                );
            }
            "useCallback" => {
                unwrap(work);
                work.changes.push(
                    "`useCallback` became a plain function (the body runs once per element)"
                        .to_owned(),
                );
            }
            "useContext" | "useReducer" | "createContext" => {} // convert_context_and_reducer
            "useRef" => {
                let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                    continue;
                };
                work.edit(keyword, keyword_end, "let");
                match first {
                    Some(_) => unwrap(work),
                    None => work.edit(call.span.start, call.span.end, "null"),
                }
                refs.insert(binding.symbol_id());
            }
            _ => {
                work.unsupported(
                    call.span.start,
                    format!("`{hook}` assigned to a name isn't converted"),
                    "effects don't return values",
                );
            }
        }
    }
}

/// `const v = useContext(Ctx)` → `inject(Ctx)`; `const [s, dispatch] = useReducer(r, init)` →
/// `let s = init` and a `dispatch` that assigns.
fn convert_context_and_reducer<'a>(
    declaration: &VariableDeclaration<'a>,
    hook_of: &dyn Fn(&Expression<'a>) -> Option<String>,
    scoping: &oxc_semantic::Scoping,
    contexts: &HashSet<SymbolId>,
    work: &mut Work<'_>,
) {
    for declarator in &declaration.declarations {
        let Some(Expression::CallExpression(call)) = &declarator.init else {
            continue;
        };
        let Some(hook) = hook_of(&call.callee) else {
            continue;
        };
        if declaration.declarations.len() > 1 {
            continue; // reported by convert_declaration
        }
        let keyword = declaration.span.start;
        let keyword_end = keyword + declaration.kind.as_str().len() as u32;
        match hook.as_str() {
            "useContext" => {
                let callee = call.callee.span();
                work.edit(callee.start, callee.end, "inject");
                work.used.insert("inject");
                let created_here = match call.arguments.first() {
                    Some(Argument::Identifier(identifier)) => scoping
                        .get_reference(identifier.reference_id())
                        .symbol_id()
                        .is_some_and(|symbol| contexts.contains(&symbol)),
                    _ => false,
                };
                if created_here {
                    work.changes.push("`useContext` became `inject()`: a signal that follows the nearest `provide()` above the element".to_owned());
                } else {
                    work.unsupported(
                        call.span.start,
                        "`useContext` became `inject()`, but its context comes from elsewhere",
                        "create that context with `createContext` from @mnx/runtime where it's exported, and have the providing component call `provide(context, value)`",
                    );
                }
            }
            "useReducer" => {
                let BindingPattern::ArrayPattern(pattern) = &declarator.id else {
                    work.unsupported(
                        declarator.span.start,
                        "`useReducer` not destructured into `[state, dispatch]` isn't converted",
                        "write `const [state, dispatch] = useReducer(reducer, initial)`",
                    );
                    continue;
                };
                let (Some(Some(BindingPattern::BindingIdentifier(state))), dispatch) = (
                    pattern.elements.first().map(|element| element.as_ref()),
                    pattern
                        .elements
                        .get(1)
                        .and_then(|element| match element.as_ref() {
                            Some(BindingPattern::BindingIdentifier(dispatch)) => {
                                Some(dispatch.name.as_str())
                            }
                            _ => None,
                        }),
                ) else {
                    continue;
                };
                let arguments = call.arguments.as_slice();
                let (Some(reducer), Some(initial)) = (arguments.first(), arguments.get(1)) else {
                    work.unsupported(
                        call.span.start,
                        "`useReducer` without an initial state isn't converted",
                        "pass the initial state as the second argument",
                    );
                    continue;
                };
                let reducer_text = work.source
                    [reducer.span().start as usize..reducer.span().end as usize]
                    .to_owned();
                let initial_text = work.source
                    [initial.span().start as usize..initial.span().end as usize]
                    .to_owned();
                // `useReducer(r, arg, init)`: the state starts as `init(arg)`.
                let start = match arguments.get(2) {
                    Some(init) => format!(
                        "({})({initial_text})",
                        &work.source[init.span().start as usize..init.span().end as usize]
                    ),
                    None => initial_text,
                };
                work.edit(keyword, keyword_end, "let");
                work.edit(pattern.span.start, pattern.span.end, &state.name);
                work.edit(call.span.start, call.span.end, &start);
                if let Some(dispatch) = dispatch {
                    let end = declaration.span.end;
                    work.edit(
                        end,
                        end,
                        &format!(
                            "\n  const {dispatch} = (action) => ({} = {reducer_text}({}, action));",
                            state.name, state.name
                        ),
                    );
                }
                work.changes.push("`useReducer` became a `let` and a `dispatch` that assigns the reducer's result".to_owned());
            }
            _ => {}
        }
    }
}

/// Where each `useState(x)` starts: `x`'s span, by the state's name (not for a lazy initializer).
fn record_inits<'a>(
    declaration: &VariableDeclaration<'a>,
    hook_of: &dyn Fn(&Expression<'a>) -> Option<String>,
    inits: &mut HashMap<String, (u32, u32)>,
) {
    for declarator in &declaration.declarations {
        let Some(Expression::CallExpression(call)) = &declarator.init else {
            continue;
        };
        if hook_of(&call.callee).as_deref() != Some("useState") {
            continue;
        }
        let BindingPattern::ArrayPattern(pattern) = &declarator.id else {
            continue;
        };
        let Some(Some(BindingPattern::BindingIdentifier(state))) =
            pattern.elements.first().map(|element| element.as_ref())
        else {
            continue;
        };
        if let [argument] = call.arguments.as_slice() {
            if !argument.is_spread()
                && !matches!(
                    argument,
                    Argument::ArrowFunctionExpression(_) | Argument::FunctionExpression(_)
                )
            {
                let span = argument.span();
                inits.insert(state.name.to_string(), (span.start, span.end));
            }
        }
    }
}

/// State reset when a prop changes: `useEffect(() => { setLeft(seconds) }, [seconds])`, where
/// each setter puts its state back to what `useState` started it with, becomes
/// `let left = from(seconds)` (or `from(seconds, false)` for another starting value), and the
/// effect goes. Whether it applied.
fn convert_reset(
    call: &CallExpression<'_>,
    hook: &str,
    statement: oxc_span::Span,
    setter_of: &dyn Fn(&Expression<'_>) -> Option<String>,
    inits: &HashMap<String, (u32, u32)>,
    work: &mut Work<'_>,
) -> bool {
    if hook != "useEffect" && hook != "useLayoutEffect" {
        return false;
    }
    let [Argument::ArrowFunctionExpression(arrow), Argument::ArrayExpression(deps)] =
        call.arguments.as_slice()
    else {
        return false;
    };
    let [key] = deps.elements.as_slice() else {
        return false;
    };
    if key.is_spread() || key.is_elision() || !arrow.params.items.is_empty() {
        return false;
    }
    let text = |span: oxc_span::Span| {
        work.source[span.start as usize..span.end as usize]
            .trim()
            .to_owned()
    };
    let key = text(key.span());
    let mut expressions = Vec::new();
    match (&arrow.body, arrow.get_expression()) {
        (_, Some(expression)) => expressions.push(expression),
        (oxc_ast::ast::ArrowFunctionBody::FunctionBody(body), None) => {
            for body_statement in &body.statements {
                let Statement::ExpressionStatement(expression) = body_statement else {
                    return false;
                };
                expressions.push(&expression.expression);
            }
        }
        _ => return false,
    }
    let mut resets = Vec::new();
    for expression in expressions {
        let Expression::CallExpression(set) = expression.without_parentheses() else {
            return false;
        };
        let (Some(state), [value]) = (setter_of(&set.callee), set.arguments.as_slice()) else {
            return false;
        };
        if value.is_spread() {
            return false;
        }
        let Some(&(start, end)) = inits.get(&state) else {
            return false;
        };
        let value = text(value.span());
        if work.source[start as usize..end as usize].trim() != value {
            return false;
        }
        resets.push((start, end, value));
    }
    if resets.is_empty() {
        return false;
    }
    for (start, end, value) in resets {
        let linked = if value == key {
            format!("from({key})")
        } else {
            format!("from({key}, {value})")
        };
        work.edit(start, end, &linked);
    }
    // The whole line, when the effect is alone on its lines.
    let bytes = work.source.as_bytes();
    let mut start = statement.start as usize;
    while start > 0 && matches!(bytes[start - 1], b' ' | b'\t') {
        start -= 1;
    }
    let mut end = statement.end as usize;
    if (start == 0 || bytes[start - 1] == b'\n') && bytes.get(end) == Some(&b'\n') {
        end += 1;
    } else {
        start = statement.start as usize;
    }
    work.remove(start as u32, end as u32);
    work.used.insert("from");
    work.changes.push(format!(
        "`{hook}` that reset state when `{key}` changed became `from({key})`: the state follows it until assigned, and starts over when it changes"
    ));
    true
}

/// `useEffect(fn, [])` → `onMount(fn)`; `useEffect(fn, deps)` or `useEffect(fn)` →
/// `onMount(() => effect(fn))`. Like React's, the effect then first runs after the element has
/// rendered, and (created after the template's own updates) after them on every change, so refs
/// and the DOM it reads are current.
fn convert_effect(call: &CallExpression<'_>, hook: &str, work: &mut Work<'_>) {
    if hook != "useEffect" && hook != "useLayoutEffect" {
        return;
    }
    let Some(first) = call.arguments.first() else {
        return;
    };
    let once = matches!(call.arguments.get(1), Some(Argument::ArrayExpression(array)) if array.elements.is_empty());
    work.used.insert("onMount");
    if once {
        work.edit(call.callee.span().start, call.callee.span().end, "onMount");
    } else {
        work.used.insert("effect");
        work.edit(
            call.callee.span().start,
            call.callee.span().end,
            "onMount(() => effect",
        );
        work.edit(call.span.end, call.span.end, ")");
    }
    if call.arguments.len() > 1 {
        work.remove(first.span().end, call.span.end - 1);
    }
    work.changes.push(if once {
        format!("`{hook}(…, [])` became `onMount(…)`")
    } else {
        format!("`{hook}(…, deps)` became `onMount(() => effect(…))`: it re-runs after the DOM updates whenever what it reads changes, so there are no dependencies to list")
    });
}

/// Hook calls anywhere in the component, to report the ones left.
struct Leftovers<'h, 'a> {
    hook_of: &'h dyn Fn(&Expression<'a>) -> Option<String>,
    calls: Vec<(u32, String, bool)>,
}

impl<'a> Visit<'a> for Leftovers<'_, 'a> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let hook = (self.hook_of)(&call.callee).or_else(|| match &call.callee {
            Expression::Identifier(identifier)
                if identifier.name.starts_with("use")
                    && identifier
                        .name
                        .chars()
                        .nth(3)
                        .is_some_and(|c| c.is_ascii_uppercase()) =>
            {
                Some(identifier.name.to_string())
            }
            _ => None,
        });
        if let Some(hook) = hook {
            let converted = CONVERTED.contains(&hook.as_str());
            self.calls.push((call.span.start, hook, converted));
        }
        walk::walk_call_expression(self, call);
    }
    fn visit_function_body(&mut self, body: &FunctionBody<'a>) {
        walk::walk_function_body(self, body);
    }
}

struct Jsx<'w, 's> {
    work: &'w mut Work<'s>,
    scoping: &'s oxc_semantic::Scoping,
    /// The component's `on<Name>` props.
    callbacks: &'w HashSet<SymbolId>,
    /// Contexts created in this file (`<Ctx.Provider>` can't be converted; `provide()` can).
    contexts: &'w HashSet<SymbolId>,
}

impl<'a> Visit<'a> for Jsx<'_, '_> {
    fn visit_jsx_opening_element(&mut self, element: &JSXOpeningElement<'a>) {
        let tag = match &element.name {
            JSXElementName::Identifier(identifier) => Some(identifier.name.as_str()),
            JSXElementName::IdentifierReference(identifier) => Some(identifier.name.as_str()),
            JSXElementName::MemberExpression(member) => {
                // `<Ctx.Provider value={…}>`: providing is a call in mnx, not an element.
                if member.property.name == "Provider" {
                    let created_here = match &member.object {
                        oxc_ast::ast::JSXMemberExpressionObject::IdentifierReference(
                            identifier,
                        ) => self
                            .scoping
                            .get_reference(identifier.reference_id())
                            .symbol_id()
                            .is_some_and(|symbol| self.contexts.contains(&symbol)),
                        _ => false,
                    };
                    self.work.unsupported(
                        element.span.start,
                        "`<Context.Provider>` isn't converted",
                        if created_here {
                            "call `provide(Context, value)` from @mnx/runtime in the script, and render the children directly; `inject(Context)` in a descendant follows it"
                        } else {
                            "create the context with `createContext` from @mnx/runtime, call `provide(Context, value)` in the script, and render the children directly"
                        },
                    );
                }
                None
            }
            _ => None,
        };
        let text_field = match tag {
            Some("textarea") => true,
            Some("input") => !element.attributes.iter().any(|item| {
                matches!(item, JSXAttributeItem::Attribute(attribute)
                    if matches!(&attribute.name, JSXAttributeName::Identifier(name) if name.name == "type")
                    && attribute.value.as_ref().is_some_and(|value| {
                        let text = &self.work.source[value.span().start as usize..value.span().end as usize];
                        ["checkbox", "radio", "range", "color", "file", "date", "time"].iter().any(|kind| text.contains(kind))
                    }))
            }),
            _ => false,
        };
        for item in &element.attributes {
            match item {
                JSXAttributeItem::SpreadAttribute(spread) => self.work.unsupported(
                    spread.span.start,
                    "spread attributes aren't converted",
                    "write each attribute out; mnx checks every one against the element",
                ),
                JSXAttributeItem::Attribute(attribute) => {
                    let JSXAttributeName::Identifier(name) = &attribute.name else {
                        continue;
                    };
                    // `onClose={onClose}` with a received event prop: an mnx event prop can only
                    // be called, so pass it on as a call.
                    if let Some(oxc_ast::ast::JSXAttributeValue::ExpressionContainer(container)) =
                        &attribute.value
                    {
                        if let Some(Expression::Identifier(identifier)) =
                            container.expression.as_expression()
                        {
                            let callback = self
                                .scoping
                                .get_reference(identifier.reference_id())
                                .symbol_id()
                                .is_some_and(|symbol| self.callbacks.contains(&symbol));
                            if callback && name.name.starts_with("on") {
                                let span = identifier.span;
                                self.work.edit(
                                    span.start,
                                    span.end,
                                    &format!("(event) => {}(event)", identifier.name),
                                );
                                if !self
                                    .work
                                    .changes
                                    .iter()
                                    .any(|change| change.starts_with("a received event prop"))
                                {
                                    self.work.changes.push("a received event prop passed on (`onClose={onClose}`) became a call, since an event prop fires the event".to_owned());
                                }
                            }
                        }
                    }
                    if name.name == "onDoubleClick" {
                        // React's name for the DOM's `dblclick`.
                        self.work.edit(name.span.start, name.span.end, "onDblClick");
                        if !self
                            .work
                            .changes
                            .iter()
                            .any(|change| change.starts_with("`onDoubleClick`"))
                        {
                            self.work.changes.push("`onDoubleClick` became `onDblClick` (the DOM's event is `dblclick`)".to_owned());
                        }
                    } else if name.name == "onChange" && text_field {
                        self.work.edit(name.span.start, name.span.end, "onInput");
                        if !self
                            .work
                            .changes
                            .iter()
                            .any(|change| change.starts_with("`onChange` on text fields"))
                        {
                            self.work.changes.push("`onChange` on text fields became `onInput` (the DOM's `change` waits for blur)".to_owned());
                        }
                    } else if name.name == "dangerouslySetInnerHTML" {
                        self.work.unsupported(
                            attribute.span.start,
                            "`dangerouslySetInnerHTML` isn't converted",
                            "render the content as elements, or set `innerHTML` on a `ref` after sanitizing it",
                        );
                    }
                }
            }
        }
        walk::walk_jsx_opening_element(self, element);
    }
}

fn at_offset(source: &str, offset: u32) -> Span {
    span_after(Span::new(1, 1), source, offset as usize)
}

fn kebab(name: &str) -> String {
    let mut out = String::new();
    for (index, character) in name.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if index > 0 {
                out.push('-');
            }
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}
