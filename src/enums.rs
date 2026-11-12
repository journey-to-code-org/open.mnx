//! TypeScript `enum`s in a `<script lang="ts">`: lowered to JavaScript in place.
//!
//! An enum is a runtime object, so unlike the rest of TypeScript it can't be blanked out. The
//! lowering writes what TypeScript writes, in the readable shape where it can:
//!
//! ```text
//! enum Size {            const Size = {
//!   Small,                 Small: 0, "0": "Small",
//!   Large = 4,             Large: 4, "4": "Large",
//! }                      };
//! ```
//!
//! An object literal when every member is a constant (the usual case), and TypeScript's own
//! statements (`Size[Size["Big"] = compute()] = "Big";`) when one is computed at runtime or the
//! declaration adds to an earlier one. Either way the result has **the same number of lines** as
//! the declaration, each member on its own line, so every line after it keeps its number.
//!
//! Member values are computed as TypeScript computes them: auto-increment from the previous
//! numeric member, constant expressions (arithmetic, bitwise, string concatenation, template
//! strings without substitutions), and references to earlier members, by bare name or through
//! any enum declared before (`Other.Member`). The values are kept for the typings, the manifest
//! and attribute parsing.

use std::collections::HashMap;

use oxc_ast::ast::{
    BinaryOperator, Expression, IdentifierReference, TSEnumDeclaration, TSEnumMemberName,
    UnaryOperator,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;

/// A member's value, when it's a constant.
#[derive(Clone, Debug, PartialEq)]
pub enum EnumValue {
    Number(f64),
    String(String),
}

impl EnumValue {
    /// As a JavaScript (and TypeScript) literal.
    pub fn literal(&self) -> String {
        match self {
            Self::Number(number) => js_number(*number),
            Self::String(text) => serde_json::to_string(text).unwrap_or_default(),
        }
    }
}

/// What the script declared, for the typings, the manifest and attribute parsing.
#[derive(Clone, Debug, PartialEq)]
pub struct EnumInfo {
    pub name: String,
    /// In declaration order; `None` for a member computed at runtime.
    pub members: Vec<(String, Option<EnumValue>)>,
    /// `export enum`: the element module exports it, and so do the typings and wrappers.
    pub exported: bool,
    /// `const enum`. In a component script it's kept as an object anyway, since the template
    /// may read it; imported ones are inlined (see `script::inline_const_enums`).
    pub constant: bool,
    /// `declare enum`: nothing at runtime.
    pub declared: bool,
    /// Imported from another module (this specifier), rather than declared in the script.
    pub origin: Option<String>,
}

impl EnumInfo {
    /// The typings' declaration: `declare enum Size { Small = 0, … }`.
    pub fn declaration(&self) -> String {
        let mut out = String::new();
        if self.exported {
            out.push_str("export ");
        }
        out.push_str(&format!("declare enum {} {{\n", self.name));
        for (name, value) in &self.members {
            let key = member_key(name);
            match value {
                // `NaN` and `Infinity` aren't constant initializers in an ambient enum.
                Some(EnumValue::Number(number)) if !number.is_finite() => {
                    out.push_str(&format!("  {key},\n"))
                }
                Some(value) => out.push_str(&format!("  {key} = {},\n", value.literal())),
                None => out.push_str(&format!("  {key},\n")),
            }
        }
        out.push('}');
        out
    }
}

/// The lowered declaration, ready to replace the source text.
pub struct Lowered {
    /// The lowering. A computed member's code is a placeholder (`placeholder(range)`), for the
    /// script's JavaScript in that range once every edit inside it is made.
    pub text: String,
    pub info: EnumInfo,
    /// Edits inside computed members' initializers: bare member names as `Enum.member`.
    pub edits: Vec<(oxc_span::Span, String)>,
    /// The computed members' initializers, to strip of types like the rest of the script.
    pub computed: Vec<oxc_span::Span>,
}

/// Stands for the JavaScript of `range` in a lowering's text, until it's known.
pub fn placeholder(range: oxc_span::Span) -> String {
    format!("\u{E000}{}-{}\u{E001}", range.start, range.end)
}

/// Lower `declaration`, whose source (`export` included, if it has one) is `text`. `previous`
/// holds the enums declared before it in the script; one with the same name is merged into.
pub fn lower(
    source: &str,
    declaration: &TSEnumDeclaration<'_>,
    text_start: u32,
    exported: bool,
    previous: &[EnumInfo],
    constants: &HashMap<String, EnumValue>,
) -> Result<Lowered, (u32, String, Option<String>)> {
    let name = declaration.id.name.to_string();
    let merged = previous
        .iter()
        .any(|earlier| earlier.name == name && !earlier.declared);
    if merged && (exported || previous.iter().any(|e| e.name == name && e.exported)) {
        return Err((
            declaration.span.start,
            format!("`{name}` is exported, so it's declared once"),
            Some("put the members of both declarations in one `export enum`".into()),
        ));
    }
    // Earlier enums, by name, for `Other.Member` (and this one's earlier declarations).
    let mut others: HashMap<&str, HashMap<&str, &EnumValue>> = HashMap::new();
    for earlier in previous {
        let entry = others.entry(earlier.name.as_str()).or_default();
        for (member, value) in &earlier.members {
            if let Some(value) = value {
                entry.insert(member.as_str(), value);
            }
        }
    }
    let member_names: Vec<String> = declaration
        .body
        .members
        .iter()
        .map(|member| text(member.id.static_name()))
        .collect();
    // For computed initializers: every member name, earlier declarations' too.
    let all_names: Vec<String> = previous
        .iter()
        .filter(|earlier| earlier.name == name && !earlier.declared)
        .flat_map(|earlier| earlier.members.iter().map(|(member, _)| member.clone()))
        .chain(member_names.iter().cloned())
        .collect();

    let mut edits = Vec::new();
    let mut computed = Vec::new();
    let mut members: Vec<(String, Option<EnumValue>)> = Vec::new();
    // For each member: its value, or the JavaScript that computes it.
    let mut lowered: Vec<(u32, String, Result<EnumValue, String>)> = Vec::new();
    let mut next: Option<f64> = (!merged).then_some(0.0);
    for (index, member) in declaration.body.members.iter().enumerate() {
        let member_name = member_names[index].clone();
        if matches!(member.id, TSEnumMemberName::ComputedTemplateString(_))
            && text(member.id.static_name()).is_empty()
        {
            return Err((
                member.span.start,
                "an enum member's name can't be empty".into(),
                None,
            ));
        }
        let value: Result<EnumValue, String> = match &member.initializer {
            None => match next {
                Some(number) => Ok(EnumValue::Number(number)),
                None => {
                    return Err((
                        member.span.start,
                        format!(
                            "enum member `{member_name}` needs an initializer, since {}",
                            if index == 0 {
                                format!("this declaration adds to an earlier `enum {name}`")
                            } else {
                                "the member before it isn't a number constant".to_owned()
                            }
                        ),
                        Some("give it a value: `Name = 1` or `Name = \"name\"`".into()),
                    ));
                }
            },
            Some(initializer) => {
                // Bare names are this enum's members, its earlier declarations' included.
                let current: HashMap<&str, &EnumValue> = previous
                    .iter()
                    .filter(|earlier| earlier.name == name && !earlier.declared)
                    .flat_map(|earlier| earlier.members.iter())
                    .chain(members.iter())
                    .filter_map(|(member, value)| {
                        value.as_ref().map(|value| (member.as_str(), value))
                    })
                    .collect();
                let scope = Scope {
                    enum_name: &name,
                    current: &current,
                    others: &others,
                    constants,
                };
                match evaluate(initializer, &scope) {
                    Some(value) => Ok(value),
                    None => {
                        if exported {
                            return Err((
                                initializer.span().start,
                                format!("`{member_name}` isn't a constant, and an exported enum's members must be"),
                                Some("an exported enum is created once, for the module: use a constant, or don't export the enum".into()),
                            ));
                        }
                        edits.extend(qualify(initializer, &name, &all_names));
                        computed.push(initializer.span());
                        Err(placeholder(initializer.span()))
                    }
                }
            }
        };
        next = match &value {
            Ok(EnumValue::Number(number)) => Some(number + 1.0),
            _ => None,
        };
        members.push((member_name.clone(), value.clone().ok()));
        lowered.push((member.span.start, member_name, value));
    }

    // The layout: each member on the line it was on.
    let line_of = |offset: u32| {
        source[text_start as usize..offset as usize]
            .matches('\n')
            .count()
    };
    let end = declaration.span.end;
    let lines = line_of(end);
    let mut out: Vec<Vec<String>> = vec![Vec::new(); lines + 1];
    let constant = lowered.iter().all(|(_, _, value)| value.is_ok());
    let keyword = if exported { "export const" } else { "const" };
    if constant && !merged {
        out[0].push(format!("{keyword} {name} = {{"));
        for (start, member, value) in &lowered {
            let value = value.as_ref().expect("all constant");
            let mut entry = format!("{}: {},", member_key(member), value.literal());
            if let EnumValue::Number(number) = value {
                entry.push_str(&format!(
                    " {}: {},",
                    serde_json::to_string(&js_number(*number)).unwrap_or_default(),
                    serde_json::to_string(member).unwrap_or_default()
                ));
            }
            out[line_of(*start)].push(entry);
        }
        out[lines].push("};".to_owned());
    } else {
        if !merged {
            out[0].push(format!("const {name} = {{}};"));
        }
        for (start, member, value) in &lowered {
            let key = serde_json::to_string(member).unwrap_or_default();
            let statement = match value {
                Ok(EnumValue::String(text)) => format!(
                    "{name}[{key}] = {};",
                    serde_json::to_string(text).unwrap_or_default()
                ),
                Ok(value @ EnumValue::Number(_)) => {
                    format!("{name}[{name}[{key}] = {}] = {key};", value.literal())
                }
                Err(code) => format!("{name}[{name}[{key}] = {code}] = {key};"),
            };
            out[line_of(*start)].push(statement);
        }
    }
    // Each line keeps the indentation it had, so the object reads like the enum did.
    let original: Vec<&str> = source[text_start as usize..end as usize]
        .split('\n')
        .collect();
    let text = out
        .iter()
        .enumerate()
        .map(|(index, parts)| {
            let mut line = parts.join(" ");
            if index > 0 && !line.is_empty() {
                let indent: String = original[index]
                    .chars()
                    .take_while(|character| *character == ' ' || *character == '\t')
                    .collect();
                line.insert_str(0, &indent);
            }
            line
        })
        .collect::<Vec<_>>();
    let mut text = text.join("\n");
    // `{ A: "a", }` on one line reads better without the last comma.
    if lines == 0 && text.ends_with(", };") {
        text.replace_range(text.len() - 4..text.len() - 3, "");
    }
    Ok(Lowered {
        text,
        info: EnumInfo {
            name,
            members,
            exported,
            constant: declaration.r#const,
            declared: false,
            origin: None,
        },
        edits,
        computed,
    })
}

/// A `declare enum`: nothing at runtime, but its values are known for the typings.
pub fn declared(declaration: &TSEnumDeclaration<'_>, previous: &[EnumInfo]) -> EnumInfo {
    let name = declaration.id.name.to_string();
    let mut others: HashMap<&str, HashMap<&str, &EnumValue>> = HashMap::new();
    for earlier in previous {
        let entry = others.entry(earlier.name.as_str()).or_default();
        for (member, value) in &earlier.members {
            if let Some(value) = value {
                entry.insert(member.as_str(), value);
            }
        }
    }
    let mut members: Vec<(String, Option<EnumValue>)> = Vec::new();
    let mut next = Some(0.0);
    for member in &declaration.body.members {
        let current: HashMap<&str, &EnumValue> = members
            .iter()
            .filter_map(|(member, value)| value.as_ref().map(|value| (member.as_str(), value)))
            .collect();
        let value = match &member.initializer {
            None => next.map(EnumValue::Number),
            Some(initializer) => evaluate(
                initializer,
                &Scope {
                    enum_name: &name,
                    current: &current,
                    others: &others,
                    constants: &HashMap::new(),
                },
            ),
        };
        next = match &value {
            Some(EnumValue::Number(number)) => Some(number + 1.0),
            _ => None,
        };
        members.push((text(member.id.static_name()), value));
    }
    EnumInfo {
        name,
        members,
        exported: false,
        constant: declaration.r#const,
        declared: true,
        origin: None,
    }
}

// ---- enums imported from other modules ------------------------------------------------------

/// An enum another TypeScript file exports, found by following its re-exports: `(path, info)`.
/// `Ok(None)` when the file can't be found or doesn't export an enum by that name (it may be
/// any other value, or a module the compiler can't read: a package).
fn find_exported(
    loader: crate::components::Loader<'_>,
    importer: &str,
    specifier: &str,
    name: &str,
    depth: u8,
) -> Option<(String, EnumInfo)> {
    if depth > 8 {
        return None;
    }
    let (path, source) = resolve_module(loader, importer, specifier)?;
    let allocator = oxc_allocator::Allocator::default();
    let source_type = if path.ends_with(".tsx") {
        oxc_span::SourceType::tsx()
    } else {
        oxc_span::SourceType::ts()
    };
    let parsed = oxc_parser::Parser::new(&allocator, &source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return None;
    }
    let mut enums: Vec<EnumInfo> = Vec::new();
    let mut exported: HashMap<String, String> = HashMap::new(); // exported name → local enum
    let mut onward: Vec<(String, String, String)> = Vec::new(); // (exported, local, specifier)
    let mut stars: Vec<String> = Vec::new();
    for statement in &parsed.program.body {
        use oxc_ast::ast::{Declaration, Statement};
        match statement {
            Statement::TSEnumDeclaration(declaration) => {
                let info = declared(declaration, &enums);
                enums.push(info);
            }
            Statement::ExportDeclaration(export) => {
                if let Declaration::TSEnumDeclaration(declaration) = &export.declaration {
                    let info = declared(declaration, &enums);
                    exported.insert(info.name.clone(), info.name.clone());
                    enums.push(info);
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                for item in &export.specifiers {
                    exported.insert(
                        item.exported.name().as_str().to_owned(),
                        item.local.name().as_str().to_owned(),
                    );
                }
            }
            Statement::ExportFromDeclaration(export) => {
                for item in &export.specifiers {
                    onward.push((
                        item.exported.name().as_str().to_owned(),
                        item.local.name().as_str().to_owned(),
                        text(export.source.value),
                    ));
                }
            }
            Statement::ExportAllDeclaration(export) if export.exported.is_none() => {
                stars.push(text(export.source.value));
            }
            _ => {}
        }
    }
    if let Some(local) = exported.get(name) {
        // Merged declarations: one info with every member.
        let mut found: Option<EnumInfo> = None;
        for info in enums.iter().filter(|info| &info.name == local) {
            match &mut found {
                Some(all) => all.members.extend(info.members.iter().cloned()),
                None => found = Some(info.clone()),
            }
        }
        return found.map(|info| (path, info));
    }
    for (exported_name, local, from) in &onward {
        if exported_name == name {
            return find_exported(loader, &path, from, local, depth + 1);
        }
    }
    stars
        .iter()
        .find_map(|from| find_exported(loader, &path, from, name, depth + 1))
}

/// A relative import of a TypeScript module, as TypeScript resolves it: `./sizes` is
/// `./sizes.ts` (or `.tsx`, `.d.ts`, `/index.ts`), and `./sizes.js` is `./sizes.ts`.
fn resolve_module(
    loader: crate::components::Loader<'_>,
    importer: &str,
    specifier: &str,
) -> Option<(String, String)> {
    let mut candidates = Vec::new();
    if let Some(stem) = specifier
        .strip_suffix(".js")
        .or_else(|| specifier.strip_suffix(".mjs"))
    {
        candidates.extend([
            format!("{stem}.ts"),
            format!("{stem}.mts"),
            format!("{stem}.tsx"),
        ]);
    } else if [".ts", ".tsx", ".mts", ".cts"]
        .iter()
        .any(|extension| specifier.ends_with(extension))
    {
        candidates.push(specifier.to_owned());
    } else {
        candidates.extend([
            format!("{specifier}.ts"),
            format!("{specifier}.tsx"),
            format!("{specifier}.d.ts"),
            format!("{specifier}/index.ts"),
        ]);
    }
    candidates
        .iter()
        .find_map(|candidate| loader(candidate, importer).ok())
}

/// The enums a TypeScript script imports from relative modules: their values are learned (for
/// typings, attributes and the manifest), and a `const enum` used as a value is inlined. A
/// `const enum` may not exist at runtime in the module that declares it (TypeScript erases
/// it), so the component takes its own copy: `const Size = { Small: 0, Large: 4 };` at the top of
/// its module, in place of the import. One whose members the compiler can't evaluate is an
/// error, since the import would fail in the browser.
pub fn resolve_imports(
    component: &mut crate::ast::ComponentAst,
    path: &str,
    loader: crate::components::Loader<'_>,
) -> Result<(), crate::diagnostic::Diagnostic> {
    let imports = component.script.typed_imports.clone();
    for import in imports {
        let relative = import.specifier.starts_with("./") || import.specifier.starts_with("../");
        let asset = [
            ".css", ".json", ".svg", ".png", ".jpg", ".html", ".txt", ".wasm",
        ]
        .iter()
        .any(|extension| import.specifier.ends_with(extension));
        if asset || crate::components::is_component(&import.specifier) {
            continue;
        }
        // A non-relative import, through tsconfig.json's `paths` (`@app/enums` → `/…/src/enums`).
        let specifiers = if relative {
            vec![import.specifier.clone()]
        } else {
            crate::tsconfig::map_path(&crate::tsconfig::current(), &import.specifier)
        };
        let Some((file, mut info)) = specifiers
            .iter()
            .find_map(|specifier| find_exported(loader, path, specifier, &import.imported, 0))
        else {
            continue;
        };
        info.name = import.local.clone();
        info.exported = false;
        info.declared = false;
        info.origin = Some(import.specifier.clone());
        let used_as_value = component
            .script
            .imports
            .iter()
            .any(|kept| kept.names.iter().any(|name| name.local == import.local));
        if info.constant && used_as_value {
            if let Some((member, _)) = info.members.iter().find(|(_, value)| value.is_none()) {
                return Err(crate::diagnostic::Diagnostic::new(
                    import.span,
                    format!(
                        "`{}` is a `const enum` (in {file}), and its member `{member}` isn't a constant the compiler can work out, so it can't be inlined; TypeScript erases a const enum, so importing it would fail in the browser",
                        import.imported
                    ),
                )
                .with_help("make it a regular `enum` (it then exists at runtime), or give the member a literal value; see docs/typescript.md"));
            }
            let object = format!(
                "{{ {} }}",
                info.members
                    .iter()
                    .filter_map(|(name, value)| Some(format!(
                        "{}: {}",
                        member_key(name),
                        value.as_ref()?.literal()
                    )))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            crate::script::remove_import_names(
                &mut component.script,
                std::slice::from_ref(&import.local),
            );
            // At the top of the module, so it's declared before every script binding.
            component.script.bindings.insert(
                0,
                crate::ast::Binding {
                    name: import.local.clone(),
                    init: crate::expression::parse(&object).ok(),
                    source: Some(object.clone()),
                    mutable: false,
                    span: import.span,
                    id_call: None,
                    inject: None,
                },
            );
            component
                .script
                .module_declarations
                .push(crate::ast::ModuleDeclaration {
                    name: import.local.clone(),
                    text: format!(
                    "// `{}` is a const enum from {}: its values, inlined.\nconst {} = {object};",
                    import.imported, import.specifier, import.local
                ),
                });
        } else if used_as_value
            && info.members.iter().all(|(_, value)| value.is_some())
            && !component
                .script
                .bindings
                .iter()
                .any(|binding| binding.name == import.local)
        {
            // A regular enum stays imported (it exists at runtime), but its values are known,
            // so a default like `size={Size.Large}` renders on the server too.
            let object = format!(
                "{{ {} }}",
                info.members
                    .iter()
                    .filter_map(|(name, value)| Some(format!(
                        "{}: {}",
                        member_key(name),
                        value.as_ref()?.literal()
                    )))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            component.script.imported_values.push(crate::ast::Binding {
                name: import.local.clone(),
                init: crate::expression::parse(&object).ok(),
                source: Some(object),
                mutable: false,
                span: import.span,
                id_call: None,
                inject: None,
            });
        }
        component.script.enums.push(info);
    }
    Ok(())
}

/// What a member's initializer can refer to while it's being evaluated.
pub struct Scope<'s> {
    pub enum_name: &'s str,
    /// This enum's members so far.
    pub current: &'s HashMap<&'s str, &'s EnumValue>,
    /// Enums declared before, by name (`N.E` for one in a namespace).
    pub others: &'s HashMap<&'s str, HashMap<&'s str, &'s EnumValue>>,
    /// `const`s with constant values, by the names they're read as here (`base`, `NS.base`).
    pub constants: &'s HashMap<String, EnumValue>,
}

/// `A.B.c` as text, when it's names all the way down.
fn dotted(expression: &Expression<'_>) -> Option<String> {
    match expression {
        Expression::Identifier(identifier) => Some(identifier.name.to_string()),
        Expression::StaticMemberExpression(member) => Some(format!(
            "{}.{}",
            dotted(&member.object)?,
            member.property.name
        )),
        _ => None,
    }
}

/// Evaluate a constant enum expression, as TypeScript does; `None` when it isn't one.
pub fn evaluate(expression: &Expression<'_>, scope: &Scope<'_>) -> Option<EnumValue> {
    use EnumValue::{Number, String as Text};
    let lookup = |enum_name: &str, member: &str| -> Option<EnumValue> {
        if enum_name == scope.enum_name {
            if let Some(value) = scope.current.get(member) {
                return Some((*value).clone());
            }
        }
        scope
            .others
            .get(enum_name)
            .and_then(|members| members.get(member))
            .map(|value| (*value).clone())
    };
    match expression {
        Expression::NumericLiteral(literal) => Some(Number(literal.value)),
        Expression::StringLiteral(literal) => Some(Text(text(literal.value))),
        Expression::ParenthesizedExpression(inner) => evaluate(&inner.expression, scope),
        Expression::TSAsExpression(inner) => evaluate(&inner.expression, scope),
        Expression::TSSatisfiesExpression(inner) => evaluate(&inner.expression, scope),
        Expression::Identifier(identifier) => match identifier.name.as_str() {
            "Infinity" => Some(Number(f64::INFINITY)),
            "NaN" => Some(Number(f64::NAN)),
            name => scope
                .current
                .get(name)
                .map(|value| (*value).clone())
                .or_else(|| scope.constants.get(name).cloned()),
        },
        Expression::StaticMemberExpression(member) => {
            let object = dotted(&member.object)?;
            lookup(&object, &member.property.name).or_else(|| {
                scope
                    .constants
                    .get(&format!("{object}.{}", member.property.name))
                    .cloned()
            })
        }
        // `${A}-${B}`: each part's text, joined.
        Expression::TemplateLiteral(template) => {
            let mut out = String::new();
            for (index, quasi) in template.quasis.iter().enumerate() {
                out.push_str(&quasi.value.cooked.as_ref().map(|cooked| text(*cooked))?);
                if let Some(expression) = template.expressions.get(index) {
                    out.push_str(&match evaluate(expression, scope)? {
                        Number(number) => js_number(number),
                        Text(text) => text,
                    });
                }
            }
            Some(Text(out))
        }
        Expression::ComputedMemberExpression(member) => {
            match (&member.object, &member.expression) {
                (Expression::Identifier(object), Expression::StringLiteral(key)) => {
                    lookup(&object.name, &text(key.value))
                }
                _ => None,
            }
        }
        Expression::UnaryExpression(unary) => {
            let Number(operand) = evaluate(&unary.argument, scope)? else {
                return None;
            };
            match unary.operator {
                UnaryOperator::UnaryNegation => Some(Number(-operand)),
                UnaryOperator::UnaryPlus => Some(Number(operand)),
                UnaryOperator::BitwiseNot => Some(Number(f64::from(!to_int32(operand)))),
                _ => None,
            }
        }
        Expression::BinaryExpression(binary) => {
            let left = evaluate(&binary.left, scope)?;
            let right = evaluate(&binary.right, scope)?;
            match (left, right) {
                (Number(left), Number(right)) => {
                    let (a, b) = (to_int32(left), to_int32(right));
                    let shift = (to_int32(right) as u32) & 31;
                    Some(Number(match binary.operator {
                        BinaryOperator::Addition => left + right,
                        BinaryOperator::Subtraction => left - right,
                        BinaryOperator::Multiplication => left * right,
                        BinaryOperator::Division => left / right,
                        BinaryOperator::Remainder => left % right,
                        BinaryOperator::Exponential => left.powf(right),
                        BinaryOperator::BitwiseOR => f64::from(a | b),
                        BinaryOperator::BitwiseAnd => f64::from(a & b),
                        BinaryOperator::BitwiseXOR => f64::from(a ^ b),
                        BinaryOperator::ShiftLeft => f64::from(a.wrapping_shl(shift)),
                        BinaryOperator::ShiftRight => f64::from(a.wrapping_shr(shift)),
                        BinaryOperator::ShiftRightZeroFill => {
                            f64::from((a as u32).wrapping_shr(shift))
                        }
                        _ => return None,
                    }))
                }
                (left, right) if binary.operator == BinaryOperator::Addition => {
                    let text = |value: EnumValue| match value {
                        Number(number) => js_number(number),
                        Text(text) => text,
                    };
                    Some(Text(text(left) + &text(right)))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// A computed initializer's edits: bare references to the enum's own members written as
/// `Enum.member`, as TypeScript writes them, except where a function's own binding of the same
/// name is meant.
fn qualify(
    initializer: &Expression<'_>,
    enum_name: &str,
    members: &[String],
) -> Vec<(oxc_span::Span, String)> {
    use oxc_ast::ast::{ArrowFunctionExpression, BindingIdentifier, Function, ObjectProperty};
    use oxc_syntax::scope::ScopeFlags;
    struct Bindings(Vec<String>);
    impl<'a> Visit<'a> for Bindings {
        fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
            self.0.push(it.name.to_string());
        }
    }
    struct Names<'m> {
        enum_name: &'m str,
        members: &'m [String],
        shadowed: Vec<Vec<String>>,
        found: Vec<(oxc_span::Span, String)>,
    }
    impl Names<'_> {
        fn member(&self, name: &str) -> bool {
            self.members.iter().any(|member| member == name)
                && !self.shadowed.iter().flatten().any(|bound| bound == name)
        }
    }
    impl<'a> Visit<'a> for Names<'_> {
        fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
            if self.member(&it.name) {
                self.found
                    .push((it.span, format!("{}.{}", self.enum_name, it.name)));
            }
        }
        fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
            // `{ A }`: the property keeps its name.
            if let (true, Expression::Identifier(value)) = (it.shorthand, &it.value) {
                if self.member(&value.name) {
                    self.found
                        .push((it.span, format!("{0}: {1}.{0}", value.name, self.enum_name)));
                }
                return;
            }
            walk::walk_object_property(self, it);
        }
        fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
            let mut bindings = Bindings(Vec::new());
            walk::walk_function(&mut bindings, it, flags);
            self.shadowed.push(bindings.0);
            walk::walk_function(self, it, flags);
            self.shadowed.pop();
        }
        fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
            let mut bindings = Bindings(Vec::new());
            walk::walk_arrow_function_expression(&mut bindings, it);
            self.shadowed.push(bindings.0);
            walk::walk_arrow_function_expression(self, it);
            self.shadowed.pop();
        }
    }
    let mut names = Names {
        enum_name,
        members,
        shadowed: Vec::new(),
        found: Vec::new(),
    };
    names.visit_expression(initializer);
    names.found
}

/// A JavaScript string's text (lone surrogates, which a key can't name usefully, as U+FFFD).
fn text(value: oxc_str::JSStr<'_>) -> String {
    value.as_str().map_or_else(
        || {
            value
                .chars()
                .map(|character| character.to_char().unwrap_or('\u{FFFD}'))
                .collect()
        },
        str::to_owned,
    )
}

/// A member's name as an object key: bare when it's an identifier, quoted otherwise.
pub fn member_key(name: &str) -> String {
    let mut chars = name.chars();
    let identifier = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '$'
        });
    if identifier {
        name.to_owned()
    } else {
        serde_json::to_string(name).unwrap_or_default()
    }
}

/// `ToInt32`, as JavaScript's bitwise operators apply it.
fn to_int32(number: f64) -> i32 {
    if !number.is_finite() {
        return 0;
    }
    let modulo = number.trunc().rem_euclid(4_294_967_296.0);
    if modulo >= 2_147_483_648.0 {
        (modulo - 4_294_967_296.0) as i32
    } else {
        modulo as i32
    }
}

/// A number as JavaScript prints it (`String(n)`).
pub fn js_number(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    let sign = if number < 0.0 { "-" } else { "" };
    // The shortest digits that read back as the number, and where the point goes (`n`, as in
    // ECMAScript's Number::toString).
    let exponential = format!("{:e}", number.abs());
    let (mantissa, exponent) = exponential.split_once('e').expect("`{:e}` has an `e`");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = i32::try_from(digits.len()).expect("few digits");
    let n = exponent.parse::<i32>().expect("an exponent") + 1;
    let zeros = |count: i32| "0".repeat(usize::try_from(count).unwrap_or(0));
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", zeros(n - k))
    } else if 0 < n && n <= 21 {
        let (whole, fraction) = digits.split_at(usize::try_from(n).expect("positive"));
        format!("{whole}.{fraction}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", zeros(-n))
    } else {
        let (first, rest) = digits.split_at(1);
        let point = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        let e = n - 1;
        format!("{first}{point}e{}{e}", if e >= 0 { "+" } else { "" })
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        for (number, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (4.0, "4"),
            (-1.0, "-1"),
            (1.5, "1.5"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (5e-7, "5e-7"),
            (0.000_001, "0.000001"),
            (1.0 / 3.0, "0.3333333333333333"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123.456, "123.456"),
            (-2.5e-10, "-2.5e-10"),
            (9_007_199_254_740_994.0, "9007199254740994"),
        ] {
            assert_eq!(js_number(number), text);
        }
    }

    #[test]
    fn to_int32_wraps_as_javascript_does() {
        assert_eq!(to_int32(4_294_967_297.0), 1);
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648);
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(to_int32(f64::NAN), 0);
    }

    #[test]
    fn keys_are_quoted_only_when_they_must_be() {
        assert_eq!(member_key("Small"), "Small");
        assert_eq!(member_key("$a_1"), "$a_1");
        assert_eq!(member_key("my-key"), "\"my-key\"");
        assert_eq!(member_key("1st"), "\"1st\"");
    }
}
