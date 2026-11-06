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
    /// `shadow` on the host opts into shadow DOM (light DOM is the default).
    pub shadow: bool,
    pub props: Vec<PropDecl>,
    pub script: Script,
    /// The template: the host element's children.
    pub nodes: Vec<Node>,
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
    /// `import` statements, verbatim, for the top of the JavaScript module.
    pub imports: Vec<String>,
    /// Everything else, verbatim: it runs once per component instance, during setup.
    pub body: String,
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
