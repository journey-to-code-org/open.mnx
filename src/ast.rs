//! Syntax tree for a `.mnx` single-file component.
//!
//! ```text
//! <script>
//!   const title = "Mikey Nichols"
//! </script>
//! <mnx-header title={title}>        ← host: declares the element and its props
//!   <h1>{title}</h1>                ← template
//! </mnx-header>
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
    /// The component's `<style>`, scoped to it.
    pub style: Option<Style>,
    pub props: Vec<PropDecl>,
    pub script: Script,
    /// The template: the host element's children.
    pub nodes: Vec<Node>,
    /// Components imported from `.mnx` files, by tag, once loaded.
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
    /// Top-level `const`/`let` declarations, in source order.
    pub bindings: Vec<Binding>,
    /// Names the script declares that only exist at runtime (functions, classes, imports).
    pub runtime_names: Vec<String>,
    /// `import` statements, for the top of the JavaScript module.
    pub imports: Vec<Import>,
    /// Imports of other `.mnx` components (also present in `imports`).
    pub components: Vec<ComponentImport>,
    /// Everything else, verbatim: it runs once per component instance, during setup.
    pub body: String,
    /// The local name of `emit` imported from `@mnx/runtime`, if the script imports it.
    pub emit: Option<String>,
    /// Every `emit("name", detail)` call, in source order.
    pub emits: Vec<Emit>,
    /// TypeScript types of annotated bindings (`const title: string = …`), by name.
    pub declared_types: std::collections::HashMap<String, String>,
    /// For the typings of a TypeScript script: its exported type declarations and its imports as
    /// `import type`.
    pub type_declarations: Vec<String>,
    pub type_imports: Vec<String>,
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
/// (so `./button.mnx` can be rewritten to `./button.js` in the output).
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
        children: Vec<Node>,
        span: Span,
    },
    Slot {
        name: String,
        fallback: Vec<Node>,
        span: Span,
    },
    Else {
        children: Vec<Node>,
        span: Span,
    },
    /// `<mnx-await value={promise}>`: the pending content, then the `mnx-then` block with the
    /// resolved value (named by its `as`), or the `mnx-catch` block with the error.
    Await {
        value: Expression,
        value_span: Span,
        pending: Vec<Node>,
        then: Option<Branch>,
        catch: Option<Branch>,
        span: Span,
    },
    /// `<mnx-then as="…">` / `<mnx-catch as="…">`, before they're attached to their `mnx-await`.
    Settled {
        caught: bool,
        branch: Branch,
    },
}

/// An `mnx-then` or `mnx-catch` block: the name it binds (if any) and its content.
#[derive(Clone, Debug, PartialEq)]
pub struct Branch {
    pub name: Option<String>,
    pub children: Vec<Node>,
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
                key,
                children,
                ..
            } => {
                visit(items, *items_span);
                if let Some((key, span)) = key {
                    visit(key, *span);
                }
                for_each_expression(children, visit);
            }
            Node::Slot { fallback, .. } => for_each_expression(fallback, visit),
            Node::Else { children, .. } => for_each_expression(children, visit),
            Node::Await {
                value,
                value_span,
                pending,
                then,
                catch,
                ..
            } => {
                visit(value, *value_span);
                for_each_expression(pending, visit);
                for branch in then.iter().chain(catch) {
                    for_each_expression(&branch.children, visit);
                }
            }
            Node::Settled { branch, .. } => for_each_expression(&branch.children, visit),
        }
    }
}
