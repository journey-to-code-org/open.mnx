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
    load_from(component, path, loader, &mut vec![path.to_owned()])?;
    one_definition_per_tag(component, path)
}

/// Whether a component file is a package's rather than the app's own: under node_modules (as the
/// CLI and the bundler plugin find it), or named by its package specifier (`@acme/kit/…`, as
/// `@zubra/server` names a package's components), not by an absolute or relative path.
fn in_package(path: &str) -> bool {
    let bare = !path.starts_with(['/', '\\', '.'])
        && !path.chars().nth(1).is_some_and(|second| second == ':')
        && path.contains('/');
    bare || path.split(['/', '\\']).any(|part| part == "node_modules")
}

/// Two files as paths from the folder they share: `action-button.zb` and
/// `node_modules/@acme/kit/components/action-button.zb`, not two absolute paths.
fn beside(a: &str, b: &str) -> (String, String) {
    let a_parts: Vec<&str> = a.split(['/', '\\']).collect();
    let b_parts: Vec<&str> = b.split(['/', '\\']).collect();
    let shared = a_parts
        .iter()
        .zip(&b_parts)
        .take(a_parts.len().min(b_parts.len()) - 1)
        .take_while(|(x, y)| x == y)
        .count();
    (a_parts[shared..].join("/"), b_parts[shared..].join("/"))
}

/// One tag, one definition. A page can define a tag once: the browser keeps whichever module
/// loads first, and the other component never runs. So two of the app's files with the same tag,
/// or two packages', anywhere in what a component imports, is an error naming both, at the import
/// that brings in the second. The same file reached twice is fine, and so is an app's component
/// beside a package's with its tag (both carrying a copy of a shared part, say): the app's stands
/// in for the package's, as `@zubra/server` and the bundler plugin arrange.
fn one_definition_per_tag(component: &ComponentAst, path: &str) -> Result<(), Diagnostic> {
    let mut seen: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    seen.insert(&component.tag, path);
    for (import, child) in component.script.components.iter().zip(&component.children) {
        let mut todo = vec![child];
        while let Some(next) = todo.pop() {
            match seen.get(next.ast.tag.as_str()) {
                Some(first)
                    if *first != next.path && in_package(first) == in_package(&next.path) =>
                {
                    let shared = beside(first, &next.path);
                    let through = if std::ptr::eq(next, child) {
                        String::new()
                    } else {
                        format!(", through `{}`", import.specifier)
                    };
                    return Err(Diagnostic::new(
                        import.span,
                        format!(
                            "<{tag}> has two definitions: {first} and {second}{through}. A page \
                             defines a tag once, and the browser keeps whichever loads first; \
                             rename one, or use the same one everywhere (an app's own component \
                             may stand in for a package's, but not for another of the app's)",
                            tag = next.ast.tag,
                            first = shared.0,
                            second = shared.1,
                        ),
                    ));
                }
                Some(_) => {}
                None => {
                    seen.insert(&next.ast.tag, &next.path);
                }
            }
            todo.extend(&next.ast.children);
        }
    }
    Ok(())
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
        // Under its own nearest tsconfig.json.
        let options = if crate::tsconfig::is_typescript(&child_path, &source) {
            crate::tsconfig::for_component(&child_path, loader)
        } else {
            crate::tsconfig::Options::default()
        };
        let child = crate::tsconfig::with(options, || {
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
            loaded.map(|()| child)
        })?;
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
    let path = if crate::request::is_relative(specifier) {
        base.join(specifier)
    } else {
        package_file(base, specifier)?
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

/// Where a package's component (`@acme/kit/components/cart-panel.zb`) is, looked for as Node looks
/// for a package: in the node_modules of `dir` and each folder above it. A package with `exports`
/// must export the path (`"./components/*": "./components/*"`); one without exposes every file.
/// The same rule as `packageFile` in `@zubra/compiler`.
pub fn package_file(dir: &std::path::Path, specifier: &str) -> Result<std::path::PathBuf, String> {
    let parts: Vec<&str> = specifier.split('/').collect();
    let scoped = usize::from(specifier.starts_with('@')) + 1;
    if parts.len() <= scoped {
        return Err(format!(
            "`{specifier}` names a package, not a component in it"
        ));
    }
    let name = parts[..scoped].join("/");
    let subpath = format!("./{}", parts[scoped..].join("/"));
    let dir = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    for at in dir.ancestors() {
        let root = at.join("node_modules").join(&name);
        if !root.exists() {
            continue;
        }
        let manifest: serde_json::Value = std::fs::read_to_string(root.join("package.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(serde_json::Value::Null);
        let target = match manifest.get("exports") {
            None => Some(subpath.clone()),
            Some(exports) => exported(exports, &subpath),
        }
        .ok_or_else(|| format!("{name} doesn't export {subpath} (its package.json \"exports\")"))?;
        let path = root.join(&target);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("{name} has no {}", target.trim_start_matches("./")))
        };
    }
    Err(format!(
        "{name} isn't installed: it isn't in any node_modules above {}",
        dir.display()
    ))
}

/// The file `exports` maps `subpath` to: an exact key, or one with a `*`; a string, or the first
/// condition an import meets.
fn exported(exports: &serde_json::Value, subpath: &str) -> Option<String> {
    fn pick(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::String(target) => Some(target.clone()),
            serde_json::Value::Array(values) => values.iter().find_map(pick),
            // Read in its own order: the first condition an import meets.
            serde_json::Value::Object(conditions) => conditions
                .iter()
                .find(|(condition, _)| matches!(condition.as_str(), "import" | "node" | "default"))
                .and_then(|(_, value)| pick(value)),
            _ => None,
        }
    }
    let keyed = exports
        .as_object()
        .is_some_and(|map| map.keys().any(|key| key.starts_with('.')));
    if !keyed {
        return (subpath == ".").then(|| pick(exports)).flatten();
    }
    let map = exports.as_object()?;
    if let Some(value) = map.get(subpath) {
        return pick(value);
    }
    map.iter().find_map(|(key, value)| {
        let star = key.find('*')?;
        let (before, after) = (&key[..star], &key[star + 1..]);
        if subpath.len() < before.len() + after.len()
            || !subpath.starts_with(before)
            || !subpath.ends_with(after)
        {
            return None;
        }
        let matched = &subpath[before.len()..subpath.len() - after.len()];
        pick(value).map(|target| target.replace('*', matched))
    })
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

#[cfg(test)]
mod tests {
    #[test]
    fn a_package_component_is_named_from_node_modules_or_by_its_specifier() {
        for path in [
            "/app/node_modules/@acme/kit/components/a.zb",
            "C:\\app\\node_modules\\kit\\a.zb",
            "@acme/kit/components/a.zb",
            "kit/components/a.zb",
        ] {
            assert!(super::in_package(path), "{path}");
        }
        for path in [
            "/app/src/a.zb",
            "C:\\app\\src\\a.zb",
            "C:/app/src/a.zb",
            "./a.zb",
            "../parts/a.zb",
            "a.zb",
        ] {
            assert!(!super::in_package(path), "{path}");
        }
    }

    use super::exported;
    use serde_json::json;

    #[test]
    fn exports_patterns_and_conditions() {
        let map = json!({ "./ui/*": { "require": "./nope/*", "import": "./components/*" }, "./c*c.zb": "./x/c*c.zb" });
        assert_eq!(
            exported(&map, "./ui/cart.zb").as_deref(),
            Some("./components/cart.zb")
        );
        assert_eq!(exported(&map, "./ui/").as_deref(), Some("./components/"));
        assert_eq!(exported(&map, "./other.zb"), None);
        // The two ends of `./c*c.zb` overlap on `./c.zb`: no match, and no slicing past them.
        assert_eq!(exported(&map, "./c.zb"), None);
        assert_eq!(exported(&map, "./cXc.zb").as_deref(), Some("./x/cXc.zb"));
        assert_eq!(
            exported(&json!("./index.js"), "."),
            Some("./index.js".to_owned())
        );
        assert_eq!(exported(&json!("./index.js"), "./x.zb"), None);
    }
}
