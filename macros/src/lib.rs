//! `include_zb!("components/price-tag.zb")`: a Zubra component, checked at `cargo build` and
//! embedded in the binary with the components it imports.
//!
//! ```ignore
//! use std::sync::LazyLock;
//! use zubra::Component;
//! use zubra_macros::include_zb;
//!
//! static PRICE_TAG: LazyLock<Component> = LazyLock::new(|| include_zb!("components/price-tag.zb"));
//!
//! let html = PRICE_TAG.render(&serde_json::json!({ "amount": 12 }))?;
//! ```
//!
//! The path is relative to the crate's `Cargo.toml`. A component that doesn't compile fails the
//! build with Zubra's message, file and line included, and an edit to the file, or to any
//! component it imports, rebuilds the crate. The expansion is a [`zubra::Component`]; its `css()`
//! and `module()` give the stylesheet and the browser module as strings.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use proc_macro::{Delimiter, Literal, TokenStream, TokenTree};

#[proc_macro]
pub fn include_zb(input: TokenStream) -> TokenStream {
    match expand(input) {
        Ok(tokens) => tokens,
        Err(message) => compile_error(&message),
    }
}

fn expand(input: TokenStream) -> Result<TokenStream, String> {
    let relative = string_literal(input)?;
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .ok_or("include_zb!: CARGO_MANIFEST_DIR is not set")?;
    let entry = manifest.join(&relative);
    let entry = std::fs::canonicalize(&entry)
        .map_err(|error| format!("include_zb!: {}: {error}", entry.display()))?;
    let source = std::fs::read_to_string(&entry)
        .map_err(|error| format!("include_zb!: {}: {error}", entry.display()))?;

    // Compile it, remembering every file the compiler reads for its imports.
    let read: RefCell<Vec<(String, String)>> = RefCell::new(Vec::new());
    let loader = |specifier: &str, from: &str| -> Result<(String, String), String> {
        let found = zubra::filesystem(specifier, from)?;
        read.borrow_mut().push(found.clone());
        Ok(found)
    };
    let entry_name = entry.to_string_lossy().into_owned();
    zubra::compile_js_with(&source, &entry_name, "@zubra/runtime", Some(".js"), &loader).map_err(
        |diagnostic| {
            format!(
                "include_zb!(\"{relative}\"): {}",
                diagnostic.render_in(&source, &display(&manifest, &entry))
            )
        },
    )?;
    // Name the files by their path from the manifest, so the binary doesn't carry the build
    // machine's directories, and `include_str!` each so cargo rebuilds when one changes.
    let mut files: Vec<(String, String)> = read.into_inner();
    files.sort();
    files.dedup();
    let mut imports = String::new();
    for (path, _) in &files {
        imports.push_str(&format!(
            "({}, include_str!({})), ",
            quote(&display(&manifest, Path::new(path))),
            quote(path)
        ));
    }
    let code = format!(
        "::zubra::Component::new({name}, include_str!({absolute}), &[{imports}])",
        name = quote(&display(&manifest, &entry)),
        absolute = quote(&entry_name),
    );
    code.parse::<TokenStream>()
        .map_err(|error| format!("include_zb!: {error}"))
}

/// `path` relative to `manifest` (`components/a.zb`, or `../shared/b.zb` for a file outside the
/// crate), with forward slashes: the binary doesn't carry the build machine's directories.
fn display(manifest: &Path, path: &Path) -> String {
    let manifest = std::fs::canonicalize(manifest).unwrap_or_else(|_| manifest.to_path_buf());
    let base: Vec<_> = manifest.components().collect();
    let target: Vec<_> = path.components().collect();
    let shared = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
    // Nothing in common (another drive): keep the whole path.
    if shared == 0 {
        return path.to_string_lossy().replace('\\', "/");
    }
    let mut parts: Vec<String> = vec!["..".to_owned(); base.len() - shared];
    parts.extend(
        target[shared..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

fn string_literal(input: TokenStream) -> Result<String, String> {
    let mut tokens = input.into_iter();
    let first = tokens.next();
    if tokens.next().is_some() {
        return Err(
            "include_zb! takes one string literal: include_zb!(\"components/card.zb\")".into(),
        );
    }
    match first {
        Some(TokenTree::Literal(literal)) => unquote(&literal),
        // A literal passed on by another macro (`macro_rules! page { ($path:literal) =>
        // { include_zb!($path) } }`) arrives wrapped in a group with no delimiters.
        Some(TokenTree::Group(group)) if group.delimiter() == Delimiter::None => {
            string_literal(group.stream())
        }
        _ => {
            Err("include_zb! takes one string literal: include_zb!(\"components/card.zb\")".into())
        }
    }
}

fn unquote(literal: &Literal) -> Result<String, String> {
    let text = literal.to_string();
    let inner = text
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .ok_or("include_zb! takes a plain string literal: include_zb!(\"components/card.zb\")")?;
    if inner.contains('\\') {
        return Err("include_zb!: write the path without escapes".into());
    }
    Ok(inner.to_owned())
}

/// A Rust string literal for `text`.
fn quote(text: &str) -> String {
    format!("{text:?}")
}

/// The error, as an expression of the type the macro stands for: `include_zb!` is used where a
/// value is expected (`let card = include_zb!(…)`), and a bare `compile_error!(…);` there adds a
/// second error about the stray `;`, or about a `()` where a `Component` was meant.
fn compile_error(message: &str) -> TokenStream {
    format!(
        "{{ ::core::compile_error!({}); ::zubra::Component::new(\"\", \"\", &[]) }}",
        quote(message)
    )
    .parse()
    .expect("a compile_error! call parses")
}
