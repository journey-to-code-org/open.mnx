//! Loading the components a component imports.
//!
//! `import "./button.zb"` in a `<script>` makes `<zb-button>` a known child component: the
//! compiler loads and parses it (recursively), so the HTML backend can render it inline and the
//! JavaScript backend can pass it props as values and find its slotted content. Where sources
//! come from is up to the caller — the filesystem for the CLI, a bundler's resolver for a plugin.

use crate::{
    ast::{ChildComponent, ComponentAst},
    diagnostic::Diagnostic,
    parser,
};

/// Finds and reads an imported component: `(specifier, importer path)` → `(path, source)`.
pub type Loader<'a> = &'a dyn Fn(&str, &str) -> Result<(String, String), String>;

/// Load every component `component` (at `path`) imports, and theirs, into `children`.
pub fn load(
    component: &mut ComponentAst,
    path: &str,
    loader: Option<Loader<'_>>,
) -> Result<(), Diagnostic> {
    load_from(component, path, loader, &mut vec![path.to_owned()])
}

fn load_from(
    component: &mut ComponentAst,
    path: &str,
    loader: Option<Loader<'_>>,
    stack: &mut Vec<String>,
) -> Result<(), Diagnostic> {
    for import in component.script.components.clone() {
        let Some(loader) = loader else {
            return Err(Diagnostic::new(
                import.span,
                format!(
                    "this component imports `{}`; compile it from a file so imports can be found",
                    import.specifier
                ),
            ));
        };
        let (child_path, source) = loader(&import.specifier, path).map_err(|message| {
            Diagnostic::new(
                import.span,
                format!("can't load `{}`: {message}", import.specifier),
            )
        })?;
        if stack.contains(&child_path) {
            return Err(Diagnostic::new(
                import.span,
                format!("import cycle: {} → {child_path}", stack.join(" → ")),
            ));
        }
        let mut child = if crate::jsx::is_jsx(&child_path) {
            let lowered = crate::jsx::lower(&source, &child_path, Some(loader))
                .map_err(|diagnostic| diagnostic.in_file(&child_path, &source))?;
            parser::parse(&lowered.text)
        } else {
            parser::parse(&source)
        }
        .map_err(|diagnostic| diagnostic.in_file(&child_path, &source))?;
        stack.push(child_path.clone());
        let loaded = load_from(&mut child, &child_path, Some(loader), stack);
        stack.pop();
        loaded?;
        if component.child(&child.tag).is_some() {
            return Err(Diagnostic::new(
                import.span,
                format!("<{}> is imported more than once", child.tag),
            ));
        }
        if child.tag == component.tag {
            return Err(Diagnostic::new(
                import.span,
                format!("<{}> can't import itself", child.tag),
            ));
        }
        component.children.push(ChildComponent {
            path: child_path,
            source,
            ast: child,
        });
    }
    Ok(())
}

/// The filesystem loader the CLI uses: specifiers are paths relative to the importing file.
pub fn filesystem(specifier: &str, from: &str) -> Result<(String, String), String> {
    let base = std::path::Path::new(from)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    // SPIKE: a bare specifier is looked up in node_modules, from the importing file up.
    let path = if crate::request::is_relative(specifier) {
        base.join(specifier)
    } else {
        base.ancestors()
            .map(|dir| dir.join("node_modules").join(specifier))
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| format!("{specifier}: not found in any node_modules above {}", base.display()))?
    };
    let path =
        std::fs::canonicalize(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let source =
        std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok((path.to_string_lossy().into_owned(), source))
}

/// Whether an import specifier names a component (`.zb`, or a JSX component `.zb.jsx` /
/// `.zb.tsx`).
pub fn is_component(specifier: &str) -> bool {
    component_extension(specifier).is_some()
}

/// The component extension `specifier` ends with.
pub fn component_extension(specifier: &str) -> Option<&'static str> {
    [".zb.jsx", ".zb.tsx", ".zb"]
        .into_iter()
        .find(|extension| specifier.ends_with(extension))
}
