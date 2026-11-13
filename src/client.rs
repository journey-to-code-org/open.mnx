//! Whether a component needs its module in the browser at all.
//!
//! Most components only show their props and slots: once the server has rendered them, with
//! their CSS in the page, there's nothing left for the browser to do, unless something changes
//! a prop later. This lists what *would* need the browser (state, handlers, lifecycle hooks, a
//! value computed in the browser, …), in this component and in the components it uses. An
//! empty list means the component is complete as server HTML: a page that never changes its
//! props from script can leave its module out (`@zubra/server`'s `clientModules: "needed"`).
//!
//! It errs toward the browser: anything it can't be sure of is a reason.

use oxc_allocator::Allocator;
use oxc_ast::ast::{BindingPattern, Expression, Statement};
use oxc_parser::Parser;
use oxc_span::SourceType;

use crate::ast::{Attribute, ComponentAst, Node};

/// Why the component needs its module in the browser; empty when it doesn't. `gaps` are the
/// parts the server's HTML leaves for the browser (from [`crate::server_gaps`]).
#[cfg(test)]
pub fn reasons(component: &ComponentAst, gaps: usize) -> Vec<String> {
    reasons_in(component, gaps, None)
}

/// [`reasons`], with the component's source: method calls in its template that the server can't
/// compute are reasons too, whichever branch the props choose (the gaps only cover the branches the
/// default props take).
pub fn reasons_in(component: &ComponentAst, gaps: usize, source: Option<&str>) -> Vec<String> {
    let mut found = Vec::new();
    own(component, &mut found);
    if let Some(source) = source {
        template_calls(source, &mut found);
    }
    if gaps > 0 {
        found.push(format!(
            "{gaps} part{} computed in the browser",
            if gaps == 1 { " is" } else { "s are" }
        ));
    }
    for child in &component.children {
        // Its gaps are already in `gaps` (the server renders the children with the parent).
        let child_source = std::fs::read_to_string(&child.path).ok();
        for reason in reasons_in(&child.ast, 0, child_source.as_deref()) {
            found.push(format!("<{}>: {reason}", child.ast.tag));
        }
    }
    found
}

fn own(component: &ComponentAst, found: &mut Vec<String>) {
    let script = &component.script;
    if component.form_associated {
        found.push("it's a form control (form-associated)".into());
    }
    for binding in &script.bindings {
        if binding.mutable {
            found.push(format!("state `{}`", binding.name));
        }
    }
    let component_imports: Vec<&str> = script
        .components
        .iter()
        .map(|import| import.specifier.as_str())
        .collect();
    for import in &script.imports {
        if component_imports.contains(&import.specifier.as_str()) || server_safe(import, script) {
            continue;
        }
        found.push(format!("imports `{}`", import.specifier));
    }
    // `const inputId = id()` is rendered by the server when every `id()` call is such a binding.
    let server_ids: Vec<&str> = script
        .bindings
        .iter()
        .filter(|binding| binding.id_call.is_some() && script.server_ids)
        .map(|binding| binding.name.as_str())
        .collect();
    // `const media = hasSlot('media')`: rendered by the server, nothing else happens.
    let rendered: Vec<&str> = script
        .imports
        .iter()
        .filter(|import| import.specifier == "@zubra/runtime")
        .filter_map(imported_names)
        .flatten()
        .filter(|(exported, _)| *exported == "hasSlot")
        .map(|(_, local)| local)
        .collect();
    statements(&script.body, &server_ids, &rendered, found);
    if !script.server_exports.is_empty() {
        found.push("server functions (actions)".into());
    }
    if script.collection.is_some() {
        found.push("a synced collection".into());
    }
    for prop in &component.props {
        if prop.model {
            found.push(format!("`{}` is two-way", prop.name));
        }
    }
    template(&component.nodes, found);
}

fn template(nodes: &[Node], found: &mut Vec<String>) {
    for node in nodes {
        match node {
            Node::Element(element) => {
                if element.name == "zb-outlet" {
                    found.push("an outlet".into());
                }
                for attribute in &element.attributes {
                    if let Some(reason) = attribute_reason(attribute) {
                        found.push(reason);
                    }
                }
                template(&element.children, found);
            }
            Node::If {
                consequent,
                alternate,
                animate,
                ..
            } => {
                if *animate {
                    found.push("motion (`animate`)".into());
                }
                template(consequent, found);
                template(alternate, found);
            }
            Node::Each {
                children, animate, ..
            } => {
                if *animate {
                    found.push("motion (`animate`)".into());
                }
                template(children, found);
            }
            Node::Else { children, .. } => template(children, found),
            Node::Slot { fallback, .. } => template(fallback, found),
            Node::Await { .. } => found.push("async data (`zb-await`)".into()),
            Node::Settled { branch, .. } => template(&branch.children, found),
            Node::Text(_) => {}
        }
    }
}

fn attribute_reason(attribute: &Attribute) -> Option<String> {
    let name = attribute.name.as_str();
    let lower = name.to_ascii_lowercase();
    if crate::parser::is_event_attribute(&lower) {
        let event = lower.trim_start_matches("on");
        let event = event.split('.').next().unwrap_or(event);
        return Some(format!("handles `{event}`"));
    }
    if name == crate::parser::SPREAD {
        return Some("a spread (`{...}`)".into());
    }
    if name == "ref" || name == "zb-animate" {
        return Some(format!("`{name}`"));
    }
    match name.split_once(':') {
        // Derived from props, which the server renders.
        Some(("class" | "style" | "let", _)) | None => None,
        Some(_) => Some(format!("`{name}`")),
    }
}

/// The script's top-level statements that run in the browser when the element starts: a
/// `const` computed by a call, destructuring, or a statement that isn't a declaration.
/// Definitions (functions, classes, arrow functions, values the server can compute) don't.
fn statements(body: &str, server_ids: &[&str], rendered: &[&str], found: &mut Vec<String>) {
    if body.trim().is_empty() {
        return;
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, body, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        found.push("the script runs code in the browser".into());
        return;
    }
    // Arrow functions defined in the script: calling one runs only its body, checked the same way.
    let mut arrows: Vec<(&str, &Expression)> = Vec::new();
    for statement in &parsed.program.body {
        if let Statement::VariableDeclaration(declaration) = statement {
            for declarator in &declaration.declarations {
                if let (BindingPattern::BindingIdentifier(identifier), Some(init)) =
                    (&declarator.id, &declarator.init)
                {
                    if matches!(init, Expression::ArrowFunctionExpression(_)) {
                        arrows.push((identifier.name.as_str(), init));
                    }
                }
            }
        }
    }
    let mut runs = false;
    for statement in &parsed.program.body {
        match statement {
            Statement::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    let BindingPattern::BindingIdentifier(identifier) = &declarator.id else {
                        found.push("destructuring in the script".into());
                        continue;
                    };
                    // `let`s are state, reported above; ids the server renders are known.
                    if declaration.kind.is_const()
                        && !server_ids.contains(&identifier.name.as_str())
                    {
                        if let Some(init) = &declarator.init {
                            if !(Pure {
                                arrows: &arrows,
                                rendered,
                                depth: 0,
                            })
                            .expression(init)
                            {
                                found.push(format!(
                                    "`{}` is computed in the browser",
                                    identifier.name
                                ));
                            }
                        }
                    }
                }
            }
            Statement::FunctionDeclaration(_)
            | Statement::ClassDeclaration(_)
            | Statement::EmptyStatement(_)
            | Statement::TSTypeAliasDeclaration(_)
            | Statement::TSInterfaceDeclaration(_) => {}
            Statement::ExportNamedDeclaration(export) => {
                if !export.export_kind.is_type() {
                    runs = true;
                }
            }
            _ => runs = true,
        }
    }
    if runs {
        found.push("the script runs code in the browser".into());
    }
}

/// Browser globals: reading or calling one is work only the browser does.
const BROWSER: &[&str] = &[
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "localStorage",
    "sessionStorage",
    "globalThis",
    "self",
    "console",
    "fetch",
    "setTimeout",
    "setInterval",
    "requestAnimationFrame",
    "queueMicrotask",
    "performance",
    "crypto",
    "Date",
    "Intl",
    "matchMedia",
    "customElements",
    "IntersectionObserver",
    "ResizeObserver",
    "MutationObserver",
    "addEventListener",
    "Promise",
];
/// Static functions that compute a value and touch nothing else.
const PURE_STATICS: &[&str] = &[
    "Math", "Number", "String", "Object", "Array", "JSON", "Boolean",
];
const PURE_FUNCTIONS: &[&str] = &[
    "Number",
    "String",
    "Boolean",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "encodeURI",
    "decodeURIComponent",
    "decodeURI",
];
/// Methods of strings, numbers and arrays that return a value without side effects, and that the
/// server's evaluator (`pure.rs`) computes: no more, or a component could count as complete on the
/// server when the server leaves part of it empty. `the_method_list_is_what_the_server_evaluates`
/// holds the two together. (Mutating ones, `sort` and `reverse`, aren't: `toSorted`, `toReversed`.
/// Nor is `toString`: the server computes it on numbers, not arrays, and this can't tell which.)
const PURE_METHODS: &[&str] = &[
    "at",
    "charAt",
    "concat",
    "endsWith",
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flat",
    "flatMap",
    "includes",
    "indexOf",
    "join",
    "lastIndexOf",
    "map",
    "padEnd",
    "padStart",
    "reduce",
    "repeat",
    "replace",
    "replaceAll",
    "slice",
    "some",
    "split",
    "startsWith",
    "substring",
    "toFixed",
    "toLowerCase",
    "toReversed",
    "toSorted",
    "toSpliced",
    "toUpperCase",
    "trim",
    "trimEnd",
    "trimStart",
    "with",
];

/// Whether an initializer only computes a value: literals, names, operators, arrow functions,
/// and calls that can't reach the browser (see the lists above).
struct Pure<'a, 'b> {
    arrows: &'a [(&'b str, &'b Expression<'b>)],
    /// Local names of runtime functions the server renders (`hasSlot`).
    rendered: &'a [&'a str],
    depth: usize,
}

impl Pure<'_, '_> {
    fn expression(&self, expression: &Expression) -> bool {
        use Expression as E;
        match expression {
            E::BooleanLiteral(_)
            | E::NullLiteral(_)
            | E::NumericLiteral(_)
            | E::StringLiteral(_)
            | E::BigIntLiteral(_)
            | E::RegExpLiteral(_) => true,
            E::Identifier(identifier) => !BROWSER.contains(&identifier.name.as_str()),
            // A definition runs nothing; a call to it is checked where it's called.
            E::ArrowFunctionExpression(_) | E::FunctionExpression(_) => true,
            E::TemplateLiteral(template) => template.expressions.iter().all(|e| self.expression(e)),
            E::ArrayExpression(array) => array.elements.iter().all(|element| match element {
                oxc_ast::ast::ArrayExpressionElement::SpreadElement(spread) => {
                    self.expression(&spread.argument)
                }
                oxc_ast::ast::ArrayExpressionElement::Elision(_) => true,
                element => element
                    .as_expression()
                    .is_some_and(|expression| self.expression(expression)),
            }),
            E::ObjectExpression(object) => {
                object.properties.iter().all(|property| match property {
                    oxc_ast::ast::ObjectPropertyKind::ObjectProperty(property) => {
                        (!property.computed
                            || property
                                .key
                                .as_expression()
                                .is_some_and(|key| self.expression(key)))
                            && self.expression(&property.value)
                    }
                    oxc_ast::ast::ObjectPropertyKind::SpreadProperty(spread) => {
                        self.expression(&spread.argument)
                    }
                })
            }
            E::BinaryExpression(binary) => {
                self.expression(&binary.left) && self.expression(&binary.right)
            }
            E::LogicalExpression(logical) => {
                self.expression(&logical.left) && self.expression(&logical.right)
            }
            E::ConditionalExpression(conditional) => {
                self.expression(&conditional.test)
                    && self.expression(&conditional.consequent)
                    && self.expression(&conditional.alternate)
            }
            E::UnaryExpression(unary) => self.expression(&unary.argument),
            E::ParenthesizedExpression(inner) => self.expression(&inner.expression),
            E::StaticMemberExpression(member) => self.expression(&member.object),
            E::ComputedMemberExpression(member) => {
                self.expression(&member.object) && self.expression(&member.expression)
            }
            E::ChainExpression(chain) => match chain.expression.as_member_expression() {
                Some(member) => self.expression(member.object()),
                None => false,
            },
            E::CallExpression(call) => {
                let arguments = call.arguments.iter().all(|argument| match argument {
                    oxc_ast::ast::Argument::SpreadElement(spread) => {
                        self.expression(&spread.argument)
                    }
                    argument => argument
                        .as_expression()
                        .is_some_and(|argument| self.expression(argument)),
                });
                arguments && self.callee(&call.callee)
            }
            _ => false,
        }
    }

    fn callee(&self, callee: &Expression) -> bool {
        match callee {
            Expression::Identifier(identifier) => {
                let name = identifier.name.as_str();
                if PURE_FUNCTIONS.contains(&name) || self.rendered.contains(&name) {
                    return true;
                }
                // An arrow from the script: its body, once (recursion is the browser's).
                self.depth < 8
                    && self.arrows.iter().any(|(arrow, init)| {
                        *arrow == name
                            && match init {
                                Expression::ArrowFunctionExpression(function) => {
                                    let inner = Pure {
                                        arrows: self.arrows,
                                        rendered: self.rendered,
                                        depth: self.depth + 1,
                                    };
                                    match &function.body {
                                        oxc_ast::ast::ArrowFunctionBody::FunctionBody(block) => {
                                            block.statements.iter().all(|statement| match statement
                                            {
                                                Statement::ExpressionStatement(statement) => {
                                                    inner.expression(&statement.expression)
                                                }
                                                Statement::ReturnStatement(statement) => {
                                                    statement.argument.as_ref().is_none_or(
                                                        |argument| inner.expression(argument),
                                                    )
                                                }
                                                Statement::VariableDeclaration(declaration) => {
                                                    declaration.declarations.iter().all(
                                                        |declarator| {
                                                            declarator.init.as_ref().is_none_or(
                                                                |init| inner.expression(init),
                                                            )
                                                        },
                                                    )
                                                }
                                                _ => false,
                                            })
                                        }
                                        body => body
                                            .as_expression()
                                            .is_some_and(|expression| inner.expression(expression)),
                                    }
                                }
                                _ => false,
                            }
                    })
            }
            Expression::StaticMemberExpression(member) => {
                let method = member.property.name.as_str();
                match &member.object {
                    Expression::Identifier(object)
                        if PURE_STATICS.contains(&object.name.as_str()) =>
                    {
                        !(object.name == "Math" && method == "random")
                    }
                    object => PURE_METHODS.contains(&method) && self.expression(object),
                }
            }
            _ => false,
        }
    }
}

/// `.name(` calls inside the template's `{…}` (outside `<script>` and `<style>`) whose method the
/// server doesn't compute. A call on a name the script defines (`{format(x)}`) isn't a method.
fn template_calls(source: &str, found: &mut Vec<String>) {
    let mut template = source.to_owned();
    for tag in ["script", "style"] {
        while let Some(start) = template.find(&format!("<{tag}")) {
            let end = template[start..]
                .find(&format!("</{tag}>"))
                .map_or(template.len(), |end| start + end + tag.len() + 3);
            template.replace_range(start..end, "");
        }
    }
    let mut depth = 0usize;
    let mut expression = String::new();
    let mut seen: Vec<String> = Vec::new();
    for character in template.chars() {
        match character {
            '{' => {
                // Nested braces (`${…}` in a template literal) stay part of the expression.
                if depth > 0 {
                    expression.push('{');
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth > 0 {
                    expression.push('}');
                }
                if depth == 0 {
                    for name in called_methods(&expression) {
                        if !PURE_METHODS.contains(&name) && !seen.iter().any(|seen| seen == name) {
                            seen.push(name.to_owned());
                            found.push(format!(
                                "`.{name}()` in the template is computed in the browser"
                            ));
                        }
                    }
                    expression.clear();
                }
            }
            character if depth > 0 => expression.push(character),
            _ => {}
        }
    }
}

/// The methods called in an expression: the name after a `.` (or `?.`) and before a `(`.
fn called_methods(expression: &str) -> Vec<&str> {
    let bytes = expression.as_bytes();
    let mut names = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'.' {
            let start = index + 1;
            let mut end = start;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'$')
            {
                end += 1;
            }
            // `Math.max(…)`, `Object.keys(…)`: a static the script's rules allow, not a method.
            let receiver = expression[..index]
                .rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
                .next()
                .unwrap_or_default();
            let name = &expression[start..end];
            let pure_static =
                PURE_STATICS.contains(&receiver) && !(receiver == "Math" && name == "random");
            if end > start
                && expression[end..].trim_start().starts_with('(')
                && !bytes[start].is_ascii_digit()
                && !pure_static
            {
                names.push(name);
            }
            index = end.max(index + 1);
        } else {
            index += 1;
        }
    }
    names
}

/// The runtime functions the server renders, which do nothing else: `hasSlot()` (whether a slot
/// has content), and `id()` when the script's ids are numbered on the server (`server_ids`).
fn server_rendered(name: &str, script: &crate::ast::Script) -> bool {
    name == "hasSlot" || (name == "id" && script.server_ids)
}

/// The names an `import { a, b as c } from '...'` brings in: (exported, local).
fn imported_names(import: &crate::ast::Import) -> Option<Vec<(&str, &str)>> {
    let (before, rest) = import.text.split_once('{')?;
    before
        .trim_start()
        .strip_prefix("import")
        .filter(|b| b.trim().is_empty())?;
    let (names, _) = rest.split_once('}')?;
    Some(
        names
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| match name.split_once(" as ") {
                Some((exported, local)) => (exported.trim(), local.trim()),
                None => (name, name),
            })
            .collect(),
    )
}

/// An import of only functions the server renders from `@zubra/runtime` (see `server_rendered`).
fn server_safe(import: &crate::ast::Import, script: &crate::ast::Script) -> bool {
    import.specifier == "@zubra/runtime"
        && imported_names(import).is_some_and(|names| {
            names
                .iter()
                .all(|(exported, _)| server_rendered(exported, script))
        })
}

#[cfg(test)]
mod tests {
    fn reasons(source: &str) -> Vec<String> {
        super::reasons(&crate::parser::parse(source).unwrap(), 0)
    }

    #[test]
    fn a_component_that_only_shows_its_props_needs_nothing() {
        assert_eq!(reasons("<zb-x label=\"x\" items={[]}><p class:on={label}>{label}</p><zb-each items={items} as=\"i\"><b>{i}</b></zb-each><zb-slot></zb-slot></zb-x>"), Vec::<String>::new());
        let script = "<script>\n  const low = Math.min(...items)\n  const fmt = (n) => n.toFixed(2)\n  const shown = items.map((i) => fmt(i)).join(\", \")\n  function later() { return 1 }\n</script>\n<zb-x items={[]}><p>{shown} {low}</p></zb-x>";
        assert_eq!(
            reasons(script),
            Vec::<String>::new(),
            "computed on the server"
        );
    }

    #[test]
    fn the_method_list_is_what_the_server_evaluates() {
        for method in super::PURE_METHODS {
            let call = match *method {
                "toFixed" => "(1.5).toFixed(1)".to_owned(),
                "charAt" => "'ab'.charAt(0)".to_owned(),
                "substring" => "'ab'.substring(1)".to_owned(),
                "endsWith" | "padEnd" | "padStart" | "repeat" | "replace" | "replaceAll"
                | "split" | "startsWith" | "toLowerCase" | "toUpperCase" | "trim" | "trimEnd"
                | "trimStart" => match *method {
                    "replace" | "replaceAll" => format!("'ab'.{method}('a', 'c')"),
                    "padEnd" | "padStart" | "repeat" => format!("'ab'.{method}(3)"),
                    _ => format!("'ab'.{method}('a')"),
                },
                "flat" | "toSorted" | "toReversed" | "join" => {
                    format!("[2, 1].{method}()")
                }
                "concat" | "includes" | "indexOf" | "lastIndexOf" | "at" | "slice" => {
                    format!("[2, 1].{method}(1)")
                }
                "with" | "toSpliced" => format!("[2, 1].{method}(0, 3)"),
                "reduce" => "[2, 1].reduce((a, b) => a + b, 0)".to_owned(),
                _ => format!("[2, 1].{method}((x) => x > 1)"),
            };
            assert!(
                crate::pure::evaluate(&call, &|_| None).is_ok(),
                "the server doesn't compute {call}"
            );
        }
    }

    #[test]
    fn template_calls_the_server_cant_compute_are_reasons_whatever_the_props() {
        let source = "<zb-x items={[]} sorted={false}>\n  <p>{sorted ? items.sort().join(', ') : items.toSorted().join(', ')}</p><b>{format(Math.max(1, 2))} {Math.random()}</b><i style:width={`${Math.min(1, 2)}%`}></i>\n</zb-x>";
        let mut found = Vec::new();
        super::template_calls(source, &mut found);
        assert_eq!(
            found,
            vec![
                "`.sort()` in the template is computed in the browser".to_owned(),
                "`.random()` in the template is computed in the browser".to_owned(),
            ]
        );
    }

    #[test]
    fn has_slot_and_array_copies_are_rendered_by_the_server() {
        let script = "<script>\n  import { hasSlot as has } from '@zubra/runtime'\n  const media = has('media')\n  const list = sorted ? [...items].toSorted((a, b) => b - a) : items\n</script>\n<zb-x items={[]} sorted={false}><div zb-if={media}><zb-slot name=\"media\"></zb-slot></div><zb-each items={list} as=\"i\"><b>{i}</b></zb-each></zb-x>";
        assert_eq!(reasons(script), Vec::<String>::new());
        // With another runtime import, or a spread of something the browser computes, it isn't.
        let with_hook = "<script>\n  import { hasSlot, onMount } from '@zubra/runtime'\n  const media = hasSlot('media')\n</script>\n<zb-x><p>x</p></zb-x>";
        assert_eq!(
            reasons(with_hook),
            vec!["imports `@zubra/runtime`".to_owned()]
        );
        let browser = "<script>\n  const all = [...document.querySelectorAll('p')]\n</script>\n<zb-x><p>x</p></zb-x>";
        assert_eq!(
            reasons(browser),
            vec!["`all` is computed in the browser".to_owned()]
        );
    }

    #[test]
    fn state_handlers_hooks_and_browser_work_are_reasons() {
        for (source, expected) in [
            ("<script>\n  let n = 0\n</script>\n<zb-x><p>{n}</p></zb-x>", "state `n`"),
            ("<zb-x><button onclick={() => 1}>x</button></zb-x>", "handles `click`"),
            ("<zb-x value:model={0}><p>{value}</p></zb-x>", "`value` is two-way"),
            ("<zb-x form-associated><p>x</p></zb-x>", "it's a form control (form-associated)"),
            ("<script>\n  import { onMount } from '@zubra/runtime'\n</script>\n<zb-x><p>x</p></zb-x>", "imports `@zubra/runtime`"),
            ("<script>\n  const id = Math.random()\n</script>\n<zb-x><p>x</p></zb-x>", "`id` is computed in the browser"),
            ("<script>\n  const t = setInterval(() => {}, 9)\n</script>\n<zb-x><p>x</p></zb-x>", "`t` is computed in the browser"),
            ("<script>\n  const f = () => fetch('/x')\n  const r = f()\n</script>\n<zb-x><p>x</p></zb-x>", "`r` is computed in the browser"),
            ("<script>\n  console.log(1)\n</script>\n<zb-x><p>x</p></zb-x>", "the script runs code in the browser"),
            ("<zb-x><input ref={el} /></zb-x>", "`ref`"),
        ] {
            assert!(reasons(source).iter().any(|reason| reason == expected), "{source}: {:?}", reasons(source));
        }
    }
}
