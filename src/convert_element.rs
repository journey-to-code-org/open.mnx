//! `zubra convert my-element.js`: a custom element class, back to a `.zb` component.
//!
//! It reads the shape `--emit element` writes (and an element edited from it, or written by hand
//! the same way), and undoes what the emitter did:
//!
//! - the class's props (`static zubra`, or `observedAttributes` and `#props`) become the host
//!   tag's attributes, with their defaults; `formAssociated` becomes `form-associated`;
//! - the `#setup()` script comes back as written: `element.name` is `name`, `count.value` is
//!   `count`, `const count = state(0)` is `let count = 0`, `computed(() => (x))` is `const … = x`,
//!   and the hooks it made for the element are imported from `@zubra/runtime`;
//! - the template is its markup with each binding put back where it writes: `bind(() => x,
//!   (value) => less.setAttribute("aria-label", value))` is `aria-label={x}` on that node,
//!   `addEventListener` is `on…={…}` (modifiers included), `list(…)` is `<zb-each>`, `when(…)`
//!   is `<zb-if>`, `#slotRegion(…)` is `<zb-slot>`;
//! - the stylesheet comes back unscoped, `:scope` as `:host`.
//!
//! What it can't place is reported at its line, not guessed; the result is compiled to check it.

use std::collections::HashMap;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrowFunctionExpression, AssignmentTarget, BindingPattern, CallExpression,
    ClassElement, Declaration, Expression, MethodDefinitionKind, ObjectPropertyKind, PropertyKey,
    Statement,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span as OxcSpan};

use crate::{
    convert::Conversion,
    diagnostic::{Diagnostic, Span},
    reactive::{apply, Edit},
};

/// The hooks `--emit element` makes in `#setup()`, by what their definition does.
fn hook_of(definition: &str) -> Option<&'static str> {
    let has = |text: &str| definition.contains(text);
    Some(if has("createState(") {
        "state"
    } else if has("createComputed") {
        "computed"
    } else if has("this.#effects.push") {
        "effect"
    } else if has("this.#mounted.push(run)") {
        "onMount"
    } else if has("this.#unmounted.push") {
        "onUnmount"
    } else if has("this.localName}-${++") {
        "id"
    } else if definition.trim() == "() => this" {
        "host"
    } else if has("this.#fire(name, detail)") {
        "emit"
    } else if has("this.#formValue = read") {
        "formValue"
    } else if has("this.#validity = read") {
        "validity"
    } else if has("this.#slot(name)") {
        "hasSlot"
    } else if has("this.#started") {
        "hydrated"
    } else if has("isSafeSrcset") {
        "isSafeSrcset"
    } else if has("isSafeUrl") {
        "isSafeUrl"
    } else {
        return None;
    })
}

/// Module-level names `--emit element` writes for itself (a `$` before any is the same name).
const GENERATED: &[&str] = &[
    "HTMLElement",
    "tag",
    "sheet",
    "css",
    "bind",
    "attribute",
    "isSafeUrl",
    "isSafeSrcset",
    "urlAttribute",
    "setValue",
    "setStyle",
    "swapClasses",
    "waiting",
    "waitingTags",
    "setProperty",
    "insert",
    "move",
    "list",
    "when",
    "templates",
    "clone",
    "svgTemplates",
    "cloneSvg",
    "fromJson",
    "reads",
    "createState",
    "createComputed",
    "live",
    "ids",
    "apple",
    "isContent",
    "slotName",
    "assignSlots",
];

fn generated(name: &str) -> bool {
    GENERATED.contains(&name.trim_start_matches('$'))
}

/// One prop: its attribute, its default as `.zb` attribute text, and whether it's two-way.
#[derive(Debug, Clone)]
struct Prop {
    name: String,
    attribute: String,
    /// JavaScript source of the default (`1`, `"Quantity"`, `[]`), or `None` when required.
    default: Option<String>,
    model: bool,
}

/// Convert the custom element class in `source` (`path` names it in messages). `loader` finds
/// the components it imports, by their `.zb` (or JSX) source next to it.
pub fn convert_element(
    source: &str,
    path: &str,
    loader: crate::components::Loader<'_>,
) -> Result<Conversion, Diagnostic> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if let Some(error) = parsed.diagnostics.first() {
        let at = error.labels.first().map_or(0, |label| label.offset());
        return Err(Diagnostic::new(
            span_at(source, at),
            error.message.to_string(),
        ));
    }
    let program = &parsed.program;
    let mut converter = Converter {
        source,
        loader,
        unsupported: Vec::new(),
        changes: Vec::new(),
    };

    // ---- the module: the class, its tag, imports, the stylesheet
    let mut class = None;
    let mut tag: Option<String> = None;
    let mut css: Option<String> = None;
    let mut imports: Vec<String> = Vec::new();
    let mut module_code: Vec<String> = Vec::new();
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => imports.push(converter.import(
                &source[import.span.start as usize..import.span.end as usize],
                path,
            )),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::ClassDeclaration(declaration) if extends_html_element(declaration) => {
                    let found: &oxc_ast::ast::Class<'_> = declaration;
                    class = Some(found)
                }
                Declaration::VariableDeclaration(declaration) => {
                    for declarator in &declaration.declarations {
                        if binding_name(&declarator.id) == Some("tag") {
                            tag = declarator.init.as_ref().and_then(string_value);
                        }
                    }
                }
                _ => converter.unsupported(
                    statement.span(),
                    "an export the element module doesn't need: a component exports nothing",
                ),
            },
            Statement::ClassDeclaration(declaration) if extends_html_element(declaration) => {
                let found: &oxc_ast::ast::Class<'_> = declaration;
                class = Some(found)
            }
            Statement::VariableDeclaration(declaration) => {
                let names: Vec<&str> = declaration
                    .declarations
                    .iter()
                    .filter_map(|declarator| binding_name(&declarator.id))
                    .collect();
                for declarator in &declaration.declarations {
                    if binding_name(&declarator.id) == Some("css") {
                        css = declarator.init.as_ref().and_then(string_value);
                    }
                }
                if !names.iter().all(|name| generated(name)) {
                    module_code.push(converter.text(declaration.span).to_owned());
                }
            }
            Statement::FunctionDeclaration(function) => {
                let name = function.id.as_ref().map_or("", |id| id.name.as_str());
                if !generated(name) {
                    module_code.push(converter.text(function.span).to_owned());
                }
            }
            Statement::IfStatement(statement) => {
                // `if (… !customElements.get(tag)) customElements.define(tag, X);`
                let text = converter.text(statement.span);
                if let Some(found) = define_tag(text) {
                    tag = tag.or(found);
                } else {
                    converter.unsupported(
                        statement.span,
                        "module code other than the element and its helpers",
                    );
                }
            }
            Statement::ExpressionStatement(expression) => {
                let text = converter.text(expression.span);
                match define_tag(text) {
                    Some(found) => tag = tag.or(found),
                    None => converter.unsupported(
                        expression.span,
                        "module code other than the element and its helpers",
                    ),
                }
            }
            Statement::ExportDefaultDeclaration(_) => {}
            other => converter.unsupported(
                other.span(),
                "module code other than the element and its helpers",
            ),
        }
    }
    let Some(class) = class else {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            format!("{path}: no class that extends HTMLElement"),
        )
        .with_help("zubra convert reads a custom element written the way `zubra compile --emit element` writes one"));
    };
    let Some(tag) = tag else {
        return Err(Diagnostic::new(
            span_at(source, class.span.start),
            "no tag: the module needs `customElements.define(\"my-tag\", …)` or `export const tag = \"my-tag\"`",
        ));
    };

    // ---- the class: props, form association, #setup()
    let mut props: Vec<Prop> = Vec::new();
    let mut observed: Vec<String> = Vec::new();
    let mut defaults: Vec<(String, String)> = Vec::new();
    let mut form = false;
    let mut models: Vec<String> = Vec::new();
    let mut setup = None;
    for element in &class.body.body {
        match element {
            ClassElement::PropertyDefinition(property) => {
                let name = property_key_name(&property.key, source);
                let value = property.value.as_ref();
                match (property.r#static, name.as_str()) {
                    (true, "zubra") => {
                        if let Some(Expression::ObjectExpression(meta)) = value {
                            props = converter.meta_props(meta);
                        }
                    }
                    (true, "observedAttributes") => {
                        if let Some(Expression::ArrayExpression(array)) = value {
                            observed = array
                                .elements
                                .iter()
                                .filter_map(|element| {
                                    element.as_expression().and_then(string_value)
                                })
                                .collect();
                        }
                    }
                    (true, "formAssociated") => {
                        form = matches!(value, Some(Expression::BooleanLiteral(literal)) if literal.value)
                    }
                    (false, "#props") => {
                        if let Some(Expression::ObjectExpression(object)) = value {
                            for property in &object.properties {
                                if let ObjectPropertyKind::ObjectProperty(property) = property {
                                    defaults.push((
                                        property_key_name(&property.key, source),
                                        converter.text(property.value.span()).to_owned(),
                                    ));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            ClassElement::MethodDefinition(method) => {
                let name = property_key_name(&method.key, source);
                if name == "#setup" {
                    setup = method.value.body.as_ref();
                }
                // A private setter of a prop's name is a two-way prop's own write.
                if method.kind == MethodDefinitionKind::Set {
                    if let Some(prop) = name.strip_prefix('#') {
                        models.push(prop.to_owned());
                    }
                }
            }
            _ => {}
        }
    }
    if props.is_empty() {
        // Hand-written: the observed attributes, with #props for their defaults.
        for attribute in &observed {
            let name = camel(attribute);
            let default = defaults
                .iter()
                .find(|(prop, _)| *prop == name || prop == attribute)
                .map(|(_, value)| value.clone())
                .filter(|value| value != "undefined");
            props.push(Prop {
                model: models.contains(&name),
                name,
                attribute: attribute.clone(),
                default,
            });
        }
    }
    let Some(setup) = setup else {
        return Err(Diagnostic::new(
            span_at(source, class.span.start),
            "the class has no #setup(): zubra convert reads the shape `zubra compile --emit element` writes (the script and template in #setup())",
        ));
    };

    // ---- #setup(): the receiver, the hooks, the script, then the template
    let statements = &setup.statements;
    let mut receiver = "element".to_owned();
    let mut hooks: Vec<(String, &'static str)> = Vec::new(); // (local, imported)
    let mut index = 0;
    let mut script_start = None;
    let mut script_end = None;
    let mut runtime_defaults: Vec<(String, String)> = Vec::new();
    let mut root: Option<(String, String)> = None; // (variable, markup)
    while index < statements.len() {
        let statement = &statements[index];
        index += 1;
        if let Statement::VariableDeclaration(declaration) = statement {
            if let [declarator] = declaration.declarations.as_slice() {
                let name = binding_name(&declarator.id).unwrap_or_default().to_owned();
                if let Some(init) = &declarator.init {
                    let text = converter.text(init.span());
                    if script_start.is_none() && text == "this" {
                        receiver = name;
                        continue;
                    }
                    if script_start.is_none() {
                        if let Some(hook) = hook_of(text) {
                            hooks.push((name, hook));
                            continue;
                        }
                    }
                    if let Some(markup) = clone_markup(init) {
                        root = Some((name, markup));
                        break;
                    }
                }
            }
        }
        // `if (!this.#given.has("x")) this.#props.x = …;`: a default worked out in the browser.
        if let Statement::IfStatement(statement) = statement {
            let text = converter.text(statement.span);
            if let Some(rest) = text.strip_prefix("if (!this.#given.has(") {
                if let Some((name, value)) = rest
                    .split_once("))")
                    .and_then(|(name, assign)| {
                        Some((name, assign.trim().strip_prefix("this.#props.")?))
                    })
                    .and_then(|(name, assign)| {
                        let (_, value) = assign.split_once('=')?;
                        Some((
                            name.trim_matches('"').to_owned(),
                            value.trim().trim_end_matches(';').to_owned(),
                        ))
                    })
                {
                    runtime_defaults.push((name, value));
                    continue;
                }
            }
        }
        script_start.get_or_insert(statement.span().start);
        script_end = Some(statement.span().end);
    }
    let Some((root, markup)) = root else {
        return Err(Diagnostic::new(
            span_at(source, setup.span.start),
            "#setup() has no template: zubra convert looks for `const content = clone(`…`)`",
        ));
    };
    let template_statements = &statements[index..];

    // What the script and template read: props by name, state and derived values by name.
    // From the start of the first statement's line, so its indentation is the others'.
    let script_text = match (script_start, script_end) {
        (Some(start), Some(end)) => {
            let line = source[..start as usize].rfind('\n').map_or(0, |at| at + 1);
            let start = if source[line..start as usize].trim().is_empty() {
                line
            } else {
                start as usize
            };
            &source[start..end as usize]
        }
        _ => "",
    };
    let state_hook = hooks
        .iter()
        .find(|(_, hook)| *hook == "state")
        .map(|(local, _)| local.clone());
    let computed_hook = hooks
        .iter()
        .find(|(_, hook)| *hook == "computed")
        .map(|(local, _)| local.clone());
    let prop_names: Vec<String> = props.iter().map(|prop| prop.name.clone()).collect();
    let mut context = Unlower {
        receiver: receiver.clone(),
        props: prop_names.clone(),
        reactive: Vec::new(),
        uses_host: false,
    };
    // hasSlot() and hydrated() give values read as `.value` too.
    let signals: Vec<String> = hooks
        .iter()
        .filter(|(_, hook)| matches!(*hook, "hasSlot" | "hydrated"))
        .map(|(local, _)| local.clone())
        .collect();
    let setup_text = converter.text(setup.span).to_owned();
    let script = converter.script(
        script_text,
        &setup_text,
        state_hook.as_deref(),
        computed_hook.as_deref(),
        &signals,
        &mut context,
    );

    // The template.
    let mut tree = Tree::parse(&markup);
    converter.block(&mut tree, &root, template_statements, &context)?;
    let template = tree.render();

    // ---- the .zb file
    let mut out = String::new();
    // The script's imports: other modules, and the hooks it uses.
    let mut used_hooks: Vec<String> = Vec::new();
    for (local, hook) in &hooks {
        let kept = match *hook {
            "state" | "computed" => script.signal_hooks.contains(local),
            _ => uses_name(&script.text, local) || uses_name(&template, local),
        };
        if kept {
            used_hooks.push(if local == hook {
                local.clone()
            } else {
                format!("{hook} as {local}")
            });
        }
    }
    if context.uses_host && !hooks.iter().any(|(_, hook)| *hook == "host") {
        used_hooks.push("host".to_owned());
    }
    let mut script_out = String::new();
    for import in &imports {
        script_out.push_str(&format!("  {import}\n"));
    }
    if !used_hooks.is_empty() {
        script_out.push_str(&format!(
            "  import {{ {} }} from '@zubra/runtime'\n",
            used_hooks.join(", ")
        ));
    }
    if !imports.is_empty() || !used_hooks.is_empty() {
        script_out.push('\n');
    }
    for code in &module_code {
        script_out.push_str(&indent(code, "  "));
        script_out.push('\n');
    }
    if context.uses_host {
        let host = hooks
            .iter()
            .find(|(_, hook)| *hook == "host")
            .map_or("host".to_owned(), |(local, _)| local.clone());
        if !script.text.contains(&format!("{receiver} = {host}()")) {
            script_out.push_str(&format!("  const {receiver} = {host}()\n"));
        }
    }
    if !script.text.trim().is_empty() {
        script_out.push_str(&indent(&script.text, "  "));
        script_out.push('\n');
    }
    if !script_out.trim().is_empty() {
        out.push_str("<script>\n");
        out.push_str(script_out.trim_end());
        out.push_str("\n</script>\n");
    }
    if let Some(css) = &css {
        let (layer, body) = unscope(css, &tag);
        match layer.as_deref() {
            Some("components") => out.push_str("<style>\n"),
            Some(layer) => out.push_str(&format!("<style layer=\"{layer}\">\n")),
            None => out.push_str("<style layer=\"none\">\n"),
        }
        out.push_str(&indent(body.trim_matches('\n'), "  "));
        out.push_str("\n</style>\n");
    }
    // The host tag: the element and its props.
    out.push('<');
    out.push_str(&tag);
    if form {
        out.push_str(" form-associated");
    }
    for prop in &props {
        let model = prop.model || models.contains(&prop.name);
        let name = if model {
            format!("{}:model", prop.attribute)
        } else {
            prop.attribute.clone()
        };
        let runtime = runtime_defaults.iter().find(|(name, _)| *name == prop.name);
        match (runtime, &prop.default) {
            (Some((_, value)), _) => {
                out.push_str(&format!(" {name}={{{}}}", context.apply(value)));
            }
            (None, None) => out.push_str(&format!(" {name}")),
            (None, Some(default)) => match serde_json::from_str::<serde_json::Value>(default) {
                Ok(serde_json::Value::String(text)) if !model => {
                    out.push_str(&format!(" {name}=\"{}\"", escape_attribute(&text)))
                }
                _ => out.push_str(&format!(" {name}={{{default}}}")),
            },
        }
    }
    out.push('>');
    out.push_str(&template);
    out.push_str(&format!("</{tag}>\n"));

    converter.changes.insert(
        0,
        format!(
            "read <{tag}>: {} prop{}, its script and its template",
            props.len(),
            if props.len() == 1 { "" } else { "s" }
        ),
    );
    // Compiled to check it, with the components it imports from beside the element.
    let beside = match path.rsplit_once('/') {
        Some((directory, _)) => format!("{directory}/{tag}.zb"),
        None => format!("{tag}.zb"),
    };
    let compile_error = crate::compile_element_with(&out, &beside, Some(".js"), loader).err();
    Ok(Conversion {
        output: out,
        file_name: format!("{tag}.zb"),
        tag,
        changes: converter.changes,
        unsupported: converter.unsupported,
        compile_error,
    })
}

// ---- reading the module

fn extends_html_element(class: &oxc_ast::ast::Class<'_>) -> bool {
    matches!(&class.heritage, Some(heritage) if matches!(&heritage.expression, Expression::Identifier(identifier) if identifier.name == "HTMLElement"))
}

fn binding_name<'a>(pattern: &'a BindingPattern<'_>) -> Option<&'a str> {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => Some(identifier.name.as_str()),
        _ => None,
    }
}

fn string_value(expression: &Expression<'_>) -> Option<String> {
    match expression.without_parentheses() {
        Expression::StringLiteral(literal) => literal.value.as_str().map(str::to_owned),
        Expression::TemplateLiteral(literal) if literal.expressions.is_empty() => literal
            .quasis
            .first()
            .and_then(|quasi| quasi.value.cooked)
            .and_then(|cooked| cooked.as_str())
            .map(str::to_owned),
        _ => None,
    }
}

/// `clone(\`…\`)` / `cloneSvg(\`…\`)`: the markup.
fn clone_markup(expression: &Expression<'_>) -> Option<String> {
    let Expression::CallExpression(call) = expression.without_parentheses() else {
        return None;
    };
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    if !matches!(callee.name.trim_start_matches('$'), "clone" | "cloneSvg") {
        return None;
    }
    call.arguments
        .first()?
        .as_expression()
        .and_then(string_value)
}

/// The tag in `customElements.define("x-a", X)` (`None` inside when it's the `tag` constant).
fn define_tag(text: &str) -> Option<Option<String>> {
    let at = text.find("customElements.define(")?;
    let rest = &text[at + "customElements.define(".len()..];
    let first = rest.split(',').next()?.trim();
    Some(serde_json::from_str::<String>(first).ok().or_else(|| {
        first
            .strip_prefix('\'')
            .and_then(|rest| rest.strip_suffix('\''))
            .map(str::to_owned)
    }))
}

fn property_key_name(key: &PropertyKey<'_>, source: &str) -> String {
    match key {
        PropertyKey::StaticIdentifier(identifier) => identifier.name.to_string(),
        PropertyKey::PrivateIdentifier(identifier) => format!("#{}", identifier.name),
        PropertyKey::StringLiteral(literal) => {
            literal.value.as_str().unwrap_or_default().to_owned()
        }
        other => source[other.span().start as usize..other.span().end as usize].to_owned(),
    }
}

/// `aria-label` → `ariaLabel`.
fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// `unreadCount` → `unread-count`.
fn kebab(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn span_at(source: &str, offset: u32) -> Span {
    crate::scanner::span_after(Span::new(1, 1), source, offset as usize)
}

fn uses_name(text: &str, name: &str) -> bool {
    let mut rest = text;
    while let Some(at) = rest.find(name) {
        let before = rest[..at].chars().last();
        let after = rest[at + name.len()..].chars().next();
        let boundary =
            |c: Option<char>| !c.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$');
        if boundary(before) && boundary(after) && before != Some('.') {
            return true;
        }
        rest = &rest[at + name.len()..];
    }
    false
}

/// `text`, its shallowest lines at `pad`.
fn indent(text: &str, pad: &str) -> String {
    let shallowest = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    text.lines()
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else {
                format!(
                    "{pad}{}",
                    &line[shallowest.min(line.len() - line.trim_start().len())..]
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The stylesheet as the `.zb` file wrote it: (its layer, its rules with `:host`).
fn unscope(css: &str, tag: &str) -> (Option<String>, String) {
    let mut rest = css.trim();
    let mut prelude = String::new();
    // Hoisted at-rules (`@import`…) come first.
    while rest.starts_with("@import")
        || rest.starts_with("@charset")
        || rest.starts_with("@namespace")
    {
        let Some(end) = rest.find(";\n") else { break };
        prelude.push_str(&rest[..=end]);
        prelude.push('\n');
        rest = rest[end + 2..].trim_start();
    }
    rest = rest
        .strip_prefix("@layer theme, base, components, utilities;")
        .map_or(rest, str::trim_start);
    let mut layer = None;
    if let Some(after) = rest.strip_prefix("@layer ") {
        if let Some((name, body)) = after.split_once(" {") {
            if !name.contains(',') && body.trim_end().ends_with('}') {
                layer = Some(name.trim().to_owned());
                let body = body.trim_end();
                rest = body[..body.len() - 1].trim();
            }
        }
    }
    let scope = format!("@scope ({tag}) to ([data-zb-slotted=\"{tag}\"]) {{");
    let body = match rest.strip_prefix(&scope) {
        Some(inner) if inner.trim_end().ends_with('}') => {
            let inner = inner.trim_end();
            inner[..inner.len() - 1].trim_matches('\n').to_owned()
        }
        _ => rest.to_owned(),
    };
    let body = body
        .replace(":scope:is(", ":host(")
        .replace(":scope", ":host");
    (layer, format!("{prelude}{body}"))
}

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('{', "&#123;")
        .replace('}', "&#125;")
}

fn escape_attribute(text: &str) -> String {
    escape_text(text).replace('"', "&quot;")
}

// ---- undoing the emitter's spelling

/// What `element.name` and `name.value` mean in this element.
struct Unlower {
    receiver: String,
    props: Vec<String>,
    /// State, derived values and signals: read as `name.value`.
    reactive: Vec<String>,
    /// The script uses the element itself (`element.querySelector(…)`), not only its props.
    uses_host: bool,
}

impl Unlower {
    /// `js` with `element.prop` → `prop`, `element.#prop` → `prop`, `count.value` → `count`.
    fn apply(&mut self, js: &str) -> String {
        let wrapped = format!("({js}\n)");
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &wrapped, SourceType::mjs()).parse();
        if !parsed.diagnostics.is_empty() {
            return js.to_owned();
        }
        let semantic = oxc_semantic::SemanticBuilder::new()
            .build(&parsed.program)
            .semantic;
        let mut visitor = Undo {
            context: self,
            scoping: semantic.scoping(),
            edits: Vec::new(),
            top_level: false,
        };
        visitor.visit_program(&parsed.program);
        let edits = std::mem::take(&mut visitor.edits);
        let text = apply(&wrapped, 0..wrapped.len(), edits);
        text[1..text.len() - 2].to_owned()
    }
}

struct Undo<'c, 's> {
    context: &'c mut Unlower,
    scoping: &'s oxc_semantic::Scoping,
    edits: Vec<Edit>,
    /// The script: its own top-level declarations are the reactive names (not shadowing).
    top_level: bool,
}

impl Undo<'_, '_> {
    /// Whether `identifier` is the free name (or the script's top-level one), not a local.
    fn free(&self, identifier: &oxc_ast::ast::IdentifierReference<'_>) -> bool {
        match self
            .scoping
            .get_reference(identifier.reference_id())
            .symbol_id()
        {
            None => true,
            Some(symbol) => {
                self.top_level
                    && self.scoping.symbol_scope_id(symbol) == self.scoping.root_scope_id()
            }
        }
    }
}

impl<'a> Visit<'a> for Undo<'_, '_> {
    fn visit_static_member_expression(
        &mut self,
        member: &oxc_ast::ast::StaticMemberExpression<'a>,
    ) {
        if let Expression::Identifier(object) = &member.object {
            let name = object.name.as_str();
            let property = member.property.name.as_str();
            if name == self.context.receiver
                && self.free(object)
                && self.context.props.iter().any(|prop| prop == property)
            {
                self.edits.push(Edit {
                    range: member.span.start as usize..member.span.end as usize,
                    text: property.to_owned(),
                });
                return;
            }
            if property == "value"
                && self
                    .context
                    .reactive
                    .iter()
                    .any(|reactive| reactive == name)
                && self.free(object)
            {
                self.edits.push(Edit {
                    range: member.span.start as usize..member.span.end as usize,
                    text: name.to_owned(),
                });
                return;
            }
        }
        walk::walk_static_member_expression(self, member);
    }

    fn visit_private_field_expression(
        &mut self,
        member: &oxc_ast::ast::PrivateFieldExpression<'a>,
    ) {
        if let Expression::Identifier(object) = &member.object {
            if object.name == self.context.receiver.as_str() && self.free(object) {
                self.edits.push(Edit {
                    range: member.span.start as usize..member.span.end as usize,
                    text: member.field.name.to_string(),
                });
                return;
            }
        }
        walk::walk_private_field_expression(self, member);
    }

    fn visit_identifier_reference(&mut self, identifier: &oxc_ast::ast::IdentifierReference<'a>) {
        // The element itself, beyond its props: the script asks for it with host().
        if identifier.name == self.context.receiver.as_str() && self.free(identifier) {
            self.context.uses_host = true;
        }
    }
}

/// The script, back as written.
struct Script {
    text: String,
    /// State hooks the script calls itself (`const count = state(0)` it reads with `.get()`).
    signal_hooks: Vec<String>,
}

struct Converter<'s> {
    source: &'s str,
    loader: crate::components::Loader<'s>,
    unsupported: Vec<Diagnostic>,
    changes: Vec<String>,
}

impl Converter<'_> {
    fn text(&self, span: OxcSpan) -> &str {
        &self.source[span.start as usize..span.end as usize]
    }

    fn unsupported(&mut self, span: OxcSpan, what: &str) {
        self.unsupported.push(Diagnostic::new(
            span_at(self.source, span.start),
            format!("not converted: {what}"),
        ));
    }

    /// An import: a sibling `.zb` file for a compiled component's `.js`.
    fn import(&mut self, text: &str, path: &str) -> String {
        let mut text = text.trim_end_matches(';').to_owned();
        for quote in ['"', '\''] {
            let parts: Vec<&str> = text.split(quote).collect();
            if parts.len() == 3 && parts[1].starts_with('.') && parts[1].ends_with(".js") {
                let specifier = parts[1];
                let stem = &specifier[..specifier.len() - 3];
                // The component it was compiled from: a .zb file, or a JSX one.
                let found = [".zb", ".zb.jsx", ".zb.tsx"]
                    .iter()
                    .map(|extension| format!("{stem}{extension}"))
                    .find(|zb| (self.loader)(zb, path).is_ok());
                if let Some(zb) = found {
                    self.changes.push(format!(
                        "{specifier} is the element of {zb}: imported as the component"
                    ));
                    let name = std::path::Path::new(&zb).file_stem().map_or(
                        "Component".to_owned(),
                        |stem| {
                            stem.to_string_lossy()
                                .split(['-', '.'])
                                .map(|word| {
                                    let mut chars = word.chars();
                                    chars.next().map_or(String::new(), |first| {
                                        first.to_ascii_uppercase().to_string() + chars.as_str()
                                    })
                                })
                                .collect()
                        },
                    );
                    let _ = name;
                    text = text.replace(specifier, &zb);
                }
            }
        }
        text
    }

    /// `static zubra = { props: { … } }`.
    fn meta_props(&self, meta: &oxc_ast::ast::ObjectExpression<'_>) -> Vec<Prop> {
        let mut props = Vec::new();
        for property in &meta.properties {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                continue;
            };
            if property_key_name(&property.key, self.source) != "props" {
                continue;
            }
            let Expression::ObjectExpression(list) = &property.value else {
                continue;
            };
            for entry in &list.properties {
                let ObjectPropertyKind::ObjectProperty(entry) = entry else {
                    continue;
                };
                let name = property_key_name(&entry.key, self.source);
                let mut prop = Prop {
                    attribute: kebab(&name),
                    name,
                    default: None,
                    model: false,
                };
                if let Expression::ObjectExpression(fields) = &entry.value {
                    for field in &fields.properties {
                        let ObjectPropertyKind::ObjectProperty(field) = field else {
                            continue;
                        };
                        let value = self.text(field.value.span()).to_owned();
                        match property_key_name(&field.key, self.source).as_str() {
                            "attribute" => {
                                prop.attribute =
                                    string_value(&field.value).unwrap_or(prop.attribute)
                            }
                            "default" if value != "undefined" => prop.default = Some(value),
                            "model" => prop.model = value == "true",
                            _ => {}
                        }
                    }
                }
                props.push(prop);
            }
        }
        props
    }

    /// The script as written: `const x = state(v)` is `let x = v`, `computed(() => (e))` is `e`,
    /// and the element's spelling is undone.
    #[allow(clippy::too_many_arguments)]
    fn script(
        &mut self,
        text: &str,
        setup: &str,
        state: Option<&str>,
        computed: Option<&str>,
        signals: &[String],
        context: &mut Unlower,
    ) -> Script {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, text, SourceType::mjs()).parse();
        let mut script = Script {
            text: text.to_owned(),
            signal_hooks: Vec::new(),
        };
        if !parsed.diagnostics.is_empty() {
            return script;
        }
        let mut edits: Vec<Edit> = Vec::new();
        // The state and derived values the script declares.
        for statement in &parsed.program.body {
            let Statement::VariableDeclaration(declaration) = statement else {
                continue;
            };
            if declaration.declarations.len() != 1 {
                continue;
            }
            let declarator = &declaration.declarations[0];
            let (Some(name), Some(Expression::CallExpression(call))) = (
                binding_name(&declarator.id),
                declarator
                    .init
                    .as_ref()
                    .map(Expression::without_parentheses),
            ) else {
                continue;
            };
            let Expression::Identifier(callee) = &call.callee else {
                continue;
            };
            let is = |hook: Option<&str>| hook == Some(callee.name.as_str());
            if is(state)
                || is(computed)
                || signals.iter().any(|signal| signal == callee.name.as_str())
            {
                context.reactive.push(name.to_owned());
            }
            if !(is(state) || is(computed)) {
                continue;
            }
            // Read with `.get()`/`.set()` (in the script or the template): a signal the script made itself.
            let whole =
                setup.contains(&format!("{name}.get(")) || setup.contains(&format!("{name}.set("));
            if whole {
                script.signal_hooks.push(callee.name.to_string());
                continue;
            }
            if is(state) && call.arguments.len() == 1 {
                let argument = &call.arguments[0];
                let value = self_text(text, argument.span());
                edits.push(Edit {
                    range: declaration.span.start as usize..declaration.span.start as usize + 5,
                    text: "let".to_owned(),
                });
                let init = declarator.init.as_ref().expect("checked").span();
                let value = if value == "undefined" {
                    None
                } else {
                    Some(value)
                };
                match value {
                    Some(value) => edits.push(Edit {
                        range: init.start as usize..init.end as usize,
                        text: value.to_owned(),
                    }),
                    None => edits.push(Edit {
                        range: declarator.id.span().end as usize..init.end as usize,
                        text: String::new(),
                    }),
                }
            } else if is(computed) && call.arguments.len() == 1 {
                if let Some(Expression::ArrowFunctionExpression(arrow)) =
                    call.arguments[0].as_expression()
                {
                    if let Some(body) = arrow_expression(arrow) {
                        let init = declarator.init.as_ref().expect("checked").span();
                        let body = unparen(self_text(text, body.span()));
                        edits.push(Edit {
                            range: init.start as usize..init.end as usize,
                            text: body,
                        });
                    }
                }
            }
        }
        // Declarations first, then the names (in the values too).
        let declared = apply(text, 0..text.len(), edits);
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &declared, SourceType::mjs()).parse();
        if !parsed.diagnostics.is_empty() {
            script.text = declared;
            return script;
        }
        let semantic = oxc_semantic::SemanticBuilder::new()
            .build(&parsed.program)
            .semantic;
        let mut visitor = Undo {
            context,
            scoping: semantic.scoping(),
            edits: Vec::new(),
            top_level: true,
        };
        visitor.visit_program(&parsed.program);
        let edits = std::mem::take(&mut visitor.edits);
        script.text = apply(&declared, 0..declared.len(), edits);
        script
    }

    // ---- the template

    /// The block's statements (after `const root = clone(…)`), put back into `tree`.
    fn block(
        &mut self,
        tree: &mut Tree,
        root: &str,
        statements: &[Statement<'_>],
        context: &Unlower,
    ) -> Result<(), Diagnostic> {
        let mut nodes: HashMap<String, Vec<usize>> = HashMap::new();
        nodes.insert(root.to_owned(), Vec::new());
        let mut texts: HashMap<String, Vec<usize>> = HashMap::new();
        let mut context = Unlower {
            receiver: context.receiver.clone(),
            props: context.props.clone(),
            reactive: context.reactive.clone(),
            uses_host: false,
        };
        for statement in statements {
            match statement {
                Statement::VariableDeclaration(declaration)
                    if declaration.declarations.len() == 1 =>
                {
                    let declarator = &declaration.declarations[0];
                    let name = binding_name(&declarator.id).unwrap_or_default().to_owned();
                    let Some(init) = &declarator.init else {
                        continue;
                    };
                    let text = self.text(init.span()).to_owned();
                    if text == "new Text()" {
                        texts.insert(name, Vec::new());
                    } else if let Some(path) = tree.locate(&text, &nodes) {
                        nodes.insert(name, path);
                    } else if let Expression::ArrayExpression(array) = init {
                        // `const updates = [ … ]` in a row or branch.
                        for element in &array.elements {
                            if let Some(expression) = element.as_expression() {
                                self.update(tree, expression, &nodes, &texts, &mut context)?;
                            }
                        }
                    } else {
                        self.unsupported(statement.span(), "a statement in the template's setup");
                    }
                }
                Statement::ExpressionStatement(expression) => {
                    let expression = expression.expression.without_parentheses();
                    match expression {
                        Expression::CallExpression(call) => {
                            self.call(tree, call, &nodes, &mut texts, &mut context)
                        }
                        Expression::AssignmentExpression(assignment) => {
                            let target = self.text(assignment.left.span()).to_owned();
                            if target == "this.#updates" {
                                if let Expression::ArrayExpression(array) = &assignment.right {
                                    for element in &array.elements {
                                        if let Some(expression) = element.as_expression() {
                                            self.update(
                                                tree,
                                                expression,
                                                &nodes,
                                                &texts,
                                                &mut context,
                                            )?;
                                        }
                                    }
                                }
                            } else if let Expression::Identifier(node) = &assignment.right {
                                // `wrap.value = node`: a ref.
                                match nodes.get(node.name.as_str()) {
                                    Some(path) => {
                                        let variable =
                                            target.strip_suffix(".value").unwrap_or(&target);
                                        let variable = context.apply(variable);
                                        tree.attribute(path, "ref", Value::Expression(variable));
                                    }
                                    None => self.unsupported(
                                        statement.span(),
                                        "an assignment in the template's setup",
                                    ),
                                }
                            } else {
                                self.unsupported(
                                    statement.span(),
                                    "an assignment in the template's setup",
                                );
                            }
                        }
                        _ => self
                            .unsupported(statement.span(), "a statement in the template's setup"),
                    }
                }
                Statement::ReturnStatement(_) => {}
                other => self.unsupported(other.span(), "a statement in the template's setup"),
            }
        }
        Ok(())
    }

    /// A call statement in a block: a listener, a text node's place, a ref, a global listener.
    fn call(
        &mut self,
        tree: &mut Tree,
        call: &CallExpression<'_>,
        nodes: &HashMap<String, Vec<usize>>,
        texts: &mut HashMap<String, Vec<usize>>,
        context: &mut Unlower,
    ) {
        let callee = self.text(call.callee.span()).to_owned();
        let argument = |i: usize| call.arguments.get(i).and_then(Argument::as_expression);
        // `node.addEventListener("click", handler, options)`
        if let Some(node) = callee.strip_suffix(".addEventListener") {
            if let (Some(path), Some(event), Some(handler)) = (
                nodes.get(node),
                argument(0).and_then(string_value),
                argument(1),
            ) {
                let (modifiers, handler) = self.listener(handler, argument(2), node, context);
                tree.attribute(
                    path,
                    &format!("on{event}{modifiers}"),
                    Value::Expression(handler),
                );
                return;
            }
        }
        // `marker.replaceWith(text)`: a text node's place.
        if let Some(marker) = callee.strip_suffix(".replaceWith") {
            if let (Some(path), Some(Expression::Identifier(text))) =
                (tree.locate(marker, nodes), argument(0))
            {
                if texts.contains_key(text.name.as_str()) {
                    texts.insert(text.name.to_string(), path);
                    return;
                }
            }
        }
        // `this.#mounted.push(() => { const listener = …; window.addEventListener(…) … })`
        if callee == "this.#mounted.push" {
            let body = argument(0)
                .map(|expression| self.text(expression.span()).to_owned())
                .unwrap_or_default();
            for target in ["window", "document"] {
                let marker = format!("{target}.addEventListener(");
                if let Some(at) = body.find(&marker) {
                    let event = body[at + marker.len()..]
                        .split(',')
                        .next()
                        .and_then(|event| serde_json::from_str::<String>(event.trim()).ok());
                    let options = body[at + marker.len()..]
                        .split_once(", listener")
                        .and_then(|(_, rest)| rest.split(')').next())
                        .map(|rest| rest.trim_start_matches(',').trim().to_owned())
                        .unwrap_or_default();
                    if let (Some(event), Some(listener)) = (event, listener_source(&body)) {
                        let (modifiers, handler) =
                            self.listener_text(&listener, &options, target, context);
                        tree.globals.push(format!(
                            "<zb-{target} on{event}{modifiers}={{{handler}}}></zb-{target}>"
                        ));
                        return;
                    }
                }
            }
        }
        // `(ref)(node)`
        if let (
            Expression::ParenthesizedExpression(reference),
            Some(Expression::Identifier(node)),
        ) = (&call.callee, argument(0))
        {
            if let Some(path) = nodes.get(node.name.as_str()) {
                let reference = context.apply(self.text(reference.expression.span()));
                tree.attribute(path, "ref", Value::Expression(reference));
                return;
            }
        }
        self.unsupported(call.span, "a call in the template's setup");
    }

    /// A listener: (its modifiers, its handler), from the emitter's wrapper when it's one.
    fn listener(
        &mut self,
        handler: &Expression<'_>,
        options: Option<&Expression<'_>>,
        node: &str,
        context: &mut Unlower,
    ) -> (String, String) {
        let options = options
            .map(|options| self.text(options.span()).to_owned())
            .unwrap_or_default();
        let handler = self.text(handler.span()).to_owned();
        self.listener_text(&handler, &options, node, context)
    }

    fn listener_text(
        &mut self,
        handler: &str,
        options: &str,
        node: &str,
        context: &mut Unlower,
    ) -> (String, String) {
        let mut modifiers = String::new();
        for option in ["once", "capture", "passive"] {
            if options.contains(&format!("{option}: true")) {
                modifiers.push_str(&format!(".{option}"));
            }
        }
        match unwrap_listener(handler, node) {
            Some((more, inner)) => (format!("{more}{modifiers}"), context.apply(&inner)),
            None => (modifiers, context.apply(handler)),
        }
    }

    /// One update: `bind(…)`, `list(…)`, `when(…)`, `this.#slotRegion(…)`.
    fn update(
        &mut self,
        tree: &mut Tree,
        expression: &Expression<'_>,
        nodes: &HashMap<String, Vec<usize>>,
        texts: &HashMap<String, Vec<usize>>,
        context: &mut Unlower,
    ) -> Result<(), Diagnostic> {
        let Expression::CallExpression(call) = expression.without_parentheses() else {
            self.unsupported(
                expression.span(),
                "an update that isn't bind(), list(), when() or a slot",
            );
            return Ok(());
        };
        let callee = self
            .text(call.callee.span())
            .trim_start_matches('$')
            .to_owned();
        let argument = |i: usize| call.arguments.get(i).and_then(Argument::as_expression);
        match callee.as_str() {
            "bind" => {
                let (
                    Some(Expression::ArrowFunctionExpression(read)),
                    Some(Expression::ArrowFunctionExpression(write)),
                ) = (
                    argument(0).map(Expression::without_parentheses),
                    argument(1).map(Expression::without_parentheses),
                )
                else {
                    self.unsupported(
                        call.span,
                        "a bind() that isn't bind(() => read, (value) => write)",
                    );
                    return Ok(());
                };
                let Some(read) = arrow_expression(read) else {
                    self.unsupported(call.span, "a bind() whose read isn't one expression");
                    return Ok(());
                };
                let read_text = self.text(read.span()).to_owned();
                let Some(write) = arrow_expression(write) else {
                    self.unsupported(call.span, "a bind() whose write isn't one expression");
                    return Ok(());
                };
                if !self.write(tree, write, read, &read_text, nodes, texts, context) {
                    self.unsupported(
                        call.span,
                        "a bind() whose write isn't a DOM call zubra writes",
                    );
                }
            }
            "list" | "when" => {
                let (Some(start), Some(end)) = (argument(0), argument(1)) else {
                    self.unsupported(call.span, "a list() or when() without its markers");
                    return Ok(());
                };
                let (Some(start), Some(end)) = (
                    tree.locate(self.text(start.span()), nodes),
                    tree.locate(self.text(end.span()), nodes),
                ) else {
                    self.unsupported(
                        call.span,
                        "a list() or when() whose markers aren't in the template",
                    );
                    return Ok(());
                };
                let read = argument(2)
                    .and_then(|read| match read.without_parentheses() {
                        Expression::ArrowFunctionExpression(arrow) => arrow_expression(arrow),
                        _ => None,
                    })
                    .map(|read| context.apply(&unparen(self.text(read.span()))))
                    .unwrap_or_default();
                if callee == "list" {
                    let directive = self.each(argument(3), argument(4), &read, context)?;
                    tree.region(&start, &end, directive);
                } else {
                    let mut branches = Vec::new();
                    if let Some(Expression::ArrayExpression(array)) = argument(3) {
                        for element in &array.elements {
                            let branch = match element.as_expression() {
                                Some(Expression::ArrowFunctionExpression(arrow)) => {
                                    Some(self.factory(arrow, context)?.1)
                                }
                                _ => None,
                            };
                            branches.push(branch);
                        }
                    }
                    let yes = branches.first().cloned().flatten().unwrap_or_default();
                    let directive = match branches.get(1).cloned().flatten() {
                        Some(no) => {
                            format!("<zb-if test={{{read}}}>{yes}<zb-else>{no}</zb-else></zb-if>")
                        }
                        None => format!("<zb-if test={{{read}}}>{yes}</zb-if>"),
                    };
                    tree.region(&start, &end, directive);
                }
            }
            "this.#slotRegion" => {
                let (Some(start), Some(end), Some(name)) =
                    (argument(0), argument(1), argument(2).and_then(string_value))
                else {
                    self.unsupported(call.span, "a slot without its markers or name");
                    return Ok(());
                };
                let (Some(start), Some(end)) = (
                    tree.locate(self.text(start.span()), nodes),
                    tree.locate(self.text(end.span()), nodes),
                ) else {
                    self.unsupported(call.span, "a slot whose markers aren't in the template");
                    return Ok(());
                };
                let fallback = match argument(3) {
                    Some(Expression::ArrowFunctionExpression(arrow)) => {
                        self.factory(arrow, context)?.1
                    }
                    _ => String::new(),
                };
                let open = if name == "default" {
                    "<zb-slot>".to_owned()
                } else {
                    format!("<zb-slot name=\"{name}\">")
                };
                tree.region(&start, &end, format!("{open}{fallback}</zb-slot>"));
            }
            _ => self.unsupported(
                call.span,
                "an update that isn't bind(), list(), when() or a slot",
            ),
        }
        Ok(())
    }

    /// `list(start, end, () => items, key, row)` → `<zb-each …>row</zb-each>`.
    fn each(
        &mut self,
        key: Option<&Expression<'_>>,
        row: Option<&Expression<'_>>,
        items: &str,
        context: &mut Unlower,
    ) -> Result<String, Diagnostic> {
        let Some(Expression::ArrowFunctionExpression(row)) =
            row.map(Expression::without_parentheses)
        else {
            return Ok(String::new());
        };
        let params: Vec<String> = row
            .params
            .items
            .iter()
            .map(|param| self.text(param.span()).to_owned())
            .collect();
        let (pattern, content) = self.factory(row, context)?;
        let item =
            pattern.unwrap_or_else(|| params.first().cloned().unwrap_or_else(|| "item".to_owned()));
        let index = params.get(1).cloned();
        let mut attributes = format!(" items={{{items}}} as=\"{item}\"");
        let mut keyed = false;
        if let Some(Expression::ArrowFunctionExpression(key)) =
            key.map(Expression::without_parentheses)
        {
            let key_params: Vec<String> = key
                .params
                .items
                .iter()
                .map(|param| self.text(param.span()).to_owned())
                .collect();
            if let Some(body) = arrow_expression(key) {
                let body = self.text(body.span()).to_owned();
                let by_index = key_params.first().is_some_and(|first| first == "_")
                    && Some(&body) == key_params.get(1);
                if !by_index {
                    // The key's names are the row's.
                    let mut body = body;
                    for (from, to) in key_params
                        .iter()
                        .zip([&item, index.as_ref().unwrap_or(&String::new())])
                    {
                        if from != to && !to.is_empty() && !from.starts_with('{') {
                            body = rename(&body, from, to);
                        }
                    }
                    attributes.push_str(&format!(" key={{{}}}", context.apply(&unparen(&body))));
                    keyed = true;
                }
            }
        }
        if let Some(index) = &index {
            if uses_name(&content, index) || (keyed && attributes.contains(index.as_str())) {
                attributes = attributes.replacen(" key=", &format!(" index=\"{index}\" key="), 1);
                if !attributes.contains(" index=") {
                    attributes.push_str(&format!(" index=\"{index}\""));
                }
            }
        }
        Ok(format!("<zb-each{attributes}>{content}</zb-each>"))
    }

    /// A row's or branch's function: (its `as` pattern, if destructured, and its template).
    fn factory(
        &mut self,
        arrow: &ArrowFunctionExpression<'_>,
        context: &mut Unlower,
    ) -> Result<(Option<String>, String), Diagnostic> {
        let statements = arrow_statements(arrow);
        let mut pattern = None;
        let mut start = 0;
        if let Some(Statement::VariableDeclaration(declaration)) = statements.first() {
            if declaration.kind == oxc_ast::ast::VariableDeclarationKind::Let {
                if let Some(declarator) = declaration.declarations.first() {
                    pattern = Some(self.text(declarator.id.span()).to_owned());
                    start = 1;
                }
            }
        }
        let mut root = None;
        for (i, statement) in statements.iter().enumerate().skip(start) {
            if let Statement::VariableDeclaration(declaration) = statement {
                if let Some(declarator) = declaration.declarations.first() {
                    if let Some(markup) = declarator.init.as_ref().and_then(clone_markup) {
                        root = Some((
                            binding_name(&declarator.id).unwrap_or_default().to_owned(),
                            markup,
                            i,
                        ));
                        break;
                    }
                }
            }
        }
        let Some((root, markup, at)) = root else {
            self.unsupported(arrow.span, "a row or branch without its clone(…)");
            return Ok((pattern, String::new()));
        };
        let mut tree = Tree::parse(&markup);
        self.block(&mut tree, &root, &statements[at + 1..], context)?;
        Ok((pattern, tree.render()))
    }

    /// Where a `bind()` writes, and the attribute or text it is in the template.
    #[allow(clippy::too_many_arguments)]
    fn write(
        &mut self,
        tree: &mut Tree,
        write: &Expression<'_>,
        read: &Expression<'_>,
        read_text: &str,
        nodes: &HashMap<String, Vec<usize>>,
        texts: &HashMap<String, Vec<usize>>,
        context: &mut Unlower,
    ) -> bool {
        let read_js = context.apply(read_text);
        let node_of = |expression: Option<&Expression<'_>>| match expression {
            Some(Expression::Identifier(identifier)) => {
                nodes.get(identifier.name.as_str()).cloned()
            }
            _ => None,
        };
        match write.without_parentheses() {
            // `(node.textContent = value)`, `(text.data = value)`, `(child.prop = value)`
            Expression::AssignmentExpression(assignment) => {
                let AssignmentTarget::StaticMemberExpression(member) = &assignment.left else {
                    return false;
                };
                let Expression::Identifier(object) = &member.object else {
                    return false;
                };
                let property = member.property.name.as_str();
                let text = text_parts(read, self.source, context);
                match property {
                    "textContent" => match nodes.get(object.name.as_str()) {
                        Some(path) => {
                            tree.content(path, text);
                            true
                        }
                        None => false,
                    },
                    "data" => match texts.get(object.name.as_str()) {
                        Some(path) => {
                            tree.replace(path, text);
                            true
                        }
                        None => false,
                    },
                    prop => match nodes.get(object.name.as_str()) {
                        Some(path) => {
                            tree.attribute(
                                path,
                                &kebab(prop),
                                attribute_value(read, &read_js, self.source, context),
                            );
                            true
                        }
                        None => false,
                    },
                }
            }
            Expression::CallExpression(call) => {
                let argument = |i: usize| call.arguments.get(i).and_then(Argument::as_expression);
                let callee = self.text(call.callee.span()).to_owned();
                let helper = callee.trim_start_matches('$');
                let value = attribute_value(read, &read_js, self.source, context);
                // node.setAttribute("a", value) / node.toggleAttribute("a", …) / node.classList.toggle("c", …)
                if let Expression::StaticMemberExpression(member) = &call.callee {
                    let method = member.property.name.as_str();
                    let object = self.text(member.object.span()).to_owned();
                    if let Some(node) = object.strip_suffix(".classList") {
                        if let (Some(path), Some(class)) =
                            (nodes.get(node), argument(0).and_then(string_value))
                        {
                            tree.attribute(
                                path,
                                &format!("class:{class}"),
                                Value::Expression(unparen(&read_js)),
                            );
                            return true;
                        }
                    }
                    if let (Some(path), Some(name)) =
                        (nodes.get(&object), argument(0).and_then(string_value))
                    {
                        if matches!(method, "setAttribute" | "toggleAttribute") {
                            tree.attribute(path, &name, value);
                            return true;
                        }
                    }
                    return false;
                }
                match helper {
                    "attribute" | "urlAttribute" => {
                        match (node_of(argument(0)), argument(1).and_then(string_value)) {
                            (Some(path), Some(name)) => {
                                tree.attribute(&path, &name, value);
                                true
                            }
                            _ => false,
                        }
                    }
                    "setProperty" => {
                        match (node_of(argument(0)), argument(2).and_then(string_value)) {
                            (Some(path), Some(name)) => {
                                tree.attribute(&path, &name, value);
                                true
                            }
                            _ => false,
                        }
                    }
                    "setValue" => match node_of(argument(0)) {
                        Some(path) => {
                            tree.attribute(&path, "value", value);
                            true
                        }
                        None => false,
                    },
                    "setStyle" => {
                        match (node_of(argument(0)), argument(1).and_then(string_value)) {
                            (Some(path), Some(property)) => {
                                tree.attribute(
                                    &path,
                                    &format!("style:{property}"),
                                    Value::Expression(unparen(&read_js)),
                                );
                                true
                            }
                            _ => false,
                        }
                    }
                    "swapClasses" => match node_of(argument(0)) {
                        Some(path) => {
                            tree.attribute(&path, "class", value);
                            true
                        }
                        None => false,
                    },
                    _ => false,
                }
            }
            _ => false,
        }
    }
}

fn self_text(text: &str, span: OxcSpan) -> &str {
    &text[span.start as usize..span.end as usize]
}

/// An arrow function's body, when it's one expression.
fn arrow_expression<'a, 'b>(arrow: &'b ArrowFunctionExpression<'a>) -> Option<&'b Expression<'a>> {
    arrow.get_expression()
}

/// An arrow function's statements, when it has a block.
fn arrow_statements<'a, 'b>(arrow: &'b ArrowFunctionExpression<'a>) -> &'b [Statement<'a>] {
    match &arrow.body {
        oxc_ast::ast::ArrowFunctionBody::FunctionBody(body) => &body.statements,
        _ => &[],
    }
}

/// `(x)` → `x`, when the parentheses wrap the whole.
fn unparen(js: &str) -> String {
    let trimmed = js.trim();
    if let Some(inner) = trimmed
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let mut depth = 0i32;
        let balanced = inner.chars().all(|c| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            depth >= 0
        }) && depth == 0;
        if balanced && !inner.trim_start().starts_with('{') {
            return inner.trim().to_owned();
        }
    }
    trimmed.to_owned()
}

/// `x ?? ""` → `x`: how the emitter makes text of a value.
fn strip_nullish(expression: &Expression<'_>) -> Option<OxcSpan> {
    match expression.without_parentheses() {
        Expression::LogicalExpression(logical)
            if logical.operator == oxc_syntax::operator::LogicalOperator::Coalesce
                && matches!(&logical.right, Expression::StringLiteral(literal) if literal.value.as_str() == Some("")) =>
        {
            Some(logical.left.span())
        }
        _ => None,
    }
}

/// A read as template text: `"Add"`, `{count}`, or `` `${n}/${max} left` `` as `{n}/{max} left`.
fn text_parts(read: &Expression<'_>, source: &str, context: &mut Unlower) -> String {
    let text = |span: OxcSpan| &source[span.start as usize..span.end as usize];
    match read.without_parentheses() {
        Expression::StringLiteral(literal) => {
            escape_text(literal.value.as_str().unwrap_or_default())
        }
        Expression::TemplateLiteral(literal) => {
            let mut out = String::new();
            for (i, quasi) in literal.quasis.iter().enumerate() {
                out.push_str(&escape_text(
                    quasi
                        .value
                        .cooked
                        .and_then(|cooked| cooked.as_str())
                        .unwrap_or(""),
                ));
                if let Some(expression) = literal.expressions.get(i) {
                    let span = strip_nullish(expression).unwrap_or(expression.span());
                    out.push_str(&format!("{{{}}}", context.apply(&unparen(text(span)))));
                }
            }
            out
        }
        other => {
            let span = strip_nullish(other).unwrap_or(other.span());
            format!("{{{}}}", context.apply(&unparen(text(span))))
        }
    }
}

/// A read as an attribute's value: text (`"Fewer {label}"`) when it's text, else `{expression}`.
fn attribute_value(
    read: &Expression<'_>,
    read_js: &str,
    source: &str,
    context: &mut Unlower,
) -> Value {
    match read.without_parentheses() {
        Expression::StringLiteral(literal) => {
            Value::Text(escape_attribute(literal.value.as_str().unwrap_or_default()))
        }
        // Text with values in it, as the emitter writes it: each value `?? ""`.
        Expression::TemplateLiteral(literal)
            if !literal.expressions.is_empty()
                && literal
                    .expressions
                    .iter()
                    .all(|expression| strip_nullish(expression).is_some()) =>
        {
            Value::Text(text_parts(read, source, context).replace('"', "&quot;"))
        }
        _ => Value::Expression(unparen(read_js)),
    }
}

/// `tag` → `name`, as a whole word.
fn rename(text: &str, from: &str, to: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(from) {
        let before = rest[..at].chars().last();
        let after = rest[at + from.len()..].chars().next();
        let boundary =
            |c: Option<char>| !c.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$');
        out.push_str(&rest[..at]);
        if boundary(before) && boundary(after) && before != Some('.') {
            out.push_str(to);
        } else {
            out.push_str(from);
        }
        rest = &rest[at + from.len()..];
    }
    out.push_str(rest);
    out
}

/// `const listener = …;` in a global listener's setup (`body` is the whole arrow function).
fn listener_source(body: &str) -> Option<String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, body, SourceType::mjs())
        .parse_expression()
        .ok()?;
    let Expression::ArrowFunctionExpression(arrow) = parsed.without_parentheses() else {
        return None;
    };
    for statement in arrow_statements(arrow) {
        if let Statement::VariableDeclaration(declaration) = statement {
            let declarator = declaration.declarations.first()?;
            if binding_name(&declarator.id) == Some("listener") {
                let span = declarator.init.as_ref()?.span();
                return Some(body[span.start as usize..span.end as usize].to_owned());
            }
        }
    }
    None
}

/// The emitter's listener wrapper → (`.modifiers`, the handler), or `None` for any other function.
fn unwrap_listener(handler: &str, node: &str) -> Option<(String, String)> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, handler, SourceType::mjs())
        .parse_expression()
        .ok()?;
    let Expression::ArrowFunctionExpression(arrow) = parsed.without_parentheses() else {
        return None;
    };
    if arrow.is_expression() || arrow.params.items.len() != 1 {
        return None;
    }
    let text = |span: OxcSpan| handler[span.start as usize..span.end as usize].to_owned();
    let mut modifiers = String::new();
    let mut inner = None;
    let mut keys_given = false;
    let statements = arrow_statements(arrow);
    let mut i = 0;
    while i < statements.len() {
        let line = text(statements[i].span());
        let compact = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if compact == format!("if (event.target !== {node}) return;") {
            modifiers.push_str(".self");
        } else if let Some(keys) = compact
            .strip_prefix("if (!(")
            .and_then(|rest| rest.strip_suffix(")) return;"))
        {
            for key in keys.split(" || ") {
                let value = key
                    .rsplit("=== ")
                    .next()
                    .and_then(|value| serde_json::from_str::<String>(value).ok())?;
                modifiers.push_str(&format!(".{}", key_modifier(&value)));
            }
            keys_given = true;
        } else if let Some(checks) = compact
            .strip_prefix("if (")
            .and_then(|rest| rest.strip_suffix(") return;"))
        {
            for check in checks.split(" || ") {
                let check = check.trim_matches(|c| c == '(' || c == ')');
                let held = |name: &str| {
                    check.contains(&format!("!event.{name}Key")) && !check.contains("apple")
                };
                let named = |name: &str| ["shift", "ctrl", "alt", "meta"].contains(&name);
                if check.contains("apple") {
                    if check.contains("ctrlKey") {
                        modifiers.push_str(".mod");
                    }
                    continue;
                }
                for name in ["shift", "ctrl", "alt", "meta"] {
                    if named(name) && held(name) {
                        modifiers.push_str(&format!(".{name}"));
                    }
                }
                let _ = keys_given;
            }
        } else if compact == "event.preventDefault();" {
            modifiers.push_str(".prevent");
        } else if compact == "event.stopPropagation();" {
            modifiers.push_str(".stop");
        } else if let Some(rest) = compact.strip_prefix("const handler = ") {
            inner = Some(rest.trim_end_matches(';').to_owned());
            i += 1; // the `if (typeof handler === "function") …` after it
        } else if compact.ends_with(".requestSubmit();") {
            modifiers.push_str(".submit");
        } else if compact.ends_with("(event);") && inner.is_none() {
            inner = Some(compact.trim_end_matches("(event);").to_owned());
        } else {
            return None;
        }
        i += 1;
    }
    Some((modifiers, inner?))
}

/// `"Enter"` → `enter`, `"ArrowUp"` → `up`, `"k"` → `k`.
fn key_modifier(key: &str) -> String {
    match key {
        "Enter" => "enter",
        "Tab" => "tab",
        " " => "space",
        "Escape" => "esc",
        "ArrowUp" => "up",
        "ArrowDown" => "down",
        "ArrowLeft" => "left",
        "ArrowRight" => "right",
        "Delete" => "delete",
        "Backspace" => "backspace",
        "Home" => "home",
        "End" => "end",
        "PageUp" => "pageup",
        "PageDown" => "pagedown",
        other => return other.to_ascii_lowercase(),
    }
    .to_owned()
}

// ---- the template's markup

/// An attribute's value in the `.zb` file.
#[derive(Debug, Clone)]
enum Value {
    None,
    /// As written in the markup (already escaped), possibly with `{…}` in it.
    Text(String),
    Expression(String),
}

#[derive(Debug, Clone)]
enum HtmlNode {
    Element {
        name: String,
        attributes: Vec<(String, Value)>,
        children: Vec<HtmlNode>,
    },
    Text(String),
    Comment(String),
    /// `.zb` markup put in a node's place (`{count}`, `<zb-each …>…</zb-each>`).
    Zb(String),
    /// A marker that ended a region (its directive is at the region's start).
    Removed,
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

struct Tree {
    nodes: Vec<HtmlNode>,
    /// `<zb-window>`/`<zb-document>` listeners: no place in the markup, so they go first.
    globals: Vec<String>,
}

/// An element being read: its name, attributes and children so far.
type Open = (String, Vec<(String, Value)>, Vec<HtmlNode>);

impl Tree {
    fn parse(markup: &str) -> Self {
        let mut stack: Vec<Open> = vec![(String::new(), Vec::new(), Vec::new())];
        let mut rest = markup;
        while !rest.is_empty() {
            if let Some(after) = rest.strip_prefix("<!--") {
                let end = after.find("-->").unwrap_or(after.len());
                stack
                    .last_mut()
                    .expect("root")
                    .2
                    .push(HtmlNode::Comment(after[..end].to_owned()));
                rest = &after[(end + 3).min(after.len())..];
            } else if let Some(after) = rest.strip_prefix("</") {
                let end = after.find('>').unwrap_or(after.len());
                let name = after[..end].trim().to_ascii_lowercase();
                rest = &after[(end + 1).min(after.len())..];
                if stack.len() > 1
                    && stack
                        .last()
                        .is_some_and(|(open, _, _)| open.eq_ignore_ascii_case(&name))
                {
                    let (name, attributes, children) = stack.pop().expect("open");
                    stack.last_mut().expect("root").2.push(HtmlNode::Element {
                        name,
                        attributes,
                        children,
                    });
                }
            } else if rest.starts_with('<')
                && rest[1..].starts_with(|c: char| c.is_ascii_alphabetic())
            {
                let (name, attributes, length, self_closing) = open_tag(rest);
                rest = &rest[length..];
                let void = VOID.contains(&name.to_ascii_lowercase().as_str()) || self_closing;
                if void {
                    stack.last_mut().expect("root").2.push(HtmlNode::Element {
                        name,
                        attributes,
                        children: Vec::new(),
                    });
                } else {
                    let drops_newline = matches!(
                        name.to_ascii_lowercase().as_str(),
                        "pre" | "textarea" | "listing"
                    );
                    if drops_newline {
                        if let Some(after) = rest.strip_prefix('\n') {
                            rest = after;
                        }
                    }
                    stack.push((name, attributes, Vec::new()));
                }
            } else {
                let first = rest.chars().next().map_or(1, char::len_utf8);
                let end = rest[first..].find('<').map_or(rest.len(), |at| at + first);
                let text = &rest[..end];
                if !text.is_empty() {
                    stack
                        .last_mut()
                        .expect("root")
                        .2
                        .push(HtmlNode::Text(text.to_owned()));
                }
                rest = &rest[end..];
            }
        }
        while stack.len() > 1 {
            let (name, attributes, children) = stack.pop().expect("open");
            stack.last_mut().expect("root").2.push(HtmlNode::Element {
                name,
                attributes,
                children,
            });
        }
        Self {
            nodes: stack.pop().expect("root").2,
            globals: Vec::new(),
        }
    }

    fn children_at(&self, path: &[usize]) -> Option<&Vec<HtmlNode>> {
        let mut children = &self.nodes;
        for &index in path {
            match children.get(index)? {
                HtmlNode::Element {
                    children: inner, ..
                } => children = inner,
                _ => return None,
            }
        }
        Some(children)
    }

    fn at(&mut self, path: &[usize]) -> Option<&mut HtmlNode> {
        let (last, parents) = path.split_last()?;
        let mut children = &mut self.nodes;
        for &index in parents {
            match children.get_mut(index)? {
                HtmlNode::Element {
                    children: inner, ..
                } => children = inner,
                _ => return None,
            }
        }
        children.get_mut(*last)
    }

    /// A lookup (`content.children[0].childNodes[2]`, from the named nodes) → its path.
    fn locate(&self, expression: &str, nodes: &HashMap<String, Vec<usize>>) -> Option<Vec<usize>> {
        let expression = expression.trim();
        let start = expression.find(['.', '[']).unwrap_or(expression.len());
        let mut path = nodes.get(&expression[..start])?.clone();
        let mut rest = &expression[start..];
        while !rest.is_empty() {
            let (elements, after) = match rest.strip_prefix(".children[") {
                Some(after) => (true, after),
                None => (false, rest.strip_prefix(".childNodes[")?),
            };
            let close = after.find(']')?;
            let index: usize = after[..close].parse().ok()?;
            rest = &after[close + 1..];
            let children = self.children_at(&path)?;
            let mut seen = 0;
            let mut found = None;
            for (position, child) in children.iter().enumerate() {
                let counts = match child {
                    HtmlNode::Element { .. } => true,
                    _ => !elements,
                };
                if counts {
                    if seen == index {
                        found = Some(position);
                        break;
                    }
                    seen += 1;
                }
            }
            path.push(found?);
        }
        Some(path)
    }

    fn attribute(&mut self, path: &[usize], name: &str, value: Value) {
        if let Some(HtmlNode::Element { attributes, .. }) = self.at(path) {
            attributes.push((name.to_owned(), value));
        }
    }

    fn content(&mut self, path: &[usize], zb: String) {
        if let Some(HtmlNode::Element { children, .. }) = self.at(path) {
            *children = vec![HtmlNode::Zb(zb)];
        }
    }

    fn replace(&mut self, path: &[usize], zb: String) {
        if let Some(node) = self.at(path) {
            *node = HtmlNode::Zb(zb);
        }
    }

    fn region(&mut self, start: &[usize], end: &[usize], zb: String) {
        self.replace(start, zb);
        if let Some(node) = self.at(end) {
            *node = HtmlNode::Removed;
        }
    }

    fn render(&self) -> String {
        let mut out = String::new();
        let mut nodes = self.nodes.clone();
        // On their own line, where the template's first line break and indentation leave room.
        if let (false, Some(HtmlNode::Text(text))) = (self.globals.is_empty(), nodes.first()) {
            if text.trim().is_empty() && text.matches('\n').count() >= 2 {
                let second = text.match_indices('\n').nth(1).map_or(0, |(at, _)| at);
                out.push_str(&text[..second]);
                nodes[0] = HtmlNode::Text(text[second..].to_owned());
            }
        }
        for global in &self.globals {
            out.push_str(global);
        }
        render(&nodes, &mut out);
        out
    }
}

/// `<name a="b" c>`: (name, attributes, length, self-closing).
fn open_tag(text: &str) -> (String, Vec<(String, Value)>, usize, bool) {
    let bytes = text.as_bytes();
    let mut i = 1;
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' && bytes[i] != b'/'
    {
        i += 1;
    }
    let name = text[1..i].to_owned();
    let mut attributes = Vec::new();
    let mut self_closing = false;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        if bytes[i] == b'>' {
            i += 1;
            break;
        }
        if bytes[i] == b'/' {
            self_closing = true;
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'>'
            && bytes[i] != b'/'
        {
            i += 1;
        }
        let attribute = text[start..i].to_owned();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let value = if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                let open = i + 1;
                i = open;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                let value = text[open..i.min(text.len())].to_owned();
                i += 1;
                value
            } else {
                let open = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                text[open..i].to_owned()
            };
            attributes.push((attribute, Value::Text(value)));
        } else {
            attributes.push((attribute, Value::None));
        }
    }
    (name, attributes, i.min(text.len()), self_closing)
}

fn render(nodes: &[HtmlNode], out: &mut String) {
    for node in nodes {
        match node {
            HtmlNode::Element {
                name,
                attributes,
                children,
            } => {
                out.push('<');
                out.push_str(name);
                for (attribute, value) in attributes {
                    match value {
                        Value::None => out.push_str(&format!(" {attribute}")),
                        Value::Text(text) => out.push_str(&format!(" {attribute}=\"{text}\"")),
                        Value::Expression(js) => out.push_str(&format!(" {attribute}={{{js}}}")),
                    }
                }
                out.push('>');
                if !VOID.contains(&name.to_ascii_lowercase().as_str()) {
                    render(children, out);
                    out.push_str(&format!("</{name}>"));
                }
            }
            HtmlNode::Text(text) => out.push_str(text),
            HtmlNode::Comment(data) => out.push_str(&format!("<!--{data}-->")),
            HtmlNode::Zb(zb) => out.push_str(zb),
            HtmlNode::Removed => {}
        }
    }
}
