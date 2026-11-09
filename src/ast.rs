//! Syntax tree for a `.zb` single-file component.
//!
//! ```text
//! <script>
//!   const title = "Mikey Nichols"
//! </script>
//! <zb-header title={title}>        ← host: declares the element and its props
//!   <h1>{title}</h1>                ← template
//! </zb-header>
//! ```

use crate::diagnostic::Span;
use crate::expression::Expression;

#[derive(Clone, Debug, PartialEq)]
pub struct ComponentAst {
    /// The custom-element name, from the host tag.
    pub tag: String,
    pub tag_span: Span,
    /// From an HTML comment above the host tag (or above the script).
    pub description: Option<String>,
    /// `shadow` on the host opts into shadow DOM (light DOM is the default).
    pub shadow: bool,
    /// `form-associated` on the host makes the element a form control (ElementInternals).
    pub form_associated: bool,
    /// `host-reset` on a shadow host: the host's styles are protected from the page's (for
    /// components on pages you don't control).
    pub host_reset: bool,
    /// The component's `<style>`, scoped to it.
    pub style: Option<Style>,
    pub props: Vec<PropDecl>,
    pub script: Script,
    /// The template: the host element's children.
    pub nodes: Vec<Node>,
    /// Components imported from `.zb` files, by tag, once loaded.
    pub children: Vec<ChildComponent>,
}

/// A component's `<style>` block.
#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    pub css: String,
    /// The cascade layer it goes in (`components` unless `layer="…"`; `None` for `layer="none"`).
    pub layer: Option<String>,
    /// A preprocessor language (`scss`, …) for a bundler to run; `None` for plain CSS.
    pub lang: Option<String>,
    /// Where the CSS starts.
    pub span: Span,
}

impl ComponentAst {
    pub fn child(&self, tag: &str) -> Option<&ChildComponent> {
        self.children
            .iter()
            .find(|child| child.ast.tag.eq_ignore_ascii_case(tag))
    }
}

/// A prop, declared by an attribute on the host tag.
#[derive(Clone, Debug, PartialEq)]
pub struct PropDecl {
    pub name: String,
    pub default: PropDefault,
    /// `value:model={…}`: assigning the prop inside the component fires `<prop>change`.
    pub model: bool,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PropDefault {
    /// `title` — no default; the prop is required.
    Required,
    /// `title="Mikey"` — a string default.
    Text(String),
    /// `title={expr}` — evaluated in the script's scope.
    Expression(Expression, Span),
}

/// What the compiler understood of the `<script>` block.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Script {
    /// Where the script's text starts in the file (`None` without a `<script>`).
    pub start: Option<Span>,
    /// Top-level `const`/`let` declarations, in source order.
    pub bindings: Vec<Binding>,
    /// Names the script declares that only exist at runtime (functions, classes, imports).
    pub runtime_names: Vec<String>,
    /// `import` statements, for the top of the JavaScript module.
    pub imports: Vec<Import>,
    /// Imports of other `.zb` components (also present in `imports`).
    pub components: Vec<ComponentImport>,
    /// Everything else, verbatim: it runs once per component instance, during setup.
    pub body: String,
    /// The local names of `from` imported from `@zubra/runtime` (`let x = from(prop)`).
    pub from: Vec<String>,
    /// The local name of `emit` imported from `@zubra/runtime`, if the script imports it.
    pub emit: Option<String>,
    /// Every `emit("name", detail)` call, in source order.
    pub emits: Vec<Emit>,
    /// TypeScript types of annotated bindings (`const title: string = …`), by name.
    pub declared_types: std::collections::HashMap<String, String>,
    /// For the typings of a TypeScript script: its exported type declarations and its imports as
    /// `import type`.
    pub type_declarations: Vec<String>,
    pub type_imports: Vec<String>,
    /// `declare const value: T` in a TypeScript script: the prop's type, by prop name, and
    /// where it's declared.
    pub prop_types: Vec<(String, String, Span)>,
    /// `'use collection tasks'` at the top of the script: its top-level `let`s are the fields of
    /// a document in a local store, kept by `@zubra/sync`.
    pub collection: Option<Collection>,
    /// `let editing = ephemeral(false)` (from `@zubra/sync`): state that isn't stored.
    pub ephemeral: Vec<String>,
    /// `let cursor = presence({ x: 0, y: 0 })`: state shared live with the document's other
    /// viewers, never stored.
    pub presence: Vec<String>,
    /// `let others = peers()`: the other viewers' presence, as an array.
    pub peers: Option<String>,
}

/// `'use collection <name>'`, or `'use collection <name> by <prop>, <prop>'`.
#[derive(Clone, Debug, PartialEq)]
pub struct Collection {
    pub name: String,
    /// The props whose values make the document's key (`doc` unless `by` says otherwise; not
    /// `id`, which is every element's own DOM id and must be unique on a page).
    pub keys: Vec<String>,
    pub span: Span,
}

/// An `emit("name", detail)` call: the component fires a DOM event called `name`.
#[derive(Clone, Debug, PartialEq)]
pub struct Emit {
    pub name: String,
    /// The TypeScript type of `detail`, inferred from the argument's shape.
    pub detail: String,
    pub span: Span,
}

/// An `import` statement, kept verbatim, with where its module specifier is inside the text
/// (so `./button.zb` can be rewritten to `./button.js` in the output).
#[derive(Clone, Debug, PartialEq)]
pub struct Import {
    pub text: String,
    pub specifier: String,
    pub specifier_range: std::ops::Range<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ComponentImport {
    pub specifier: String,
    pub span: Span,
}

/// A component this one uses, loaded and parsed (see `components.rs`).
#[derive(Clone, Debug, PartialEq)]
pub struct ChildComponent {
    pub path: String,
    pub source: String,
    pub ast: ComponentAst,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub name: String,
    /// `None` when the initializer is outside the build-time expression language (a call,
    /// a function, …): the binding exists, but only at runtime.
    pub init: Option<Expression>,
    /// The initializer as written, for what the subset doesn't cover (calls, arrow functions):
    /// the server may still evaluate it (`pure.rs`).
    pub source: Option<String>,
    pub mutable: bool,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Text(Vec<Part>),
    Element(Element),
    If {
        test: Expression,
        test_span: Span,
        consequent: Vec<Node>,
        alternate: Vec<Node>,
        span: Span,
    },
    Each {
        items: Expression,
        items_span: Span,
        item: String,
        index: Option<String>,
        /// `key={todo.id}`: rows follow their key when the list is reordered.
        key: Option<(Expression, Span)>,
        /// `let:total={item.price * item.qty}`: names derived once per row (4.3).
        lets: Vec<Let>,
        children: Vec<Node>,
        span: Span,
    },
    Slot {
        name: String,
        fallback: Vec<Node>,
        span: Span,
    },
    /// `<zb-else>`, or `<zb-else-if test={…}>` (with its test), before it's attached to its
    /// `zb-if`.
    Else {
        test: Option<(Expression, Span)>,
        children: Vec<Node>,
        span: Span,
    },
    /// `<zb-await value={promise}>`: the pending content, then the `zb-then` block with the
    /// resolved value (named by its `as`), or the `zb-catch` block with the error.
    Await {
        value: Expression,
        value_span: Span,
        pending: Vec<Node>,
        then: Option<Branch>,
        catch: Option<Branch>,
        /// `delay={ms}`: show the pending content only once the value has been pending this long.
        delay: Option<(Expression, Span)>,
        /// `keep`: a reload keeps the settled content (the host gets `:state(loading)`).
        keep: bool,
        span: Span,
    },
    /// `<zb-then as="…">` / `<zb-catch as="…">`, before they're attached to their `zb-await`.
    Settled {
        caught: bool,
        branch: Branch,
    },
}

/// An `zb-then` or `zb-catch` block: the name it binds (if any) and its content.
#[derive(Clone, Debug, PartialEq)]
pub struct Branch {
    pub name: Option<String>,
    /// `let:name={…}` on a zb-then (4.3).
    pub lets: Vec<Let>,
    pub children: Vec<Node>,
    pub span: Span,
}

/// `let:name={expression}`: a name for an expression, in scope inside the element, derived
/// (read again when what it reads changes) and read-only.
#[derive(Clone, Debug, PartialEq)]
pub struct Let {
    pub name: String,
    pub value: Expression,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    pub name: String,
    pub attributes: Vec<Attribute>,
    pub children: Vec<Node>,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Attribute {
    pub name: String,
    pub value: AttributeValue,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AttributeValue {
    /// `disabled`
    None,
    /// `class="card {kind}"` — text, possibly with interpolations; always a string.
    Text(Vec<Part>),
    /// `data={value}` — a value of any type.
    Expression(Expression, Span),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Literal(String),
    Expression { expression: Expression, span: Span },
}

/// Call `visit` with every expression in `nodes` (text, attributes, directives), with its span.
pub fn for_each_expression(nodes: &[Node], visit: &mut dyn FnMut(&Expression, Span)) {
    let parts = |parts: &[Part], visit: &mut dyn FnMut(&Expression, Span)| {
        for part in parts {
            if let Part::Expression { expression, span } = part {
                visit(expression, *span);
            }
        }
    };
    for node in nodes {
        match node {
            Node::Text(text) => parts(text, visit),
            Node::Element(element) => {
                for attribute in &element.attributes {
                    match &attribute.value {
                        AttributeValue::None => {}
                        AttributeValue::Text(text) => parts(text, visit),
                        AttributeValue::Expression(expression, span) => visit(expression, *span),
                    }
                }
                for_each_expression(&element.children, visit);
            }
            Node::If {
                test,
                test_span,
                consequent,
                alternate,
                ..
            } => {
                visit(test, *test_span);
                for_each_expression(consequent, visit);
                for_each_expression(alternate, visit);
            }
            Node::Each {
                items,
                items_span,
                lets,
                key,
                children,
                ..
            } => {
                visit(items, *items_span);
                if let Some((key, span)) = key {
                    visit(key, *span);
                }
                for binding in lets {
                    visit(&binding.value, binding.span);
                }
                for_each_expression(children, visit);
            }
            Node::Slot { fallback, .. } => for_each_expression(fallback, visit),
            Node::Else { test, children, .. } => {
                if let Some((test, span)) = test {
                    visit(test, *span);
                }
                for_each_expression(children, visit);
            }
            Node::Await {
                value,
                value_span,
                pending,
                then,
                catch,
                delay,
                ..
            } => {
                visit(value, *value_span);
                if let Some((delay, span)) = delay {
                    visit(delay, *span);
                }
                for_each_expression(pending, visit);
                for branch in then.iter().chain(catch) {
                    for binding in &branch.lets {
                        visit(&binding.value, binding.span);
                    }
                    for_each_expression(&branch.children, visit);
                }
            }
            Node::Settled { branch, .. } => for_each_expression(&branch.children, visit),
        }
    }
}

/// One step from a value to a destructured name: a property or an index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Key(String),
    Index(usize),
}

/// The names an `as` binds, each with its path into the value: `item` is `[("item", [])]`;
/// `{ name, address: { city } }` is `name` at `.name` and `city` at `.address.city`; `[a, , b]`
/// is `a` at `[0]` and `b` at `[2]`. Patterns take names, renames (`{ id: key }`), nesting and
/// holes; defaults and rest elements are errors (write them in the script).
pub fn bindings(pattern: &str) -> Result<Vec<(String, Vec<Step>)>, String> {
    let mut parser = PatternParser {
        text: pattern.as_bytes(),
        at: 0,
    };
    let mut out = Vec::new();
    parser.space();
    parser.pattern(&mut Vec::new(), &mut out)?;
    parser.space();
    if parser.at != parser.text.len() {
        return Err(format!(
            "unexpected `{}` in the pattern",
            &pattern[parser.at..]
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for (name, _) in &out {
        if !seen.insert(name.clone()) {
            return Err(format!("`{name}` is bound twice in the pattern"));
        }
    }
    Ok(out)
}

/// Whether an `as` is a destructuring pattern rather than one name.
pub fn is_pattern(text: &str) -> bool {
    matches!(text.trim_start().as_bytes().first(), Some(b'{' | b'['))
}

struct PatternParser<'t> {
    text: &'t [u8],
    at: usize,
}

impl PatternParser<'_> {
    fn space(&mut self) {
        while self.text.get(self.at).is_some_and(u8::is_ascii_whitespace) {
            self.at += 1;
        }
    }
    fn eat(&mut self, byte: u8) -> bool {
        self.space();
        if self.text.get(self.at) == Some(&byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn identifier(&mut self) -> Option<String> {
        self.space();
        let start = self.at;
        while self
            .text
            .get(self.at)
            .is_some_and(|&b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
        {
            self.at += 1;
        }
        let name = std::str::from_utf8(&self.text[start..self.at]).ok()?;
        (!name.is_empty() && !name.as_bytes()[0].is_ascii_digit()).then(|| name.to_owned())
    }
    fn reject_extras(&mut self) -> Result<(), String> {
        self.space();
        if self.text[self.at..].starts_with(b"...") {
            return Err(
                "a rest element (`...`) can't go in an `as` pattern; pick the names you need"
                    .into(),
            );
        }
        Ok(())
    }
    fn pattern(
        &mut self,
        path: &mut Vec<Step>,
        out: &mut Vec<(String, Vec<Step>)>,
    ) -> Result<(), String> {
        self.reject_extras()?;
        if self.eat(b'{') {
            loop {
                if self.eat(b'}') {
                    return Ok(());
                }
                self.reject_extras()?;
                let key = if self.eat(b'"') {
                    let start = self.at;
                    while self.text.get(self.at).is_some_and(|&b| b != b'"') {
                        self.at += 1;
                    }
                    let key = String::from_utf8_lossy(&self.text[start..self.at]).into_owned();
                    self.at += 1;
                    key
                } else {
                    self.identifier()
                        .ok_or("expected a property name in the pattern")?
                };
                path.push(Step::Key(key.clone()));
                if self.eat(b':') {
                    self.pattern(path, out)?;
                } else {
                    out.push((key, path.clone()));
                }
                path.pop();
                self.space();
                if self.text.get(self.at) == Some(&b'=') {
                    return Err("a default (`= …`) can't go in an `as` pattern; use `??` where the value is read".into());
                }
                if !self.eat(b',') {
                    return if self.eat(b'}') {
                        Ok(())
                    } else {
                        Err("expected , or } in the pattern".into())
                    };
                }
            }
        }
        if self.eat(b'[') {
            let mut index = 0;
            loop {
                if self.eat(b']') {
                    return Ok(());
                }
                if self.eat(b',') {
                    index += 1; // a hole
                    continue;
                }
                path.push(Step::Index(index));
                self.pattern(path, out)?;
                path.pop();
                self.space();
                if self.text.get(self.at) == Some(&b'=') {
                    return Err("a default (`= …`) can't go in an `as` pattern; use `??` where the value is read".into());
                }
                index += 1;
                if !self.eat(b',') {
                    return if self.eat(b']') {
                        Ok(())
                    } else {
                        Err("expected , or ] in the pattern".into())
                    };
                }
            }
        }
        let name = self
            .identifier()
            .ok_or("expected a name, or a { … } or [ … ] pattern")?;
        out.push((name, path.clone()));
        Ok(())
    }
}

#[cfg(test)]
mod pattern_tests {
    use super::*;

    #[test]
    fn patterns_bind_names_at_paths() {
        assert_eq!(bindings("item").unwrap(), vec![("item".into(), vec![])]);
        assert_eq!(
            bindings("{ name, address: { city }, id: key }").unwrap(),
            vec![
                ("name".into(), vec![Step::Key("name".into())]),
                (
                    "city".into(),
                    vec![Step::Key("address".into()), Step::Key("city".into())]
                ),
                ("key".into(), vec![Step::Key("id".into())]),
            ]
        );
        assert_eq!(
            bindings("[a, , [b]]").unwrap(),
            vec![
                ("a".into(), vec![Step::Index(0)]),
                ("b".into(), vec![Step::Index(2), Step::Index(0)])
            ]
        );
        assert!(bindings("{ a = 1 }").unwrap_err().contains("default"));
        assert!(bindings("[a, ...rest]").unwrap_err().contains("rest"));
        assert!(bindings("{ a, a }").unwrap_err().contains("twice"));
        assert!(bindings("{ a b }").is_err());
    }
}
