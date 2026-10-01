use crate::diagnostic::Span;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component {
    pub name: String,
    pub tag: Option<String>,
    pub props: Vec<Prop>,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Prop {
    pub name: String,
    pub kind: PropKind,
    pub value: serde_json::Value,
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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Part {
    Literal(String),
    Prop(usize),
}
