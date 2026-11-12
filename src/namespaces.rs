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
            // `({ x } = value)` (and `{ x = 1 }`): the target keeps its name too.
            AstKind::AssignmentTargetPropertyIdentifier(_) => {
                rewrites.push((span, format!("{name}: {param}.{name}")));
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
    // A name another declaration of an enclosing namespace exports, read through the namespace:
    // unresolved here (each declaration is its own scope), or resolved to a binding outside that
    // namespace, which the export shadows.
    let mut candidates: Vec<(String, oxc_semantic::ReferenceId, Option<Span>)> = Vec::new();
    for (name, references) in scoping.root_unresolved_references() {
        for reference_id in references {
            candidates.push((name.to_string(), *reference_id, None));
        }
    }
    for symbol in scoping.symbol_ids() {
        let declared = scoping.symbol_span(symbol);
        for reference_id in scoping.get_resolved_reference_ids(symbol) {
            candidates.push((
                scoping.symbol_name(symbol).to_owned(),
                *reference_id,
                Some(declared),
            ));
        }
    }
    let exported_variables: HashSet<oxc_semantic::SymbolId> =
        variables.iter().map(|(symbol, _)| *symbol).collect();
    for (name, reference_id, declared) in &candidates {
        if let Some(symbol) = scoping.get_reference(*reference_id).symbol_id() {
            if exported_variables.contains(&symbol) {
                continue;
            }
        }
        {
            let node = scoping.get_reference(*reference_id).node_id();
            let mut enclosing: Vec<(&str, String, Span)> = Vec::new(); // innermost first
            for kind in nodes.ancestor_kinds(node) {
                if let AstKind::TSNamespaceDeclaration(namespace) = kind {
                    enclosing.push((
                        namespace.id.name.as_str(),
                        parameter(namespace),
                        namespace.span,
                    ));
                }
            }
            // Each enclosing namespace's path: the names outward from it.
            let names: Vec<&str> = enclosing.iter().map(|(name, ..)| *name).collect();
            for (index, (_, param, span)) in enclosing.iter().enumerate() {
                // A binding declared inside this namespace is what the name means there.
                if declared.is_some_and(|declared| {
                    span.start <= declared.start && declared.end <= span.end
                }) {
                    break;
                }
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
        // `namespace A.B`: `B` is one of `A`'s exports.
        for depth in path.len() + 1..inner.len() {
            exports
                .entry(inner[..depth].join("."))
                .or_default()
                .insert(inner[depth].clone());
        }
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
            (parameter(namespace), block.body.as_slice())
        }
    }
}

/// The parameter a namespace's function is written with: its name, or `N_1` when its block
/// declares that name itself (as `tsc` renames it).
pub fn parameter(namespace: &TSNamespaceDeclaration<'_>) -> String {
    let name = namespace.id.name.as_str();
    let TSNamespaceDeclarationBody::TSModuleBlock(block) = &namespace.body else {
        return name.to_owned();
    };
    let declares = block.body.iter().any(|statement| {
        // (An exported variable is the namespace's property, not a declaration.)
        if let Statement::ExportDeclaration(export) = statement {
            if matches!(export.declaration, Declaration::VariableDeclaration(_)) {
                return false;
            }
        }
        crate::typescript::declared_names(statement)
            .iter()
            .any(|declared| declared == name)
    });
    if declares {
        format!("{name}_1")
    } else {
        name.to_owned()
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
    // What each namespace exports as a value: an alias of one is a value even if only the
    // template reads it.
    let mut exports: HashMap<String, HashSet<String>> = HashMap::new();
    collect(&program.body, &[], &mut exports, &mut Vec::new());
    let names_a_value = |alias: &oxc_ast::ast::TSImportEqualsDeclaration<'_>| {
        let span = alias.module_reference.span();
        let target: String = program.source_text[span.start as usize..span.end as usize]
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        target.rsplit_once('.').is_some_and(|(path, name)| {
            exports
                .get(path)
                .is_some_and(|exported| exported.contains(name))
        })
    };
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
            if !alias.import_kind.is_type() && names_a_value(alias) {
                found.insert(alias.span.start);
                continue;
            }
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
