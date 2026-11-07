//! mnx: a compiler for Web Components written as HTML-first single-file components.
//!
//! Every entry point comes in two forms: one taking a source string (no `.mnx` imports
//! allowed, since there is nowhere to find them), and a `_file` / `_with` form that resolves
//! imported components — from the filesystem, or through a caller-supplied [`Loader`].

mod ast;
mod components;
mod diagnostic;
mod emit_interface;
mod emit_js;
mod events;
mod expression;
mod ir;
mod jsx;
mod migrate;
mod parser;
mod render;
mod request;
mod runtime_expression;
mod scanner;
mod script;
mod styles;
mod typescript;
mod validate;

pub use components::component_extension;
pub use components::{filesystem, Loader};
pub use diagnostic::{Diagnostic, Span};
pub use emit_interface::Framework;
pub use emit_js::StyleImports;
pub use migrate::{migrate, Migration};

fn parse_json(text: &str, what: &str) -> Result<serde_json::Value, Diagnostic> {
    serde_json::from_str(text).map_err(|error| {
        Diagnostic::new(
            Span::new(error.line(), error.column()),
            format!("invalid {what} JSON: {:?}", error.classify()),
        )
    })
}

fn load(
    source: &str,
    path: &str,
    loader: Option<Loader<'_>>,
) -> Result<ast::ComponentAst, Diagnostic> {
    let mut component = parser::parse(source)?;
    components::load(&mut component, path, loader)?;
    Ok(component)
}

/// Run `compile` on the component's `.mnx` text: the source itself, or what a JSX component
/// (by its path, or by its content when there's no path) lowers to, with errors placed in the
/// JSX.
fn front<T>(
    source: &str,
    path: Option<&str>,
    loader: Option<Loader<'_>>,
    compile: impl FnOnce(&str) -> Result<T, Diagnostic>,
) -> Result<T, Diagnostic> {
    let jsx = match path {
        Some(path) => jsx::is_jsx(path),
        None => jsx::looks_like_jsx(source),
    };
    if !jsx {
        return compile(source).map_err(|diagnostic| jsx::remap(diagnostic, None));
    }
    let path = path.unwrap_or("component.mnx.tsx");
    let lowered = jsx::lower(source, path, loader)?;
    compile(&lowered.text).map_err(|diagnostic| jsx::remap(diagnostic, Some((source, &lowered))))
}

fn read(path: &str) -> Result<String, Diagnostic> {
    std::fs::read_to_string(path).map_err(|error| {
        Diagnostic::new(
            Span::new(1, 1),
            format!("{path}: unable to read source: {error}"),
        )
    })
}

// ---- HTML -----------------------------------------------------------------------------------

pub fn compile(source: &str, props_json: &str) -> Result<String, Diagnostic> {
    compile_value(source, &parse_json(props_json, "props")?)
}

pub fn compile_with_slots(
    source: &str,
    props_json: &str,
    slots_json: &str,
) -> Result<String, Diagnostic> {
    compile_value_with_slots(
        source,
        &parse_json(props_json, "props")?,
        &parse_json(slots_json, "slots")?,
    )
}

pub fn compile_value(source: &str, props: &serde_json::Value) -> Result<String, Diagnostic> {
    compile_value_with_slots(source, props, &serde_json::json!({}))
}

pub fn compile_value_with_slots(
    source: &str,
    props: &serde_json::Value,
    slots: &serde_json::Value,
) -> Result<String, Diagnostic> {
    front(source, None, None, |source| {
        html(
            load(source, "component.mnx", None)?,
            props,
            slots,
            SlotSource::Template,
        )
    })
}

/// Static HTML for the component at `path`, resolving its `.mnx` imports from the filesystem.
pub fn compile_file(path: &str, props_json: &str, slots_json: &str) -> Result<String, Diagnostic> {
    compile_html_with(
        &read(path)?,
        path,
        props_json,
        slots_json,
        &components::filesystem,
    )
}

/// Static HTML, resolving `.mnx` imports with `loader`.
pub fn compile_html_with(
    source: &str,
    path: &str,
    props_json: &str,
    slots_json: &str,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    compile_html_from(
        source,
        path,
        props_json,
        slots_json,
        SlotSource::Template,
        loader,
    )
}

/// What slot content is written in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotSource {
    /// mnx template syntax (`{…}` is an expression; it has no scope, so only literals work).
    Template,
    /// HTML a server already rendered: kept as written (braces, comments, scripts and all).
    Html,
}

/// Static HTML, with slot content in `slot_source` syntax.
pub fn compile_html_from(
    source: &str,
    path: &str,
    props_json: &str,
    slots_json: &str,
    slot_source: SlotSource,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    compile_html_with_options(
        source,
        path,
        props_json,
        slots_json,
        HtmlOptions {
            slot_source,
            partial: false,
        },
        loader,
    )
}

/// How the HTML output is rendered.
#[derive(Clone, Copy, Debug)]
pub struct HtmlOptions {
    /// What slot content is written in.
    pub slot_source: SlotSource,
    /// Leave what only the browser can compute (JavaScript expressions, runtime-only values)
    /// for the element to fill in, instead of reporting it: the rest is server-rendered.
    pub partial: bool,
}

/// Static HTML, with options.
pub fn compile_html_with_options(
    source: &str,
    path: &str,
    props_json: &str,
    slots_json: &str,
    options: HtmlOptions,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    front(source, Some(path), Some(loader), |source| {
        let component = load(source, path, Some(loader))?;
        let props = parse_json(props_json, "props")?;
        let slots = parse_json(slots_json, "slots")?;
        if options.partial {
            html_partial(component, &props, &slots, options.slot_source)
        } else {
            html(component, &props, &slots, options.slot_source)
        }
    })
}

fn html_partial(
    component: ast::ComponentAst,
    props: &serde_json::Value,
    slots: &serde_json::Value,
    slot_source: SlotSource,
) -> Result<String, Diagnostic> {
    let previous = PARTIAL_HTML.with(|flag| flag.replace(true));
    let result = html(component, props, slots, slot_source);
    PARTIAL_HTML.with(|flag| flag.set(previous));
    result
}

thread_local! {
    static PARTIAL_HTML: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn html(
    component: ast::ComponentAst,
    props: &serde_json::Value,
    slots: &serde_json::Value,
    slot_source: SlotSource,
) -> Result<String, Diagnostic> {
    let slot_values = slots
        .as_object()
        .ok_or_else(|| Diagnostic::new(Span::new(1, 1), "component slots must be a JSON object"))?;
    let mut slot_nodes = std::collections::HashMap::new();
    for (name, source) in slot_values {
        let source = source.as_str().ok_or_else(|| {
            Diagnostic::new(
                Span::new(1, 1),
                format!("slot `{name}` must contain an mnx template string"),
            )
        })?;
        slot_nodes.insert(
            name.clone(),
            parser::parse_slot(source, slot_source == SlotSource::Html)?,
        );
    }
    let component = if PARTIAL_HTML.with(std::cell::Cell::get) {
        validate::validate_partial(component, props, &slot_nodes)?
    } else {
        validate::validate(component, props, &slot_nodes)?
    };
    Ok(render::render(&component))
}

// ---- JavaScript -----------------------------------------------------------------------------

/// Compile a component to a JavaScript module that defines its custom element.
///
/// `runtime` is the module specifier the output imports the runtime from (usually
/// `"@mnx/runtime"`); `source_name` appears in the generated header.
pub fn compile_js(source: &str, runtime: &str, source_name: &str) -> Result<String, Diagnostic> {
    front(source, Some(source_name), None, |source| {
        let component = load(source, source_name, None)?;
        emit_js::emit(
            &component,
            &emit_js::Options {
                runtime,
                source_name,
                component_extension: Some(".js"),
                style_imports: None,
            },
        )
    })
}

/// The JavaScript module for the component at `path`; `.mnx` imports become `.js` imports.
pub fn compile_js_file(path: &str, runtime: &str) -> Result<String, Diagnostic> {
    compile_js_with(
        &read(path)?,
        path,
        runtime,
        Some(".js"),
        &components::filesystem,
    )
}

/// The JavaScript module, resolving `.mnx` imports with `loader`. `component_extension`
/// rewrites `.mnx` import specifiers (`Some(".js")`), or keeps them (`None`) for bundlers that
/// load `.mnx` files themselves.
pub fn compile_js_with(
    source: &str,
    path: &str,
    runtime: &str,
    component_extension: Option<&str>,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    front(source, Some(path), Some(loader), |source| {
        let component = load(source, path, Some(loader))?;
        let source_name = std::path::Path::new(path).file_name().map_or_else(
            || path.to_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
        emit_js::emit(
            &component,
            &emit_js::Options {
                runtime,
                source_name: &source_name,
                component_extension,
                style_imports: None,
            },
        )
    })
}

/// The JavaScript module for a bundler plugin: `.mnx` imports are kept, and the `<style>` is
/// imported through the bundler (see [`StyleImports`]) instead of inlined.
pub fn compile_js_for_bundler(
    source: &str,
    path: &str,
    runtime: &str,
    style_imports: StyleImports<'_>,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    front(source, Some(path), Some(loader), |source| {
        let component = load(source, path, Some(loader))?;
        let source_name = std::path::Path::new(path).file_name().map_or_else(
            || path.to_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
        emit_js::emit(
            &component,
            &emit_js::Options {
                runtime,
                source_name: &source_name,
                component_extension: None,
                style_imports: Some(style_imports),
            },
        )
    })
}

// ---- styles ---------------------------------------------------------------------------------

/// The scoped stylesheet of the component at `path` and of every component it imports, for the
/// page's `<head>` (light-DOM components; shadow ones carry their own). Empty without styles.
pub fn compile_css_file(path: &str) -> Result<String, Diagnostic> {
    let source = read(path)?;
    front(
        &source,
        Some(path),
        Some(&components::filesystem),
        |source| {
            Ok(stylesheets(&load(
                source,
                path,
                Some(&components::filesystem),
            )?))
        },
    )
}

/// The scoped stylesheets of a component and what it imports, resolving imports with `loader`.
pub fn css_with(source: &str, path: &str, loader: Loader<'_>) -> Result<String, Diagnostic> {
    front(source, Some(path), Some(loader), |source| {
        Ok(stylesheets(&load(source, path, Some(loader))?))
    })
}

/// The compiler as one function: a JSON request in, a JSON response out (what the WebAssembly
/// build exposes). See [`request`](crate::request) for the format.
pub fn handle_request(request: &str) -> String {
    request::handle(request)
}

/// The scoped stylesheet of a component with no `.mnx` imports.
pub fn compile_css(source: &str) -> Result<String, Diagnostic> {
    front(source, None, None, |source| {
        Ok(stylesheets(&parser::parse(source)?))
    })
}

fn stylesheets(component: &ast::ComponentAst) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out = String::new();
    collect_stylesheets(component, &mut seen, &mut out);
    out
}

fn collect_stylesheets(
    component: &ast::ComponentAst,
    seen: &mut std::collections::HashSet<String>,
    out: &mut String,
) {
    for child in &component.children {
        collect_stylesheets(&child.ast, seen, out);
    }
    if seen.insert(component.tag.clone()) {
        if let Some(css) = styles::stylesheet(component) {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("/* {} */\n{css}", component.tag));
        }
    }
}

// ---- tools ----------------------------------------------------------------------------------

/// Things that compile but may not do what was meant: a prop that shadows a built-in property
/// of every element (`hidden` hides the host; `title` also shows a tooltip).
pub fn warnings(source: &str) -> Vec<Diagnostic> {
    let parsed = if jsx::looks_like_jsx(source) {
        // A JSX component's props are its parameters; their names are checked the same way.
        jsx::lower(source, "component.mnx.tsx", None)
            .ok()
            .and_then(|lowered| {
                parser::parse(&lowered.text)
                    .ok()
                    .map(|component| (component, Some(lowered)))
            })
    } else {
        parser::parse(source)
            .ok()
            .map(|component| (component, None))
    };
    let Some((component, lowered)) = parsed else {
        return Vec::new();
    };
    // 1.x code that 2.0 changes (JSX components already have 2.0's semantics).
    let deprecations = if lowered.is_none() {
        migrate::deprecations(source, &component)
    } else {
        Vec::new()
    };
    let mut warnings: Vec<Diagnostic> = component
        .props
        .iter()
        .filter_map(|prop| {
            let (_, effect) = BUILT_IN_PROPERTIES
                .iter()
                .find(|(name, _)| *name == prop.name)?;
            Some(
                Diagnostic::new(
                    prop.span,
                    format!(
                        "prop `{}` is also every element's built-in `{}`: {effect}",
                        prop.name, prop.name
                    ),
                )
                .with_help(format!(
                    "rename the prop if that isn't intended (e.g. `{}-text`)",
                    prop.name
                )),
            )
        })
        .map(|diagnostic| match &lowered {
            Some(lowered) => lowered.remap(source, diagnostic),
            None => diagnostic,
        })
        .collect();
    warnings.extend(deprecations);
    warnings
}

/// `HTMLElement` properties a prop would shadow, and what the attribute does on its own.
const BUILT_IN_PROPERTIES: &[(&str, &str)] = &[
    (
        "title",
        "the attribute also shows as a tooltip on the element",
    ),
    ("hidden", "the attribute also hides the element"),
    ("id", "the attribute is also the element's id"),
    (
        "slot",
        "the attribute also assigns the element to a slot of its parent",
    ),
    ("style", "the attribute is also the element's inline style"),
    (
        "lang",
        "the attribute also sets the language of the element's content",
    ),
    (
        "dir",
        "the attribute also sets the text direction of the element's content",
    ),
    (
        "inert",
        "the attribute also makes the element and its content inert",
    ),
    (
        "draggable",
        "the attribute also makes the element draggable",
    ),
    (
        "translate",
        "the attribute also controls translation of the element's content",
    ),
    ("popover", "the attribute also makes the element a popover"),
    (
        "autofocus",
        "the attribute also focuses the element on page load",
    ),
    ("tabIndex", "the attribute also makes the element focusable"),
    (
        "accessKey",
        "the attribute also gives the element a keyboard shortcut",
    ),
    (
        "contentEditable",
        "the attribute also makes the element's content editable",
    ),
    (
        "spellcheck",
        "the attribute also controls spell checking of the element's content",
    ),
    (
        "role",
        "the attribute also sets the element's accessibility role",
    ),
    ("className", "it is also the element's class list"),
];

/// A Custom Elements Manifest (`custom-elements.json`) describing the component, as the module
/// at `module_path` (the path the JavaScript output is published at).
pub fn compile_manifest(source: &str, module_path: &str) -> Result<String, Diagnostic> {
    front(source, None, None, |source| {
        emit_interface::manifest(&parser::parse(source)?, module_path)
    })
}

/// HTML custom data for editors (VS Code's `html.customData` format).
pub fn compile_html_data(source: &str) -> Result<String, Diagnostic> {
    front(source, None, None, |source| {
        emit_interface::html_data(&parser::parse(source)?)
    })
}

/// TypeScript declarations (`.d.ts`) for the JavaScript output.
pub fn compile_declarations(source: &str, source_name: &str) -> Result<String, Diagnostic> {
    compile_declarations_for(source, source_name, Framework::None)
}

/// TypeScript declarations where the default export is the `framework`'s wrapper component.
pub fn compile_declarations_for(
    source: &str,
    source_name: &str,
    framework: Framework,
) -> Result<String, Diagnostic> {
    let path = jsx::is_jsx(source_name).then_some(source_name);
    front(source, path, None, |source| {
        emit_interface::declarations(&parser::parse(source)?, source_name, framework)
    })
}
