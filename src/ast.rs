use crate::diagnostic::Span;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComponentAst {
    pub name: String,
    pub tag: Option<String>,
    pub tag_span: Option<Span>,
    pub props: Vec<PropDecl>,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PropDecl {
    pub name: String,
    pub kind: PropKind,
    pub span: Span,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PropKind {
    String,
    Number,
    Boolean,
    Url,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Node {
    Text(Vec<Part>),
    Element(Element),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Element {
    pub name: String,
    pub attributes: Vec<Attribute>,
    pub children: Vec<Node>,
    pub span: Span,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attribute {
    pub name: String,
    pub value: Option<Vec<Part>>,
    pub span: Span,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Part {
    Literal(String),
    Interpolation { name: String, span: Span },
}
