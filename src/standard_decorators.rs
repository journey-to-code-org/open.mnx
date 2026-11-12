//! Standard decorators (TC39's, TypeScript's default since 5.0) and `accessor` fields, lowered
//! the way `tsc` lowers them for ES2022, since no browser runs either yet. Its helpers too, as
//! `__zubraEsDecorate`, `__zubraRunInitializers`, `__zubraSetFunctionName` and `__zubraPropKey`.
//!
//! A decorated class is wrapped in a function that declares the decorators' bookkeeping
//! (`let A = (() => { let _zb_d0, …; return class A { … }; })();`), and a static block at the
//! top of the class applies them. Everything goes on lines that are already there, and each
//! member's code stays where it was:
//!
//! - a field's value runs through its decorators' initializers in place
//!   (`f = __zubraRunInitializers(this, _zb_i0, 1)`), and their extra initializers run right
//!   after it's defined, as a private field (or a static block) that follows it;
//! - a private method's function is created where it was, in the computed name of a throwaway
//!   static field, so the decorators get it before the class is finished;
//! - `accessor x = 1` is a private `#x_accessor_storage` field with a getter and a setter.

use std::collections::HashSet;

use oxc_ast::ast::{
    AccessorProperty, AccessorPropertyType, Class, ClassElement, ClassType, Decorator,
    MethodDefinition, MethodDefinitionKind, MethodDefinitionType, PropertyDefinitionType,
    PropertyKey,
};
use oxc_span::{GetSpan, Span as Range};

use super::{Piece, Stripper};

/// TypeScript's `__esDecorate`.
const ES_DECORATE: &str = "const __zubraEsDecorate = function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) { function accept(f) { if (f !== void 0 && typeof f !== \"function\") throw new TypeError(\"Function expected\"); return f; } var kind = contextIn.kind, key = kind === \"getter\" ? \"get\" : kind === \"setter\" ? \"set\" : \"value\"; var target = !descriptorIn && ctor ? contextIn[\"static\"] ? ctor : ctor.prototype : null; var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {}); var _, done = false; for (var i = decorators.length - 1; i >= 0; i--) { var context = {}; for (var p in contextIn) context[p] = p === \"access\" ? {} : contextIn[p]; for (var p in contextIn.access) context.access[p] = contextIn.access[p]; context.addInitializer = function (f) { if (done) throw new TypeError(\"Cannot add initializers after decoration has completed\"); extraInitializers.push(accept(f || null)); }; var result = (0, decorators[i])(kind === \"accessor\" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context); if (kind === \"accessor\") { if (result === void 0) continue; if (result === null || typeof result !== \"object\") throw new TypeError(\"Object expected\"); if (_ = accept(result.get)) descriptor.get = _; if (_ = accept(result.set)) descriptor.set = _; if (_ = accept(result.init)) initializers.unshift(_); } else if (_ = accept(result)) { if (kind === \"field\") initializers.unshift(_); else descriptor[key] = _; } } if (target) Object.defineProperty(target, contextIn.name, descriptor); done = true; }; ";

/// TypeScript's `__runInitializers`.
const RUN_INITIALIZERS: &str = "const __zubraRunInitializers = function (thisArg, initializers, value) { var useValue = arguments.length > 2; for (var i = 0; i < initializers.length; i++) { value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg); } return useValue ? value : void 0; }; ";

/// TypeScript's `__setFunctionName`.
const SET_FUNCTION_NAME: &str = "const __zubraSetFunctionName = function (f, name, prefix) { if (typeof name === \"symbol\") name = name.description ? \"[\".concat(name.description, \"]\") : \"\"; return Object.defineProperty(f, \"name\", { configurable: true, value: prefix ? \"\".concat(prefix, \" \", name) : name }); }; ";

/// TypeScript's `__propKey`.
const PROP_KEY: &str =
    "const __zubraPropKey = function (x) { return typeof x === \"symbol\" ? x : \"\".concat(x); }; ";

/// The helpers the lowering used, for the script's first line.
pub(super) fn helpers(used: &HashSet<&'static str>, out: &mut String) {
    for (name, text) in [
        ("esDecorate", ES_DECORATE),
        ("runInitializers", RUN_INITIALIZERS),
        ("setFunctionName", SET_FUNCTION_NAME),
        ("propKey", PROP_KEY),
    ] {
        if used.contains(name) {
            out.push_str(text);
        }
    }
}

/// A member's name, as the decorators see it.
enum Key {
    /// `x`
    Identifier(String),
    /// `"x"`, `1`, `["x"]`: the name as a string.
    Literal(String),
    /// `#x`, without the `#`.
    Private(String),
    /// `[expression]`, evaluated once into `_zb_k{n}`.
    Computed(Range),
}

impl Key {
    fn of(key: &PropertyKey<'_>, computed: bool) -> Self {
        match key {
            PropertyKey::StaticIdentifier(identifier) if !computed => {
                Self::Identifier(identifier.name.to_string())
            }
            PropertyKey::PrivateIdentifier(identifier) => {
                Self::Private(identifier.name.to_string())
            }
            PropertyKey::StringLiteral(literal) => {
                Self::Literal(literal.value.as_str().unwrap_or_default().to_owned())
            }
            PropertyKey::NumericLiteral(number) => {
                Self::Literal(crate::enums::js_number(number.value))
            }
            other => Self::Computed(other.span()),
        }
    }

    /// The context's `name`.
    fn name(&self, n: usize) -> String {
        match self {
            Self::Identifier(name) | Self::Literal(name) => json(name),
            Self::Private(name) => json(&format!("#{name}")),
            Self::Computed(_) => format!("_zb_k{n}"),
        }
    }

    /// `obj.x`, `obj["x"]`, `obj.#x`, `obj[_zb_k0]`.
    fn read(&self, n: usize) -> String {
        match self {
            Self::Identifier(name) => format!("obj.{name}"),
            Self::Private(name) => format!("obj.#{name}"),
            _ => format!("obj[{}]", self.name(n)),
        }
    }

    fn has(&self, n: usize) -> String {
        match self {
            Self::Private(name) => format!("#{name} in obj"),
            _ => format!("{} in obj", self.name(n)),
        }
    }
}

fn json(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Method,
    Getter,
    Setter,
    Field,
    Accessor,
}

/// A decorated member, numbered `n` in the order they're written.
struct Member {
    n: usize,
    kind: Kind,
    is_static: bool,
    key: Key,
    /// An accessor's storage (`#x_accessor_storage`).
    storage: Option<String>,
}

impl Member {
    /// The `__esDecorate(…)` call that applies its decorators.
    fn call(&self) -> String {
        let n = self.n;
        let private = matches!(self.key, Key::Private(_));
        let kind = match self.kind {
            Kind::Method => "method",
            Kind::Getter => "getter",
            Kind::Setter => "setter",
            Kind::Field => "field",
            Kind::Accessor => "accessor",
        };
        let target = if self.kind == Kind::Field {
            "null"
        } else {
            "this"
        };
        let descriptor = match (self.kind, &self.key, &self.storage) {
            (Kind::Method | Kind::Getter | Kind::Setter, Key::Private(_), _) => format!("_zb_p{n}"),
            (Kind::Accessor, Key::Private(name), Some(storage)) => format!(
                "_zb_p{n} = {{ get: __zubraSetFunctionName(function () {{ return this.{storage}; }}, \"#{name}\", \"get\"), set: __zubraSetFunctionName(function (value) {{ this.{storage} = value; }}, \"#{name}\", \"set\") }}"
            ),
            _ => "null".to_owned(),
        };
        let mut access = vec![format!("has: obj => {}", self.key.has(n))];
        if self.kind != Kind::Setter {
            access.push(format!("get: obj => {}", self.key.read(n)));
        }
        if matches!(self.kind, Kind::Setter | Kind::Field | Kind::Accessor) {
            access.push(format!(
                "set: (obj, value) => {{ {} = value; }}",
                self.key.read(n)
            ));
        }
        let (initializers, extra) = match self.kind {
            Kind::Field | Kind::Accessor => (format!("_zb_i{n}"), format!("_zb_e{n}")),
            _ if self.is_static => ("null".to_owned(), "_zb_staticExtra".to_owned()),
            _ => ("null".to_owned(), "_zb_instanceExtra".to_owned()),
        };
        format!(
            "__zubraEsDecorate({target}, {descriptor}, _zb_d{n}, {{ kind: \"{kind}\", name: {}, static: {}, private: {private}, access: {{ {} }}, metadata: _zb_metadata }}, {initializers}, {extra}); ",
            self.key.name(n),
            self.is_static,
            access.join(", "),
        )
    }

    /// The order `tsc` applies them in: static methods and accessors, then instance ones, then
    /// static fields, then instance fields.
    fn group(&self) -> u8 {
        match (self.kind == Kind::Field, self.is_static) {
            (false, true) => 0,
            (false, false) => 1,
            (true, true) => 2,
            (true, false) => 3,
        }
    }

    /// Its `let`: the decorators, and what goes with them.
    fn declaration(&self) -> String {
        let n = self.n;
        let mut names = vec![format!("_zb_d{n}")];
        if matches!(self.kind, Kind::Field | Kind::Accessor) {
            names.push(format!("_zb_i{n} = []"));
            names.push(format!("_zb_e{n} = []"));
        }
        if matches!(self.key, Key::Private(_)) && self.kind != Kind::Field {
            names.push(format!("_zb_p{n}"));
        }
        if matches!(self.key, Key::Computed(_)) {
            names.push(format!("_zb_k{n}"));
        }
        format!("let {}; ", names.join(", "))
    }
}

/// A field's (or accessor's) extra initializers, run right after it's defined.
fn extra_initializers(is_static: bool, n: usize) -> String {
    if is_static {
        format!("static {{ __zubraRunInitializers(this, _zb_e{n}); }}")
    } else {
        format!("#_zb_e{n} = __zubraRunInitializers(this, _zb_e{n});")
    }
}

/// A class element's name, if it has one.
fn element_key(element: &ClassElement<'_>) -> Option<Key> {
    match element {
        ClassElement::MethodDefinition(method) => Some(Key::of(&method.key, method.computed)),
        ClassElement::PropertyDefinition(property) => {
            Some(Key::of(&property.key, property.computed))
        }
        ClassElement::AccessorProperty(accessor) => Some(Key::of(&accessor.key, accessor.computed)),
        _ => None,
    }
}

fn element_decorators<'e, 'a>(element: &'e ClassElement<'a>) -> &'e [Decorator<'a>] {
    match element {
        ClassElement::MethodDefinition(method) => &method.decorators,
        ClassElement::PropertyDefinition(property) => &property.decorators,
        ClassElement::AccessorProperty(accessor) => &accessor.decorators,
        _ => &[],
    }
}

impl Stripper<'_> {
    /// Standard decorators on a class and its members, and its `accessor` fields.
    pub(super) fn standard_decorators(&mut self, class: &Class<'_>) {
        for element in &class.body.body {
            let ClassElement::MethodDefinition(method) = element else {
                continue;
            };
            let param = method
                .value
                .params
                .items
                .iter()
                .find_map(|param| param.decorators.first());
            if let Some(decorator) = param {
                return self.fail(
                    decorator.span.start,
                    "a parameter decorator is one of TypeScript's legacy decorators: standard decorators don't have them (TS1206)",
                    Some("set `\"experimentalDecorators\": true` in tsconfig.json for the legacy ones"),
                );
            }
        }
        let class_decorated = !class.decorators.is_empty();
        if !class_decorated
            && class
                .body
                .body
                .iter()
                .all(|element| element_decorators(element).is_empty())
        {
            return self.auto_accessors(class);
        }
        let name = class.id.as_ref().map(|id| id.name.to_string());
        // A static accessor's storage is read through the class itself: by its name, or, when a
        // class decorator can replace what the name holds, as `_zb_class` (the original).
        let class_ref = match (&name, class_decorated) {
            (Some(name), false) => name.clone(),
            _ => "_zb_class".to_owned(),
        };
        self.decorator_helpers.insert("esDecorate");
        self.decorator_helpers.insert("runInitializers");

        // Before the class: the class's decorators, then its heritage, then the bookkeeping.
        let mut lets: Vec<Piece> = Vec::new();
        if class_decorated {
            lets.push(Piece::Text("let _zb_classDecorators = [".to_owned()));
            lets.extend(self.decorator_copies(&class.decorators));
            lets.push(Piece::Text(
                "], _zb_classDescriptor, _zb_classExtra = [], _zb_classThis, _zb_class; "
                    .to_owned(),
            ));
        }
        if let Some(heritage) = &class.heritage {
            let expression = heritage.expression.span();
            lets.push(Piece::Text("let _zb_super = ".to_owned()));
            lets.push(Piece::Copy(expression));
            lets.push(Piece::Text("; ".to_owned()));
            self.replacements.push((expression, "_zb_super".to_owned()));
        }

        let mut members: Vec<Member> = Vec::new();
        // The decorators of members with plain names, evaluated in the static block.
        let mut evaluated: Vec<Piece> = Vec::new();
        let mut throwaway = false;
        for element in &class.body.body {
            let n = members.len();
            // A computed name evaluates the decorators written before it (as `tsc` does), so
            // they're evaluated in order with it.
            if element_decorators(element).is_empty() {
                if let Some(Key::Computed(range)) = element_key(element) {
                    if !evaluated.is_empty() {
                        let mut before = vec![Piece::Text("(".to_owned())];
                        before.extend(std::mem::take(&mut evaluated));
                        before.push(Piece::Text(", ".to_owned()));
                        self.insert_pieces(range.start, before);
                        self.insert_pieces(range.end, vec![Piece::Text(")".to_owned())]);
                    }
                }
            }
            match element {
                ClassElement::MethodDefinition(method) if !method.decorators.is_empty() => {
                    if method.kind == MethodDefinitionKind::Constructor
                        || method.value.body.is_none()
                        || method.r#type == MethodDefinitionType::TSAbstractMethodDefinition
                    {
                        return self.not_here(&method.decorators);
                    }
                    let kind = match method.kind {
                        MethodDefinitionKind::Get => Kind::Getter,
                        MethodDefinitionKind::Set => Kind::Setter,
                        _ => Kind::Method,
                    };
                    let key = Key::of(&method.key, method.computed);
                    self.member_decorators(&method.decorators, &key, n, &mut evaluated);
                    if let Key::Private(private) = &key {
                        self.private_method(method, private, n, kind);
                        throwaway = true;
                    }
                    members.push(Member {
                        n,
                        kind,
                        is_static: method.r#static,
                        key,
                        storage: None,
                    });
                }
                ClassElement::PropertyDefinition(property) if !property.decorators.is_empty() => {
                    if property.declare
                        || property.r#type == PropertyDefinitionType::TSAbstractPropertyDefinition
                    {
                        return self.not_here(&property.decorators);
                    }
                    let key = Key::of(&property.key, property.computed);
                    let assigned = !self.define_fields && !matches!(key, Key::Private(_));
                    if assigned {
                        if let Key::Computed(range) = key {
                            return self.fail(
                                range.start,
                                "a decorated field with a computed name needs `useDefineForClassFields` (TypeScript's default for ES2022 and later)",
                                Some("give the field a plain name, or remove `\"useDefineForClassFields\": false` from tsconfig.json"),
                            );
                        }
                        // Assigned in the constructor: `assigned_fields` wraps it there.
                        self.field_wraps.insert(property.span.start, n);
                    }
                    self.member_decorators(&property.decorators, &key, n, &mut evaluated);
                    if !assigned {
                        self.initialized(
                            property.value.as_ref().map(GetSpan::span),
                            property.span,
                            n,
                        );
                        self.after_element(
                            property.span,
                            &extra_initializers(property.r#static, n),
                        );
                    }
                    members.push(Member {
                        n,
                        kind: Kind::Field,
                        is_static: property.r#static,
                        key,
                        storage: None,
                    });
                }
                ClassElement::AccessorProperty(accessor) => {
                    let decorated = !accessor.decorators.is_empty();
                    let key = Key::of(&accessor.key, accessor.computed);
                    if decorated
                        && accessor.r#type != AccessorPropertyType::TSAbstractAccessorProperty
                    {
                        self.member_decorators(&accessor.decorators, &key, n, &mut evaluated);
                    }
                    let Some(storage) =
                        self.accessor(accessor, &key, decorated.then_some(n), &class_ref)
                    else {
                        continue;
                    };
                    if decorated {
                        members.push(Member {
                            n,
                            kind: Kind::Accessor,
                            is_static: accessor.r#static,
                            key,
                            storage: Some(storage),
                        });
                    }
                }
                _ => {}
            }
        }
        if self.error.is_some() {
            return;
        }
        let instance_extra = members.iter().any(|member| {
            !member.is_static && matches!(member.kind, Kind::Method | Kind::Getter | Kind::Setter)
        });
        let static_extra = members.iter().any(|member| {
            member.is_static && matches!(member.kind, Kind::Method | Kind::Getter | Kind::Setter)
        });
        if instance_extra {
            lets.push(Piece::Text("let _zb_instanceExtra = []; ".to_owned()));
        }
        if static_extra {
            lets.push(Piece::Text("let _zb_staticExtra = []; ".to_owned()));
        }
        if throwaway {
            lets.push(Piece::Text("const _zb_drop = Symbol(); ".to_owned()));
        }
        for member in &members {
            lets.push(Piece::Text(member.declaration()));
        }

        // The static block that applies them, first in the class.
        let mut block = vec![Piece::Text(" static { ".to_owned())];
        if class_decorated {
            block.push(Piece::Text("_zb_classThis = _zb_class = this; ".to_owned()));
        } else if name.is_none() {
            block.push(Piece::Text("_zb_class = this; ".to_owned()));
            lets.push(Piece::Text("let _zb_class; ".to_owned()));
        }
        let contextual = if name.is_none() {
            self.class_names.get(&class.span.start).cloned()
        } else {
            None
        };
        if let Some(contextual) = &contextual {
            self.decorator_helpers.insert("setFunctionName");
            block.push(Piece::Text(format!(
                "__zubraSetFunctionName(this, {}); ",
                json(contextual)
            )));
        }
        block.push(Piece::Text(format!(
            "const _zb_metadata = typeof Symbol === \"function\" && Symbol.metadata ? Object.create({}) : void 0; ",
            if class.heritage.is_some() {
                "_zb_super[Symbol.metadata] ?? null"
            } else {
                "null"
            }
        )));
        if !evaluated.is_empty() {
            block.extend(evaluated);
            block.push(Piece::Text("0; ".to_owned()));
        }
        members.sort_by_key(Member::group);
        for member in &members {
            block.push(Piece::Text(member.call()));
        }
        // A named class declared as `var A = class { … }` (see below), so the class's own
        // references to `A` see what the class decorators return.
        let variable = class_decorated.then(|| name.clone()).flatten();
        if class_decorated {
            let assign = variable
                .as_ref()
                .map(|name| format!("{name} = "))
                .unwrap_or_default();
            block.push(Piece::Text(format!(
                "__zubraEsDecorate(null, _zb_classDescriptor = {{ value: _zb_classThis }}, _zb_classDecorators, {{ kind: \"class\", name: _zb_classThis.name, metadata: _zb_metadata }}, null, _zb_classExtra); {assign}_zb_classThis = _zb_classDescriptor.value; "
            )));
        }
        block.push(Piece::Text(format!(
            "if (_zb_metadata) Object.defineProperty({}, Symbol.metadata, {{ enumerable: true, configurable: true, writable: true, value: _zb_metadata }}); ",
            if class_decorated { "_zb_classThis" } else { "this" }
        )));
        if static_extra {
            block.push(Piece::Text(
                "__zubraRunInitializers(this, _zb_staticExtra); ".to_owned(),
            ));
        }
        block.push(Piece::Text("}".to_owned()));
        if instance_extra {
            // The first instance field: methods' extra initializers run before any field's.
            block.push(Piece::Text(
                " #_zb_instanceExtra = __zubraRunInitializers(this, _zb_instanceExtra);".to_owned(),
            ));
        }
        self.insert_pieces(class.body.span.start + 1, block);

        // And one last, once the static fields are defined.
        let mut last = String::new();
        if throwaway {
            last.push_str("delete this[_zb_drop]; ");
        }
        if class_decorated {
            last.push_str("__zubraRunInitializers(_zb_classThis, _zb_classExtra); ");
        }
        if !last.is_empty() {
            self.insert_pieces(
                class.body.span.end - 1,
                vec![Piece::Text(format!("; static {{ {last}}} "))],
            );
        }

        // The wrapper, on the class's first and last lines.
        let keyword = self.class_keyword(class);
        let default_export = self.default_exports.get(&class.span.start).copied();
        if let Some(range) = default_export {
            self.blank(range);
        }
        let declared = class.r#type == ClassType::ClassDeclaration && name.is_some();
        let mut open = Vec::new();
        let mut close = String::new();
        match (&name, declared) {
            (Some(name), true) => open.push(Piece::Text(format!("const {name} = (() => {{ "))),
            _ => open.push(Piece::Text("(() => { ".to_owned())),
        }
        open.extend(lets);
        match (&variable, &name) {
            (Some(variable), _) => {
                open.push(Piece::Text(format!("var {variable} = ")));
                if let Some(id) = &class.id {
                    self.blank(id.span);
                }
                close.push_str(&format!("; return {variable} = _zb_classThis; }})()"));
            }
            (None, None) if class_decorated => {
                open.push(Piece::Text("return (".to_owned()));
                close.push_str("), _zb_classThis; })()");
            }
            _ => {
                open.push(Piece::Text("return ".to_owned()));
                close.push_str("; })()");
            }
        }
        // (A statement: a declaration, or `export default class {}`.)
        if class.r#type == ClassType::ClassDeclaration {
            close.push(';');
        }
        if let (Some(name), Some(_)) = (&name, default_export) {
            close.push_str(&format!(" export {{ {name} as default }};"));
        }
        self.insert_pieces(keyword, open);
        self.insert_pieces(class.span.end, vec![Piece::Text(close)]);
    }

    /// `accessor` fields in a class without standard decorators.
    pub(super) fn auto_accessors(&mut self, class: &Class<'_>) {
        let class_ref = class
            .id
            .as_ref()
            .map_or_else(|| "this".to_owned(), |id| id.name.to_string());
        for element in &class.body.body {
            if let ClassElement::AccessorProperty(accessor) = element {
                let key = Key::of(&accessor.key, accessor.computed);
                self.accessor(accessor, &key, None, &class_ref);
            }
        }
    }

    /// `accessor x = 1` → `#x_accessor_storage = 1; get x() { … } set x(value) { … }`, with its
    /// decorators' initializers when it's decorated (as member `n`). The storage's name, unless
    /// it's abstract (and so goes).
    fn accessor(
        &mut self,
        accessor: &AccessorProperty<'_>,
        key: &Key,
        n: Option<usize>,
        class_ref: &str,
    ) -> Option<String> {
        if accessor.r#type == AccessorPropertyType::TSAbstractAccessorProperty {
            if !accessor.decorators.is_empty() {
                self.not_here(&accessor.decorators);
            }
            self.blank(accessor.span);
            return None;
        }
        let storage = match key {
            Key::Identifier(name) | Key::Private(name) => format!("#{name}_accessor_storage"),
            Key::Literal(_) => format!("#_zb_accessor_storage_{}", accessor.span.start),
            Key::Computed(range) => {
                self.fail(
                    range.start,
                    "an `accessor` with a computed name isn't supported",
                    Some("give it a plain name, or write the private field, getter and setter"),
                );
                return None;
            }
        };
        let start = self.after_decorators(&accessor.decorators, accessor.span.start);
        let replaced = Range::new(start, accessor.key.span().end);
        let newlines = "\n".repeat(self.text(replaced).matches('\n').count());
        let static_ = if accessor.r#static { "static " } else { "" };
        self.replacements
            .push((replaced, format!("{static_}{storage}{newlines}")));
        if let Some(n) = n {
            self.initialized(accessor.value.as_ref().map(GetSpan::span), accessor.span, n);
        }
        let name = match key {
            Key::Identifier(name) => name.clone(),
            Key::Private(name) => format!("#{name}"),
            _ => self.text(accessor.key.span()).to_owned(),
        };
        let target = if accessor.r#static { class_ref } else { "this" };
        let (get, set) = match (n, key) {
            // A decorated private accessor: through the descriptor the decorators returned.
            (Some(n), Key::Private(_)) => (
                format!("get {name}() {{ return _zb_p{n}.get.call(this); }}"),
                format!("set {name}(value) {{ return _zb_p{n}.set.call(this, value); }}"),
            ),
            _ => (
                format!("get {name}() {{ return {target}.{storage}; }}"),
                format!("set {name}(value) {{ {target}.{storage} = value; }}"),
            ),
        };
        let mut after = String::new();
        if let Some(n) = n {
            after.push_str(&extra_initializers(accessor.r#static, n));
            after.push(' ');
        }
        after.push_str(&format!("{static_}{get} {static_}{set}"));
        self.after_element(accessor.span, &after);
        Some(storage)
    }

    /// A decorated `#private` method, getter or setter: its function is created where it is,
    /// in the computed name of a throwaway static field (`static [(_zb_p0 = { value: function
    /// () { … } }, _zb_drop)];`), and a getter reads what the decorators made of it.
    fn private_method(&mut self, method: &MethodDefinition<'_>, name: &str, n: usize, kind: Kind) {
        self.decorator_helpers.insert("setFunctionName");
        let start = self.after_decorators(&method.decorators, method.span.start);
        let replaced = Range::new(start, method.key.span().end);
        let newlines = "\n".repeat(self.text(replaced).matches('\n').count());
        let slot = match kind {
            Kind::Getter => "get",
            Kind::Setter => "set",
            _ => "value",
        };
        let function = format!(
            "{}function{}",
            if method.value.r#async { "async " } else { "" },
            if method.value.generator { "*" } else { "" },
        );
        self.replacements.push((
            replaced,
            format!("static [(_zb_p{n} = {{ {slot}: __zubraSetFunctionName({function} {newlines}"),
        ));
        let prefix = match kind {
            Kind::Getter => ", \"get\"",
            Kind::Setter => ", \"set\"",
            _ => "",
        };
        let static_ = if method.r#static { "static " } else { "" };
        let member = match kind {
            Kind::Getter => format!("get #{name}() {{ return _zb_p{n}.get.call(this); }}"),
            Kind::Setter => {
                format!("set #{name}(value) {{ return _zb_p{n}.set.call(this, value); }}")
            }
            _ => format!("get #{name}() {{ return _zb_p{n}.value; }}"),
        };
        self.insert_pieces(
            method.span.end,
            vec![Piece::Text(format!(
                ", \"#{name}\"{prefix}) }}, _zb_drop)]; {static_}{member}"
            ))],
        );
    }

    /// A member's decorators go from where they were: into the static block (`_zb_d0 = [a,
    /// b];`), or, for a computed name, into the name, so they're evaluated with it.
    fn member_decorators(
        &mut self,
        decorators: &[Decorator<'_>],
        key: &Key,
        n: usize,
        evaluated: &mut Vec<Piece>,
    ) {
        let copies = self.decorator_copies(decorators);
        match key {
            Key::Computed(range) => {
                self.decorator_helpers.insert("propKey");
                let mut before = vec![Piece::Text("(".to_owned())];
                before.extend(std::mem::take(evaluated));
                before.push(Piece::Text(format!("_zb_d{n} = [")));
                before.extend(copies);
                before.push(Piece::Text(format!("], _zb_k{n} = __zubraPropKey(")));
                self.insert_pieces(range.start, before);
                self.insert_pieces(range.end, vec![Piece::Text("))".to_owned())]);
            }
            _ => {
                // (`, `-separated, so they can go in a computed name; `;` in the static block.)
                evaluated.push(Piece::Text(format!("_zb_d{n} = [")));
                evaluated.extend(copies);
                evaluated.push(Piece::Text("], ".to_owned()));
            }
        }
    }

    /// The decorators' expressions, `a, b`, each taken out of where it was.
    fn decorator_copies(&mut self, decorators: &[Decorator<'_>]) -> Vec<Piece> {
        let mut pieces = Vec::new();
        for (index, decorator) in decorators.iter().enumerate() {
            if index > 0 {
                pieces.push(Piece::Text(", ".to_owned()));
            }
            pieces.push(Piece::Copy(decorator.expression.span()));
            self.remove(decorator.span);
        }
        pieces
    }

    /// A decorated field's value, through its initializers: `__zubraRunInitializers(this,
    /// _zb_i0, value)` (`void 0` when it has none).
    fn initialized(&mut self, value: Option<Range>, element: Range, n: usize) {
        match value {
            Some(value) => {
                self.insert_pieces(
                    value.start,
                    vec![Piece::Text(format!(
                        "__zubraRunInitializers(this, _zb_i{n}, "
                    ))],
                );
                self.insert_pieces(value.end, vec![Piece::Text(")".to_owned())]);
            }
            None => {
                let text = self.text(element);
                let trimmed = text.trim_end().trim_end_matches(';').trim_end();
                let at = element.start + u32::try_from(trimmed.len()).expect("fits");
                self.insert_pieces(
                    at,
                    vec![Piece::Text(format!(
                        " = __zubraRunInitializers(this, _zb_i{n}, void 0)"
                    ))],
                );
            }
        }
    }

    /// Code after a class element, on its last line (a `;` first, if it has none).
    fn after_element(&mut self, element: Range, code: &str) {
        let ends = self.text(element).trim_end().ends_with(';');
        let separator = if ends { " " } else { "; " };
        self.insert_pieces(element.end, vec![Piece::Text(format!("{separator}{code}"))]);
    }

    /// Where a member starts once its decorators are gone.
    fn after_decorators(&self, decorators: &[Decorator<'_>], start: u32) -> u32 {
        let from = decorators
            .last()
            .map_or(start, |decorator| decorator.span.end);
        let rest = &self.source[from as usize..];
        from + u32::try_from(rest.len() - rest.trim_start().len()).expect("fits")
    }

    /// The `class` keyword (after any decorators).
    fn class_keyword(&self, class: &Class<'_>) -> u32 {
        let from = class
            .decorators
            .last()
            .map_or(class.span.start, |decorator| decorator.span.end);
        let rest = &self.source[from as usize..class.body.span.start as usize];
        from + u32::try_from(rest.find("class").unwrap_or(0)).expect("fits")
    }

    fn not_here(&mut self, decorators: &[Decorator<'_>]) {
        let at = decorators
            .first()
            .map_or(0, |decorator| decorator.span.start);
        self.fail(
            at,
            "decorators aren't valid here (TS1206): only on a class and its implemented members",
            Some("take the decorator off this member"),
        );
    }
}
