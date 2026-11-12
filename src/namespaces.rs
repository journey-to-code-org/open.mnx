//! TypeScript `namespace`s in a `<script lang="ts">`: the references TypeScript rewrites.
//!
//! A namespace is lowered in place (see `typescript.rs`): its header and closing brace become
//! TypeScript's function wrapper, and an exported member is assigned to the namespace object.
//! What that can't do on its own is **references**: inside a namespace, an exported variable is
//! the namespace's property, so TypeScript writes `x` as `N.x` (an assignment to it then reaches
//! the namespace), and a name exported by another declaration of the same namespace is read
//! through it too. This finds those references, with the text each becomes.

use std::collections::{HashMap, HashSet};

use oxc_ast::{
    ast::{
        BindingPattern, Declaration, Program, Statement, TSNamespaceDeclaration,
        TSNamespaceDeclarationBody,
    },
    AstKind,
};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, Span};

/// `(span, text)`: each reference to replace.
pub fn reference_rewrites(program: &Program<'_>) -> Vec<(Span, String)> {
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();

    // Every namespace declaration that has code, with its path ("A.B") and what it exports.
    let mut exports: HashMap<String, HashSet<String>> = HashMap::new();
    let mut variables: Vec<(oxc_semantic::SymbolId, String)> = Vec::new(); // symbol, namespace param
    collect(&program.body, &[], &mut exports, &mut variables);

    let mut rewrites: Vec<(Span, String)> = Vec::new();
    let mut rewrite = |reference_id: oxc_semantic::ReferenceId, param: &str, name: &str| {
        let reference = scoping.get_reference(reference_id);
        if !reference.flags().is_value() {
            return;
        }
        let node = reference.node_id();
        let span = nodes.kind(node).span();
        match nodes.parent_kind(node) {
            // `{ x }`: the property keeps its name.
            AstKind::ObjectProperty(property) if property.shorthand => {
                rewrites.push((property.span, format!("{name}: {param}.{name}")));
            }
            _ => rewrites.push((span, format!("{param}.{name}"))),
        }
    };
    // An exported variable, everywhere it's read or written.
    for (symbol, param) in &variables {
        let name = scoping.symbol_name(*symbol).to_owned();
        for reference in scoping.get_resolved_reference_ids(*symbol) {
            rewrite(*reference, param, &name);
        }
    }
    // A name another declaration of an enclosing namespace exports: unresolved here, since each
    // declaration is its own scope, and read through the namespace.
    for (name, references) in scoping.root_unresolved_references() {
        for reference_id in references {
            let node = scoping.get_reference(*reference_id).node_id();
            let mut enclosing: Vec<(&str, Vec<String>)> = Vec::new(); // innermost first
            for kind in nodes.ancestor_kinds(node) {
                if let AstKind::TSNamespaceDeclaration(namespace) = kind {
                    enclosing.push((namespace.id.name.as_str(), Vec::new()));
                }
            }
            // Each enclosing namespace's path: the names outward from it.
            let names: Vec<&str> = enclosing.iter().map(|(name, _)| *name).collect();
            for (index, (param, _)) in enclosing.iter().enumerate() {
                let path = names[index..]
                    .iter()
                    .rev()
                    .copied()
                    .collect::<Vec<_>>()
                    .join(".");
                if exports
                    .get(&path)
                    .is_some_and(|exported| exported.contains(name.as_str()))
                {
                    rewrite(*reference_id, param, name.as_str());
                    break;
                }
            }
        }
    }
    rewrites.sort_by_key(|(span, _)| span.start);
    rewrites.dedup_by_key(|(span, _)| span.start);
    rewrites
}

/// Walk the namespaces in `statements` (inside `path`): what each exports, and the symbols of
/// exported variables.
fn collect(
    statements: &[Statement<'_>],
    path: &[String],
    exports: &mut HashMap<String, HashSet<String>>,
    variables: &mut Vec<(oxc_semantic::SymbolId, String)>,
) {
    for statement in statements {
        let (namespace, exported) = match statement {
            Statement::TSNamespaceDeclaration(namespace) => (&**namespace, false),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::TSNamespaceDeclaration(namespace) => (&**namespace, true),
                _ => continue,
            },
            _ => continue,
        };
        let _ = exported;
        if namespace.declare || !instantiated(namespace) {
            continue;
        }
        let mut inner = path.to_vec();
        let (param, statements) = descend(namespace, &mut inner);
        let key = inner.join(".");
        for statement in statements {
            let Statement::ExportDeclaration(export) = statement else {
                continue;
            };
            let names: Vec<String> = match &export.declaration {
                Declaration::VariableDeclaration(declaration) if !declaration.declare => {
                    declaration
                        .declarations
                        .iter()
                        .filter_map(|declarator| match &declarator.id {
                            BindingPattern::BindingIdentifier(identifier) => {
                                if let Some(symbol) = identifier.symbol_id.get() {
                                    variables.push((symbol, param.clone()));
                                }
                                Some(identifier.name.to_string())
                            }
                            _ => None,
                        })
                        .collect()
                }
                Declaration::FunctionDeclaration(function) if !function.declare => {
                    function.id.iter().map(|id| id.name.to_string()).collect()
                }
                Declaration::ClassDeclaration(class) if !class.declare => {
                    class.id.iter().map(|id| id.name.to_string()).collect()
                }
                Declaration::TSEnumDeclaration(declaration) if !declaration.declare => {
                    vec![declaration.id.name.to_string()]
                }
                Declaration::TSNamespaceDeclaration(namespace)
                    if !namespace.declare && instantiated(namespace) =>
                {
                    vec![namespace.id.name.to_string()]
                }
                Declaration::TSImportEqualsDeclaration(alias) => vec![alias.id.name.to_string()],
                _ => Vec::new(),
            };
            exports.entry(key.clone()).or_default().extend(names);
        }
        collect(statements, &inner, exports, variables);
    }
}

/// Follow `namespace A.B.C { … }` to its block: the innermost name (the function's parameter)
/// and the block's statements, with `path` extended by every name.
fn descend<'n, 'a>(
    namespace: &'n TSNamespaceDeclaration<'a>,
    path: &mut Vec<String>,
) -> (String, &'n [Statement<'a>]) {
    path.push(namespace.id.name.to_string());
    match &namespace.body {
        TSNamespaceDeclarationBody::TSNamespaceDeclaration(inner) => descend(inner, path),
        TSNamespaceDeclarationBody::TSModuleBlock(block) => {
            (namespace.id.name.to_string(), block.body.as_slice())
        }
    }
}

/// Whether a namespace has anything at runtime (TypeScript writes nothing for one that holds only
/// types).
pub fn instantiated(namespace: &TSNamespaceDeclaration<'_>) -> bool {
    if namespace.declare {
        return false;
    }
    let statements = match &namespace.body {
        TSNamespaceDeclarationBody::TSNamespaceDeclaration(inner) => return instantiated(inner),
        TSNamespaceDeclarationBody::TSModuleBlock(block) => &block.body,
    };
    statements.iter().any(|statement| match statement {
        Statement::TSTypeAliasDeclaration(_) | Statement::TSInterfaceDeclaration(_) => false,
        Statement::TSNamespaceDeclaration(inner) => instantiated(inner),
        Statement::TSEnumDeclaration(declaration) => !declaration.declare,
        Statement::VariableDeclaration(declaration) => !declaration.declare,
        Statement::ClassDeclaration(class) => !class.declare,
        Statement::FunctionDeclaration(function) => !function.declare && function.body.is_some(),
        Statement::TSImportEqualsDeclaration(alias) => !alias.import_kind.is_type(),
        Statement::ExportDeclaration(export) => match &export.declaration {
            Declaration::TSTypeAliasDeclaration(_) | Declaration::TSInterfaceDeclaration(_) => {
                false
            }
            Declaration::TSNamespaceDeclaration(inner) => instantiated(inner),
            Declaration::TSEnumDeclaration(declaration) => !declaration.declare,
            Declaration::VariableDeclaration(declaration) => !declaration.declare,
            Declaration::ClassDeclaration(class) => !class.declare,
            Declaration::FunctionDeclaration(function) => {
                !function.declare && function.body.is_some()
            }
            Declaration::TSImportEqualsDeclaration(alias) => !alias.import_kind.is_type(),
            _ => true,
        },
        Statement::EmptyStatement(_) => false,
        _ => true,
    })
}

/// `import X = A.B` aliases that are read as values, by where they start: the others are types
/// only, and TypeScript drops them.
pub fn value_aliases(program: &Program<'_>) -> HashSet<u32> {
    let semantic = SemanticBuilder::new().build(program).semantic;
    let scoping = semantic.scoping();
    let mut found = HashSet::new();
    let mut visit = |statements: &[Statement<'_>]| {
        for statement in statements {
            let alias = match statement {
                Statement::TSImportEqualsDeclaration(alias) => alias,
                Statement::ExportDeclaration(export) => match &export.declaration {
                    Declaration::TSImportEqualsDeclaration(alias) => {
                        // Exported, it's the namespace's property: a value.
                        found.insert(alias.span.start);
                        continue;
                    }
                    _ => continue,
                },
                _ => continue,
            };
            let Some(symbol) = alias.id.symbol_id.get() else {
                continue;
            };
            if scoping
                .get_resolved_reference_ids(symbol)
                .iter()
                .any(|reference| scoping.get_reference(*reference).flags().is_value())
            {
                found.insert(alias.span.start);
            }
        }
    };
    fn blocks<'p, 'a>(statements: &'p [Statement<'a>], out: &mut Vec<&'p [Statement<'a>]>) {
        out.push(statements);
        for statement in statements {
            let namespace = match statement {
                Statement::TSNamespaceDeclaration(namespace) => &**namespace,
                Statement::ExportDeclaration(export) => match &export.declaration {
                    Declaration::TSNamespaceDeclaration(namespace) => &**namespace,
                    _ => continue,
                },
                _ => continue,
            };
            let mut path = Vec::new();
            let (_, inner) = descend(namespace, &mut path);
            blocks(inner, out);
        }
    }
    let mut all = Vec::new();
    blocks(&program.body, &mut all);
    for statements in all {
        visit(statements);
    }
    found
}
