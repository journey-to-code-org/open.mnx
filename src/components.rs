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
    if let Some(loader) = loader {
        // Enums from the TypeScript modules it imports.
        if !component.script.typed_imports.is_empty() {
            crate::enums::resolve_imports(component, path, loader)?;
        }
        resolve_contexts(component, path, loader);
    }
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
    if !(specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/'))
    {
        return Err(
            "component imports must be relative paths (./ or ../) when compiling files".to_owned(),
        );
    }
    let base = std::path::Path::new(from)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    let path = base.join(specifier);
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

/// The contexts the script provides or injects, each with a key that's the same in every file
/// that imports it: the module (as the loader resolves it, or else joined to `path`) and the
/// export's name. The default comes from `export const name = createContext(value)` in the
/// module when the loader can read it and the server can evaluate `value`.
fn resolve_contexts(component: &mut ComponentAst, path: &str, loader: Loader<'_>) {
    let script = &component.script;
    let mut used: Vec<&str> = script
        .provides
        .iter()
        .map(|(context, _)| context.as_str())
        .collect();
    used.extend(
        script
            .bindings
            .iter()
            .filter_map(|binding| binding.inject.as_deref()),
    );
    used.sort_unstable();
    used.dedup();
    let mut contexts = Vec::new();
    for local in used {
        let Some((_, specifier, imported)) = script
            .named_imports
            .iter()
            .find(|(name, _, _)| name == local)
        else {
            continue; // declared in the script itself: only the browser has it
        };
        let (module, default) = match loader(specifier, path) {
            Ok((resolved, source)) => (resolved, context_default(&source, imported)),
            Err(_) => (joined(path, specifier), None),
        };
        contexts.push(crate::ast::ContextRef {
            local: local.to_owned(),
            key: format!("{module}#{imported}"),
            default,
        });
    }
    component.contexts = contexts;
}

/// `export const <name> = createContext(<value>)` in a module: `<value>`, if the server can
/// evaluate it (and `undefined` as null when there's none).
fn context_default(source: &str, name: &str) -> Option<serde_json::Value> {
    let start = source.find(&format!("export const {name} = createContext("))?;
    let rest = &source[start + format!("export const {name} = createContext(").len()..];
    let mut depth = 1usize;
    let mut end = None;
    for (index, character) in rest.char_indices() {
        match character {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(index);
                    break;
                }
            }
            _ => {}
        }
    }
    let argument = rest[..end?].trim();
    if argument.is_empty() {
        return Some(serde_json::Value::Null);
    }
    crate::pure::evaluate(argument, &|_| None)
        .ok()?
        .into_json()
        .ok()
}

/// `specifier` joined to the directory of `from`, with `.` and `..` resolved: the module's key
/// when the loader can't read it (a server given only the components' sources).
fn joined(from: &str, specifier: &str) -> String {
    if !(specifier.starts_with("./") || specifier.starts_with("../")) {
        return specifier.to_owned();
    }
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for part in specifier.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}
