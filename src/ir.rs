//! Static HTML IR: what the HTML backend renders. Every value is already known; conditions,
//! loops and slots have been expanded.

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component {
    pub tag: String,
    /// Render the template into a declarative shadow root instead of light DOM.
    pub shadow: bool,
    /// Prop values written back onto the host (only those that differ from their defaults), so
    /// a runtime can pick them up from the markup. `""` means a bare attribute.
    pub host_attributes: Vec<(String, String)>,
    pub nodes: Vec<Node>,
    /// Shadow-DOM components: supplied slot content, as the host's own (light DOM) children.
    pub light_children: Vec<Node>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Node {
    Text(Vec<Part>),
    Element(Element),
    /// `<!---->`: marks where a dynamic text node starts, for hydration.
    Anchor,
    /// `<!--[-->` and `<!--]-->`: the start and end of an `zb-if` or `zb-each` region, or of
    /// one row of a list, for hydration.
    Open,
    /// `<!--[!-->`: the start of a slot region holding supplied (static) content.
    OpenProjected,
    /// `<!--[?-->`: the start of a region the element renders (partial rendering left it empty).
    OpenClient,
    Close,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Element {
    pub name: String,
    pub attributes: Vec<Attribute>,
    pub children: Vec<Node>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attribute {
    pub name: String,
    /// `None` renders a bare attribute.
    pub value: Option<Vec<Part>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Part {
    /// Authored markup, preserved as written.
    Literal(String),
    /// A computed value, escaped when rendered.
    Escaped(String),
}
