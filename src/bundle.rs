//! A component and the components it imports, held in memory: what a Rust server renders from.
//! (The macro crate `zubra-macros` builds one at `cargo build` from a `.zb` file on disk.)

use std::collections::HashMap;

use crate::request::normalize;
use crate::{Diagnostic, HtmlOptions, SlotSource};

/// One component with the sources it imports (and theirs), ready to render, style and serve.
///
/// Every method compiles on the spot with the caller's data: nothing is cached here, so keep the
/// value (a `static`, or the application's state) and cache the output you reuse, such as
/// [`Component::css`] and [`Component::module`].
#[derive(Clone, Debug)]
pub struct Component {
    path: String,
    files: HashMap<String, String>,
}

impl Component {
    /// A component at `path` with `source`, and `imports`, the `(path, source)` of each `.zb` file
    /// it imports, directly or not. Paths are only names: they resolve the components' relative
    /// `import` specifiers against each other, and show up in error messages.
    pub fn new(path: &str, source: &str, imports: &[(&str, &str)]) -> Self {
        let path = normalize(path);
        let mut files: HashMap<String, String> = imports
            .iter()
            .map(|(path, source)| (normalize(path), (*source).to_owned()))
            .collect();
        files.insert(path.clone(), source.to_owned());
        Self { path, files }
    }

    /// The component's path, as given to [`Component::new`].
    pub fn path(&self) -> &str {
        &self.path
    }

    /// The component's source.
    pub fn source(&self) -> &str {
        &self.files[&self.path]
    }

    /// The component's host tag (`price-tag`).
    pub fn tag(&self) -> Result<String, Diagnostic> {
        crate::tag_of(self.source())
    }

    /// Compile the component and everything it imports, and report the first error: what
    /// `zubra check` does. Rendering reports the same errors, but only for the props it is given.
    pub fn check(&self) -> Result<(), Diagnostic> {
        self.module().map(|_| ())
    }

    /// The component as server-rendered HTML for `props` (a JSON object). What only the browser
    /// can compute is left for the element to fill in, so the page works without JavaScript and
    /// hydrates on top of what the server wrote.
    pub fn render(&self, props: &serde_json::Value) -> Result<String, Diagnostic> {
        self.render_with(props, &serde_json::json!({}), SlotSource::Html)
    }

    /// [`Component::render`] with slot content: `slots` maps each slot name to markup, written in
    /// `slot_source`'s syntax (use [`SlotSource::Html`] for HTML your server already rendered).
    pub fn render_with(
        &self,
        props: &serde_json::Value,
        slots: &serde_json::Value,
        slot_source: SlotSource,
    ) -> Result<String, Diagnostic> {
        crate::compile_html_with_options(
            self.source(),
            &self.path,
            &props.to_string(),
            &slots.to_string(),
            HtmlOptions {
                slot_source,
                partial: true,
                pending: Vec::new(),
            },
            &self.loader(),
        )
    }

    /// The scoped stylesheet of the component and what it imports, for the page's `<head>`.
    /// Empty when none of them has styles.
    pub fn css(&self) -> Result<String, Diagnostic> {
        crate::css_with(self.source(), &self.path, &self.loader())
    }

    /// The JavaScript module that defines the component's custom element, importing the runtime
    /// from `@zubra/runtime` and the components it uses from `./<tag>.js`.
    pub fn module(&self) -> Result<String, Diagnostic> {
        self.module_for("@zubra/runtime")
    }

    /// [`Component::module`] importing the runtime from `runtime` (any specifier the page's
    /// import map or the browser can resolve).
    pub fn module_for(&self, runtime: &str) -> Result<String, Diagnostic> {
        crate::compile_js_with(
            self.source(),
            &self.path,
            runtime,
            Some(".js"),
            &self.loader(),
        )
    }

    fn loader(&self) -> impl Fn(&str, &str) -> Result<(String, String), String> + '_ {
        move |specifier, from| {
            if !(specifier.starts_with("./")
                || specifier.starts_with("../")
                || specifier.starts_with('/'))
            {
                return Err("component imports must be relative paths (./ or ../)".to_owned());
            }
            let resolved = if specifier.starts_with('/') {
                normalize(specifier)
            } else {
                let base = from.rsplit_once('/').map_or("", |(directory, _)| directory);
                normalize(&format!("{base}/{specifier}"))
            };
            self.files
                .get(&resolved)
                .map(|source| (resolved.clone(), source.clone()))
                .ok_or_else(|| format!("{resolved}: not among the component's imports"))
        }
    }
}
