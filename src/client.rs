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
pub fn reasons(component: &ComponentAst, gaps: usize) -> Vec<String> {
    let mut found = Vec::new();
    own(component, &mut found);
    if gaps > 0 {
        found.push(format!(
            "{gaps} part{} computed in the browser",
            if gaps == 1 { " is" } else { "s are" }
        ));
    }
    for child in &component.children {
        // Its gaps are already in `gaps` (the server renders the children with the parent).
        for reason in reasons(&child.ast, 0) {
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
        if !component_imports.contains(&import.specifier.as_str()) {
            found.push(format!("imports `{}`", import.specifier));
        }
    }
    statements(&script.body, found);
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
fn statements(body: &str, found: &mut Vec<String>) {
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
                    // `let`s are state, reported above.
                    if declaration.kind.is_const() {
                        if let Some(init) = &declarator.init {
                            if !(Pure {
                                arrows: &arrows,
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
];
/// Methods of strings, numbers and arrays that return a value without side effects outside it.
const PURE_METHODS: &[&str] = &[
    "map",
    "filter",
    "reduce",
    "reduceRight",
    "slice",
    "join",
    "includes",
    "indexOf",
    "lastIndexOf",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "some",
    "every",
    "concat",
    "flat",
    "flatMap",
    "at",
    "keys",
    "values",
    "entries",
    "toSorted",
    "toReversed",
    "toSpliced",
    "with",
    "toFixed",
    "toPrecision",
    "toUpperCase",
    "toLowerCase",
    "trim",
    "trimStart",
    "trimEnd",
    "split",
    "replace",
    "replaceAll",
    "padStart",
    "padEnd",
    "startsWith",
    "endsWith",
    "repeat",
    "charAt",
    "charCodeAt",
    "codePointAt",
    "substring",
    "toString",
    "fill",
    "sort",
    "reverse",
    "length",
];

/// Whether an initializer only computes a value: literals, names, operators, arrow functions,
/// and calls that can't reach the browser (see the lists above).
struct Pure<'a, 'b> {
    arrows: &'a [(&'b str, &'b Expression<'b>)],
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
            E::ArrayExpression(array) => {
                array
                    .elements
                    .iter()
                    .all(|element| match element.as_expression() {
                        Some(expression) => self.expression(expression),
                        None => matches!(element, oxc_ast::ast::ArrayExpressionElement::Elision(_)),
                    })
            }
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
                if PURE_FUNCTIONS.contains(&name) {
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
