//! zubra: a compiler for Web Components written as HTML-first single-file components.
//!
//! # The supported API
//!
//! For a server that renders components, start with [`Component`]: a component and what it
//! imports, held in memory, with `render`, `css` and `module`. (The `zubra-macros` crate builds
//! one from a `.zb` file at `cargo build`: `include_zb!("components/price-tag.zb")`.)
//!
//! The rest of the supported surface is small, and follows semver from 5.x:
//!
//! - [`Component`], [`Diagnostic`] and [`Span`]: render, style and serve a component, and report
//!   what's wrong with it ([`Diagnostic::render_in`] prints it with its source line).
//! - [`compile_html_with_options`] with [`HtmlOptions`], [`SlotSource`] and a [`Loader`]
//!   ([`filesystem`] reads imports from disk): rendering with control over slots and streaming.
//! - [`compile_js_options`] with [`JsOptions`] and [`StyleImports`]; [`compile_css`] and
//!   [`css_with`]: what the browser loads.
//! - [`fn@format`] with [`FormatOptions`]: `zubra fmt`.
//! - [`handle_request`]: the compiler as one JSON request in and one JSON response out, the
//!   same protocol as `zubra request`, `zubra serve` and the WebAssembly build.
//!
//! Older entry points (`compile`, `compile_file`, `compile_html_from`, `compile_js`, …) still work
//! but are hidden from the documentation: they take their inputs as JSON strings and several
//! cover the same ground. They are kept through 5.x and may go in 6.0.

mod ast;
mod bundle;
mod components;
mod convert;
mod convert_element;
mod diagnostic;
mod emit_element;
mod emit_interface;
mod emit_js;
mod events;
mod expression;
mod format;
mod ir;
mod jsx;
mod parser;
mod pure;
mod reactive;
mod refactor;
mod render;
mod request;
mod runtime_expression;
mod scanner;
mod script;
mod styles;
mod typescript;
mod validate;

pub use bundle::Component;
pub use components::component_extension;
pub use components::{filesystem, Loader};
pub use convert::{convert, convert_component, Conversion};
pub use diagnostic::{Diagnostic, Span};
pub use emit_interface::Framework;
pub use emit_js::StyleImports;
pub use format::{format, format_range, is_ignored as format_is_ignored, FormatOptions, RangeEdit};
pub use refactor::{extract, Edit, Extraction};

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
    if let Some(component) = parsed::get(source, path, loader) {
        return Ok(component);
    }
    // Record what the loader answers, so a later request can check that the imports are unchanged.
    let answers = std::cell::RefCell::new(Vec::new());
    let recording = |specifier: &str, from: &str| {
        let answer = loader.map_or_else(|| Err(String::new()), |loader| loader(specifier, from));
        if let Ok(found) = &answer {
            answers.borrow_mut().push(parsed::Answer {
                specifier: specifier.to_owned(),
                from: from.to_owned(),
                found: found.clone(),
            });
        }
        answer
    };
    let mut component = parser::parse(source)?;
    components::load(
        &mut component,
        path,
        loader.map(|_| &recording as Loader<'_>),
    )?;
    parsed::put(source, path, &component, answers.into_inner());
    Ok(component)
}

/// Components already parsed and loaded, for a long-lived process (`zubra serve`, the WebAssembly
/// build behind `@zubra/server`) that renders the same files again and again. Parsing is most of
/// the cost of rendering a component; the rendering itself depends on the props and isn't kept.
/// An entry is used only when the source is the same and every import the loader answered last
/// time answers the same now, so an edited file or child is parsed again.
mod parsed {
    use crate::ast::ComponentAst;
    use crate::components::Loader;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// The most components kept; past it, the cache starts again (a server renders a few dozen).
    const LIMIT: usize = 512;

    pub struct Answer {
        pub specifier: String,
        pub from: String,
        pub found: (String, String),
    }

    struct Entry {
        component: ComponentAst,
        answers: Vec<Answer>,
    }

    thread_local! {
        static CACHE: RefCell<HashMap<(String, String), Entry>> = RefCell::new(HashMap::new());
    }

    pub fn get(source: &str, path: &str, loader: Option<Loader<'_>>) -> Option<ComponentAst> {
        CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            let key = (path.to_owned(), source.to_owned());
            let entry = cache.get(&key)?;
            let unchanged = entry.answers.iter().all(|answer| {
                loader.is_some_and(|loader| {
                    loader(&answer.specifier, &answer.from).is_ok_and(|found| found == answer.found)
                })
            });
            if unchanged {
                return Some(entry.component.clone());
            }
            cache.remove(&key);
            None
        })
    }

    pub fn put(source: &str, path: &str, component: &ComponentAst, answers: Vec<Answer>) {
        CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            if cache.len() >= LIMIT {
                cache.clear();
            }
            cache.insert(
                (path.to_owned(), source.to_owned()),
                Entry {
                    component: component.clone(),
                    answers,
                },
            );
        });
    }
}

/// Run `compile` on the component's `.zb` text: the source itself, or what a JSX component
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
    let path = path.unwrap_or("component.zb.tsx");
    let lowered = jsx::lower(source, path, loader)?;
    compile(&lowered.text).map_err(|diagnostic| jsx::remap(diagnostic, Some((source, &lowered))))
}

/// A JSX component as `.zb` text: the same lowering the compiler runs before compiling one.
/// (`zubra convert --as zubra` writes it as the converted file.)
pub fn lower_jsx(source: &str, path: &str) -> Result<String, Diagnostic> {
    jsx::lower_readable(source, path)
}

/// `zubra convert my-element.js`: a custom element class (the shape `--emit element` writes,
/// edited or written that way by hand) back to a `.zb` component.
pub fn convert_element(source: &str, path: &str) -> Result<convert::Conversion, Diagnostic> {
    convert_element::convert_element(source, path, &components::filesystem)
}

/// [`convert_element`] with a loader for the components it imports.
pub fn convert_element_with(
    source: &str,
    path: &str,
    loader: Loader<'_>,
) -> Result<convert::Conversion, Diagnostic> {
    convert_element::convert_element(source, path, loader)
}

/// `zubra convert --as zubra`: the conversion's JSX component as a readable `.zb` file. The
/// conversion's `output` and `file_name` are replaced, or, when the JSX can't be lowered yet
/// (something is still to finish by hand), a diagnostic says so and the JSX stays.
pub fn convert_as_zb(conversion: &mut convert::Conversion) -> Option<Diagnostic> {
    match jsx::lower_readable(&conversion.output, &conversion.file_name) {
        Ok(text) => {
            conversion.output = text;
            conversion.file_name = format!("{}.zb", conversion.tag);
            conversion
                .changes
                .push("written as an .zb file (HTML-first)".to_owned());
            None
        }
        Err(error) => Some(error.with_help(
            "finish the JSX component first; `--as zubra` writes the .zb file once it compiles",
        )),
    }
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

#[doc(hidden)]
pub fn compile(source: &str, props_json: &str) -> Result<String, Diagnostic> {
    compile_value(source, &parse_json(props_json, "props")?)
}

#[doc(hidden)]
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

#[doc(hidden)]
pub fn compile_value(source: &str, props: &serde_json::Value) -> Result<String, Diagnostic> {
    compile_value_with_slots(source, props, &serde_json::json!({}))
}

#[doc(hidden)]
pub fn compile_value_with_slots(
    source: &str,
    props: &serde_json::Value,
    slots: &serde_json::Value,
) -> Result<String, Diagnostic> {
    front(source, None, None, |source| {
        html(
            load(source, "component.zb", None)?,
            props,
            slots,
            SlotSource::Template,
        )
    })
}

/// Static HTML for the component at `path`, resolving its `.zb` imports from the filesystem.
#[doc(hidden)]
pub fn compile_file(path: &str, props_json: &str, slots_json: &str) -> Result<String, Diagnostic> {
    compile_html_with(
        &read(path)?,
        path,
        props_json,
        slots_json,
        &components::filesystem,
    )
}

/// Static HTML, resolving `.zb` imports with `loader`.
#[doc(hidden)]
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
    /// zubra template syntax (`{…}` is an expression; it has no scope, so only literals work).
    Template,
    /// HTML a server already rendered: kept as written (braces, comments, scripts and all).
    Html,
}

/// Static HTML, with slot content in `slot_source` syntax.
#[doc(hidden)]
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
            pending: Vec::new(),
        },
        loader,
    )
}

/// How the HTML output is rendered.
#[derive(Clone, Debug)]
pub struct HtmlOptions {
    /// What slot content is written in.
    pub slot_source: SlotSource,
    /// Leave what only the browser can compute (JavaScript expressions, runtime-only values)
    /// for the element to fill in, instead of reporting it: the rest is server-rendered.
    pub partial: bool,
    /// Props whose values aren't known yet (a streaming server's promises): rendered as unknown,
    /// so what depends on them is left as an empty region, to be filled when the value arrives.
    /// Implies `partial`.
    pub pending: Vec<String>,
}

/// What a server without JavaScript (the CLI, or any renderer of the HTML output) leaves out of
/// a component rendered with its defaults: each place partial rendering leaves for the browser,
/// as `(diagnostic, error)`. An attribute that changes what a form submits or shows (`checked`,
/// `selected`, `value`, `disabled`) is an error: without JavaScript, the form is wrong.
pub fn server_gaps(
    source: &str,
    path: &str,
    loader: Loader<'_>,
) -> Result<Vec<(Diagnostic, bool)>, Diagnostic> {
    let (rendered, gaps) = validate::record_gaps(|| {
        compile_html_with_options(
            source,
            path,
            "{}",
            "{}",
            HtmlOptions {
                slot_source: SlotSource::Template,
                partial: true,
                pending: Vec::new(),
            },
            loader,
        )
    });
    rendered?;
    let mut found: Vec<(Diagnostic, bool)> = gaps
        .into_iter()
        .map(|(span, attribute, child)| {
            let form = attribute.as_deref().is_some_and(|name| {
                matches!(name.to_ascii_lowercase().as_str(), "checked" | "selected" | "value" | "disabled")
            });
            let mut message = match &attribute {
                Some(name) if form => format!("`{name}` is computed in the browser, so the server's HTML leaves it out: without JavaScript, the form shows (and submits) the wrong thing"),
                Some(name) => format!("`{name}` is computed in the browser, so the server's HTML leaves it out"),
                None => "this is computed in the browser, so the server's HTML leaves it empty".to_owned(),
            };
            // A gap inside a child component: reported at its tag here, naming where it is.
            if let Some(child) = &child {
                let file = std::path::Path::new(&child.path)
                    .file_name()
                    .map_or(child.path.as_str(), |name| name.to_str().unwrap_or_default());
                message = format!(
                    "inside <{}> ({file}:{}:{}): {message}",
                    child.tag, child.span.line, child.span.column
                );
            }
            let help = "the server renders literals, props, member access, arithmetic, comparisons, logic, ternaries, template literals, arrow functions from the script and deterministic built-ins; compute the rest before rendering and pass it as a prop";
            (Diagnostic::new(span, message).with_help(help), form)
        })
        .collect();
    found.sort_by_key(|(diagnostic, _)| (diagnostic.span.line, diagnostic.span.column));
    Ok(found)
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
        let previous = validate::set_pending(options.pending.clone());
        let result = if options.partial || !options.pending.is_empty() {
            html_partial(component, &props, &slots, options.slot_source)
        } else {
            html(component, &props, &slots, options.slot_source)
        };
        validate::set_pending(previous);
        result
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
                format!("slot `{name}` must contain a zubra template string"),
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
/// `"@zubra/runtime"`); `source_name` appears in the generated header.
#[doc(hidden)]
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
                devtools: None,
            },
        )
    })
}

/// The JavaScript module for the component at `path`; `.zb` imports become `.js` imports.
#[doc(hidden)]
pub fn compile_js_file(path: &str, runtime: &str) -> Result<String, Diagnostic> {
    compile_js_with(
        &read(path)?,
        path,
        runtime,
        Some(".js"),
        &components::filesystem,
    )
}

/// The JavaScript module, resolving `.zb` imports with `loader`. `component_extension`
/// rewrites `.zb` import specifiers (`Some(".js")`), or keeps them (`None`) for bundlers that
/// load `.zb` files themselves.
#[doc(hidden)]
pub fn compile_js_with(
    source: &str,
    path: &str,
    runtime: &str,
    component_extension: Option<&str>,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    compile_js_options(
        source,
        path,
        &JsOptions {
            runtime,
            component_extension,
            style_imports: None,
            devtools: false,
        },
        loader,
    )
}

/// What a component's JavaScript module is compiled with; [`compile_js_options`] takes them all.
#[derive(Clone, Copy, Debug)]
pub struct JsOptions<'a> {
    /// The module specifier the output imports the runtime from.
    pub runtime: &'a str,
    /// Rewrite `.zb` imports to this extension, or keep them (`None`, for bundlers).
    pub component_extension: Option<&'a str>,
    /// Import the `<style>` through the bundler instead of inlining it.
    pub style_imports: Option<StyleImports<'a>>,
    /// For the browser DevTools (`--devtools`): record the path, each part's source location and
    /// the script's signals by name. For development builds only; it adds bytes.
    pub devtools: bool,
}

/// The JavaScript module for the component at `path`, with every option.
pub fn compile_js_options(
    source: &str,
    path: &str,
    options: &JsOptions<'_>,
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
                runtime: options.runtime,
                source_name: &source_name,
                component_extension: options.component_extension,
                style_imports: options.style_imports,
                devtools: options.devtools.then_some(path),
            },
        )
    })
}

/// The component as a plain custom element, with no runtime to install (`--emit element`): the
/// class you'd write by hand, with only the helpers the component uses (see `emit_element`).
/// Shadow DOM, spreads, zb-await and runtime features beyond the basics are refused with a reason.
#[doc(hidden)]
pub fn compile_element_file(path: &str) -> Result<String, Diagnostic> {
    compile_element_with(&read(path)?, path, Some(".js"), &components::filesystem)
}

/// [`compile_element_file`] for a source and loader.
#[doc(hidden)]
pub fn compile_element_with(
    source: &str,
    path: &str,
    component_extension: Option<&str>,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    let source_name = std::path::Path::new(path).file_name().map_or_else(
        || path.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    // A JSX component, lowered with its script readable (`let` state and props by name, as
    // `zubra convert --as zubra` writes it), so the element reads like any other: props as
    // `element.name`, state as `name.value`. What that lowering can't do yet goes the usual way.
    if jsx::is_jsx(path) {
        if let Ok(readable) = jsx::lower_for_element(source, path, Some(loader)) {
            if let Ok(module) = load(&readable, path, Some(loader)).and_then(|component| {
                emit_element::emit(&component, &source_name, component_extension)
            }) {
                return Ok(module);
            }
        }
    }
    front(source, Some(path), Some(loader), |source| {
        let component = load(source, path, Some(loader))?;
        emit_element::emit(&component, &source_name, component_extension)
    })
}

/// The JavaScript module for a bundler plugin: `.zb` imports are kept, and the `<style>` is
/// imported through the bundler (see [`StyleImports`]) instead of inlined.
#[doc(hidden)]
pub fn compile_js_for_bundler(
    source: &str,
    path: &str,
    runtime: &str,
    style_imports: StyleImports<'_>,
    loader: Loader<'_>,
) -> Result<String, Diagnostic> {
    compile_js_options(
        source,
        path,
        &JsOptions {
            runtime,
            component_extension: None,
            style_imports: Some(style_imports),
            devtools: false,
        },
        loader,
    )
}

// ---- styles ---------------------------------------------------------------------------------

/// The scoped stylesheet of the component at `path` and of every component it imports, for the
/// page's `<head>` (light-DOM components; shadow ones carry their own). Empty without styles.
#[doc(hidden)]
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
#[doc(hidden)]
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

/// The host tag of a component's source (`price-tag`), without loading its imports.
pub(crate) fn tag_of(source: &str) -> Result<String, Diagnostic> {
    front(source, None, None, |source| Ok(parser::parse(source)?.tag))
}

/// The scoped stylesheet of a component with no `.zb` imports.
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

/// Things that compile but may not do what was meant: a `'use …'` directive Zubra doesn't know,
/// and a prop that shadows a built-in property of every element (`hidden` hides the host; `title`
/// also shows a tooltip).
pub fn warnings(source: &str) -> Vec<Diagnostic> {
    // A pure function of the text, asked for on every request: kept per source, as parsed
    // components are (`parsed`), for long-lived processes that render the same files again.
    thread_local! {
        static SEEN: std::cell::RefCell<std::collections::HashMap<String, Vec<Diagnostic>>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    if let Some(found) = SEEN.with(|seen| seen.borrow().get(source).cloned()) {
        return found;
    }
    let found = warnings_of(source);
    SEEN.with(|seen| {
        let mut seen = seen.borrow_mut();
        if seen.len() >= 512 {
            seen.clear();
        }
        seen.insert(source.to_owned(), found.clone());
    });
    found
}

fn warnings_of(source: &str) -> Vec<Diagnostic> {
    let parsed = if jsx::looks_like_jsx(source) {
        // A JSX component's props are its parameters; their names are checked the same way.
        jsx::lower(source, "component.zb.tsx", None)
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
    let warnings: Vec<Diagnostic> = component
        .script
        .unknown_directives
        .iter()
        .cloned()
        .chain(component.props.iter().filter_map(|prop| {
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
        }))
        .map(|diagnostic| match &lowered {
            Some(lowered) => lowered.remap(source, diagnostic),
            None => diagnostic,
        })
        .collect();
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
/// The server half of a component (`--emit server`): the imports its `'use server'` functions
/// need, the functions themselves, and `actions`, which maps each function's URL to it. A
/// component without server functions emits a module with an empty `actions`.
pub fn compile_server(source: &str) -> Result<String, Diagnostic> {
    front(source, None, None, server_module)
}

fn server_module(source: &str) -> Result<String, Diagnostic> {
    let component = parser::parse(source)?;
    let script = &component.script;
    let mut out = format!(
        "// The server half of <{}>, generated by zubra: its 'use server' functions.\n",
        component.tag
    );
    for import in &script.server_imports {
        out.push_str(import);
        out.push('\n');
    }
    for export in &script.server_exports {
        out.push_str("\nexport ");
        out.push_str(&export.text);
        out.push('\n');
    }
    out.push_str(&format!(
        "\nexport const tag = {};\n",
        serde_json::json!(component.tag)
    ));
    out.push_str("export const actions = {");
    for (index, export) in script.server_exports.iter().enumerate() {
        out.push_str(if index == 0 { "\n" } else { ",\n" });
        out.push_str(&format!(
            "  {}: {}",
            serde_json::json!(ast::action_url(&component.tag, &export.name)),
            export.name
        ));
    }
    out.push_str(if script.server_exports.is_empty() {
        "};\n"
    } else {
        "\n};\n"
    });
    Ok(out)
}

/// The component's interface for servers (see [`emit_interface::server_interface`]).
pub fn compile_interface(source: &str) -> Result<String, Diagnostic> {
    front(source, None, None, |source| {
        emit_interface::server_interface(&parser::parse(source)?)
    })
}

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
