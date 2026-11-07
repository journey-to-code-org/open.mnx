//! Server-side evaluation of the JavaScript that the build-time subset (`expression.rs`) leaves to
//! the browser: calls, template literals, arrow functions, and the deterministic built-ins.
//!
//! The rule: only what gives the same answer on every platform. So string, array and number
//! methods, `Math` without `random`, `Number()`/`String()`, `Object.keys()` and friends, and
//! arrow functions defined in the component's script. Never `Intl`, `Date`, `Math.random`,
//! `toLocaleString`, or anything that reaches the browser. Anything outside the subset is
//! [`Unsupported`], and the caller leaves that part for the browser, as before.

use std::rc::Rc;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, ArrowFunctionBody, BindingPattern, ChainElement, Expression,
    ObjectPropertyKind, Statement,
};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::operator::{BinaryOperator, LogicalOperator, UnaryOperator};
use serde_json::{Map, Value};

/// Outside the subset (or an error the browser should report): leave it for the browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsupported;

type Result<T> = std::result::Result<T, Unsupported>;

/// A value: JSON, `undefined`, or an arrow function.
#[derive(Clone, Debug)]
pub enum Val {
    Undefined,
    Json(Value),
    Function(Rc<Closure>),
}

/// An arrow function: its parameters, its body (an expression, as source), and the values of
/// the enclosing arrows' parameters it closes over.
#[derive(Debug)]
pub struct Closure {
    params: Vec<String>,
    /// A block body's `const`/`let` declarations, in order, before its `return`.
    locals: Vec<(String, String)>,
    body: String,
    captured: Vec<(String, Val)>,
}

impl Val {
    fn json(value: Value) -> Self {
        Val::Json(value)
    }
    /// The JSON value (`undefined` → null); a function has none.
    pub fn into_json(self) -> Result<Value> {
        match self {
            Val::Undefined => Ok(Value::Null),
            Val::Json(value) => Ok(value),
            Val::Function(_) => Err(Unsupported),
        }
    }
}

/// The arrow function in `source` (`(a, b) => …`), as a value; `None` if it isn't one.
pub fn function(source: &str) -> Option<Val> {
    let allocator = Allocator::default();
    let expression = Parser::new(&allocator, source, SourceType::mjs())
        .parse_expression()
        .ok()?;
    let mut evaluator = Evaluator {
        source,
        lookup: &|_| None,
        frames: Vec::new(),
        steps: 0,
    };
    match evaluator.eval(&expression) {
        Ok(value @ Val::Function(_)) => Some(value),
        _ => None,
    }
}

/// Evaluate `source` with free names from `lookup`.
pub fn evaluate(source: &str, lookup: &dyn Fn(&str) -> Option<Val>) -> Result<Val> {
    let allocator = Allocator::default();
    let expression = Parser::new(&allocator, source, SourceType::mjs())
        .parse_expression()
        .map_err(|_| Unsupported)?;
    let mut evaluator = Evaluator {
        source,
        lookup,
        frames: Vec::new(),
        steps: 0,
    };
    evaluator.eval(&expression)
}

/// Enough for a few thousand rows of list work; more than that belongs in the browser.
const STEP_LIMIT: usize = 1_000_000;
const DEPTH_LIMIT: usize = 64;

struct Evaluator<'a> {
    source: &'a str,
    lookup: &'a dyn Fn(&str) -> Option<Val>,
    /// Arrow parameters in scope, innermost last.
    frames: Vec<Vec<(String, Val)>>,
    steps: usize,
}

impl Evaluator<'_> {
    fn name(&self, name: &str) -> Result<Val> {
        for frame in self.frames.iter().rev() {
            if let Some((_, value)) = frame.iter().rev().find(|(local, _)| local == name) {
                return Ok(value.clone());
            }
        }
        if let Some(value) = (self.lookup)(name) {
            return Ok(value);
        }
        match name {
            "undefined" => Ok(Val::Undefined),
            _ => Err(Unsupported),
        }
    }

    fn eval(&mut self, expression: &Expression<'_>) -> Result<Val> {
        self.steps += 1;
        if self.steps > STEP_LIMIT || self.frames.len() > DEPTH_LIMIT {
            return Err(Unsupported);
        }
        match expression {
            Expression::BooleanLiteral(literal) => Ok(Val::json(Value::Bool(literal.value))),
            Expression::NullLiteral(_) => Ok(Val::json(Value::Null)),
            Expression::NumericLiteral(literal) => number(literal.value),
            Expression::StringLiteral(literal) => {
                Ok(string(literal.value.as_str().ok_or(Unsupported)?))
            }
            Expression::TemplateLiteral(template) => {
                let mut text = String::new();
                for (index, quasi) in template.quasis.iter().enumerate() {
                    text.push_str(
                        quasi
                            .value
                            .cooked
                            .as_ref()
                            .and_then(|cooked| cooked.as_str())
                            .ok_or(Unsupported)?,
                    );
                    if let Some(expression) = template.expressions.get(index) {
                        let value = self.eval(expression)?;
                        text.push_str(&js_string(&value)?);
                    }
                }
                Ok(string(&text))
            }
            Expression::Identifier(identifier) => self.name(identifier.name.as_str()),
            Expression::ParenthesizedExpression(inner) => self.eval(&inner.expression),
            Expression::ArrayExpression(array) => {
                let mut items = Vec::new();
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::SpreadElement(spread) => {
                            match self.eval(&spread.argument)? {
                                Val::Json(Value::Array(more)) => items.extend(more),
                                _ => return Err(Unsupported),
                            }
                        }
                        ArrayExpressionElement::Elision(_) => items.push(Value::Null),
                        element => items.push(
                            self.eval(element.as_expression().ok_or(Unsupported)?)?
                                .into_json()?,
                        ),
                    }
                }
                Ok(Val::json(Value::Array(items)))
            }
            Expression::ObjectExpression(object) => {
                let mut fields = Map::new();
                for property in &object.properties {
                    match property {
                        ObjectPropertyKind::ObjectProperty(property) => {
                            if property.method || property.computed {
                                return Err(Unsupported);
                            }
                            let key = property
                                .key
                                .static_name()
                                .ok_or(Unsupported)?
                                .as_str()
                                .ok_or(Unsupported)?
                                .to_owned();
                            let value = self.eval(&property.value)?;
                            if !matches!(value, Val::Undefined) {
                                fields.insert(key, value.into_json()?);
                            }
                        }
                        ObjectPropertyKind::SpreadProperty(spread) => {
                            match self.eval(&spread.argument)? {
                                Val::Json(Value::Object(more)) => fields.extend(more),
                                Val::Json(Value::Null) | Val::Undefined => {}
                                _ => return Err(Unsupported),
                            }
                        }
                    }
                }
                Ok(Val::json(Value::Object(fields)))
            }
            Expression::StaticMemberExpression(member) => {
                let object = self.eval(&member.object)?;
                if member.optional && is_nullish(&object) {
                    return Ok(Val::Undefined);
                }
                property(&object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let object = self.eval(&member.object)?;
                if member.optional && is_nullish(&object) {
                    return Ok(Val::Undefined);
                }
                let key = self.eval(&member.expression)?;
                index(&object, &key)
            }
            Expression::ChainExpression(chain) => {
                // `a?.b.c`: a nullish link short-circuits the rest of the chain.
                let result = match &chain.expression {
                    ChainElement::CallExpression(call) => self.call(call),
                    ChainElement::StaticMemberExpression(member) => {
                        let object = self.eval_chain(&member.object)?;
                        if is_nullish(&object) && member.optional {
                            return Ok(Val::Undefined);
                        }
                        property(&object, member.property.name.as_str())
                    }
                    ChainElement::ComputedMemberExpression(member) => {
                        let object = self.eval_chain(&member.object)?;
                        if is_nullish(&object) && member.optional {
                            return Ok(Val::Undefined);
                        }
                        let key = self.eval(&member.expression)?;
                        index(&object, &key)
                    }
                    _ => Err(Unsupported),
                };
                result
            }
            Expression::UnaryExpression(unary) => {
                let value = self.eval(&unary.argument)?;
                match unary.operator {
                    UnaryOperator::LogicalNot => Ok(Val::json(Value::Bool(!truthy(&value)))),
                    UnaryOperator::UnaryNegation => number(-to_number(&value)?),
                    UnaryOperator::UnaryPlus => number(to_number(&value)?),
                    UnaryOperator::Typeof => Ok(string(match &value {
                        Val::Undefined => "undefined",
                        Val::Function(_) => "function",
                        Val::Json(Value::Bool(_)) => "boolean",
                        Val::Json(Value::Number(_)) => "number",
                        Val::Json(Value::String(_)) => "string",
                        Val::Json(_) => "object",
                    })),
                    _ => Err(Unsupported),
                }
            }
            Expression::LogicalExpression(logical) => {
                let left = self.eval(&logical.left)?;
                let decided = match logical.operator {
                    LogicalOperator::And => !truthy(&left),
                    LogicalOperator::Or => truthy(&left),
                    LogicalOperator::Coalesce => !is_nullish(&left),
                };
                if decided {
                    Ok(left)
                } else {
                    self.eval(&logical.right)
                }
            }
            Expression::BinaryExpression(binary) => {
                let left = self.eval(&binary.left)?;
                let right = self.eval(&binary.right)?;
                binary_op(binary.operator, &left, &right)
            }
            Expression::ConditionalExpression(conditional) => {
                if truthy(&self.eval(&conditional.test)?) {
                    self.eval(&conditional.consequent)
                } else {
                    self.eval(&conditional.alternate)
                }
            }
            Expression::ArrowFunctionExpression(arrow) => {
                if arrow.r#async {
                    return Err(Unsupported);
                }
                let mut params = Vec::new();
                for param in &arrow.params.items {
                    if param.initializer.is_some() {
                        return Err(Unsupported);
                    }
                    params.push(simple_name(&param.pattern)?);
                }
                if arrow.params.rest.is_some() {
                    return Err(Unsupported);
                }
                // An expression body, or a block of `const`/`let` declarations and a `return`.
                let text = |span: oxc_span::Span| {
                    self.source[span.start as usize..span.end as usize].to_owned()
                };
                let mut locals = Vec::new();
                let body = match &arrow.body {
                    ArrowFunctionBody::FunctionBody(block) => {
                        let Some((Statement::ReturnStatement(last), rest)) =
                            block.statements.split_last()
                        else {
                            return Err(Unsupported);
                        };
                        if !block.directives.is_empty() {
                            return Err(Unsupported);
                        }
                        for statement in rest {
                            let Statement::VariableDeclaration(declaration) = statement else {
                                return Err(Unsupported);
                            };
                            if declaration.kind.is_var() || declaration.kind.is_using() {
                                return Err(Unsupported);
                            }
                            for declarator in &declaration.declarations {
                                let name = simple_name(&declarator.id)?;
                                let init = declarator.init.as_ref().ok_or(Unsupported)?;
                                locals.push((name, text(init.span())));
                            }
                        }
                        last.argument.as_ref().ok_or(Unsupported)?.span()
                    }
                    body => body.as_expression().ok_or(Unsupported)?.span(),
                };
                let captured = self.frames.iter().flatten().cloned().collect();
                Ok(Val::Function(Rc::new(Closure {
                    params,
                    locals,
                    body: text(body),
                    captured,
                })))
            }
            Expression::CallExpression(call) => self.call(call),
            _ => Err(Unsupported),
        }
    }

    /// Inside a chain. (`a?.b.c` with `a` nullish is undefined in JavaScript; here the `.c` of
    /// undefined is left for the browser, which gets it right.)
    fn eval_chain(&mut self, expression: &Expression<'_>) -> Result<Val> {
        self.eval(expression)
    }

    fn arguments(&mut self, arguments: &[Argument<'_>]) -> Result<Vec<Val>> {
        arguments
            .iter()
            .map(|argument| match argument {
                Argument::SpreadElement(_) => Err(Unsupported),
                argument => self.eval(argument.as_expression().ok_or(Unsupported)?),
            })
            .collect()
    }

    fn call(&mut self, call: &oxc_ast::ast::CallExpression<'_>) -> Result<Val> {
        match &call.callee {
            Expression::StaticMemberExpression(member) => {
                // Built-in namespaces: Math.round(…), Number.isInteger(…), Object.keys(…).
                if let Expression::Identifier(namespace) = &member.object {
                    let namespace = namespace.name.as_str();
                    if matches!(namespace, "Math" | "Number" | "Object" | "Array" | "String")
                        && self.name(namespace).is_err()
                    {
                        let arguments = self.arguments(&call.arguments)?;
                        return builtin(namespace, member.property.name.as_str(), &arguments);
                    }
                }
                let object = self.eval(&member.object)?;
                if (member.optional || call.optional) && is_nullish(&object) {
                    return Ok(Val::Undefined);
                }
                let arguments = self.arguments(&call.arguments)?;
                self.method(&object, member.property.name.as_str(), arguments)
            }
            Expression::Identifier(identifier) => {
                let name = identifier.name.as_str();
                match self.name(name) {
                    Ok(Val::Function(closure)) => {
                        let arguments = self.arguments(&call.arguments)?;
                        self.apply(&closure, arguments)
                    }
                    Ok(_) => Err(Unsupported),
                    Err(_) => {
                        let arguments = self.arguments(&call.arguments)?;
                        global(name, &arguments)
                    }
                }
            }
            callee => match self.eval(callee)? {
                Val::Function(closure) => {
                    let arguments = self.arguments(&call.arguments)?;
                    self.apply(&closure, arguments)
                }
                value if call.optional && is_nullish(&value) => Ok(Val::Undefined),
                _ => Err(Unsupported),
            },
        }
    }

    fn apply(&mut self, closure: &Closure, arguments: Vec<Val>) -> Result<Val> {
        let mut frame = closure.captured.clone();
        for (index, param) in closure.params.iter().enumerate() {
            frame.push((
                param.clone(),
                arguments.get(index).cloned().unwrap_or(Val::Undefined),
            ));
        }
        let saved = std::mem::replace(&mut self.frames, vec![frame]);
        let result = (|| {
            for (name, source) in &closure.locals {
                let value = self.eval_source(source)?;
                self.frames
                    .last_mut()
                    .expect("the call's frame")
                    .push((name.clone(), value));
            }
            self.eval_source(&closure.body)
        })();
        self.frames = saved;
        result
    }

    /// Evaluate a piece of source (a closure's body or one of its declarations) in the current
    /// frames. Its spans point into its own text.
    fn eval_source(&mut self, source: &str) -> Result<Val> {
        let allocator = Allocator::default();
        let expression = Parser::new(&allocator, source, SourceType::mjs())
            .parse_expression()
            .map_err(|_| Unsupported)?;
        let mut inner = Evaluator {
            source,
            lookup: self.lookup,
            frames: std::mem::take(&mut self.frames),
            steps: self.steps,
        };
        let result = inner.eval(&expression);
        self.frames = inner.frames;
        self.steps = inner.steps;
        result
    }

    /// Call `callback(item, index)` for an array method.
    fn each(&mut self, callback: &Val, item: &Value, position: usize) -> Result<Val> {
        let Val::Function(closure) = callback else {
            return Err(Unsupported);
        };
        self.apply(
            closure,
            vec![Val::json(item.clone()), Val::json(Value::from(position))],
        )
    }

    fn method(&mut self, object: &Val, name: &str, arguments: Vec<Val>) -> Result<Val> {
        let arg = |index: usize| arguments.get(index).cloned().unwrap_or(Val::Undefined);
        match object {
            Val::Json(Value::Array(items)) => match name {
                "includes" => Ok(bool(
                    items.iter().any(|item| same_value_zero(item, &arg(0))),
                )),
                "indexOf" => Ok(int(items
                    .iter()
                    .position(|item| strict_equal_json(item, &arg(0)))
                    .map_or(-1, |at| at as i64))),
                "lastIndexOf" => Ok(int(items
                    .iter()
                    .rposition(|item| strict_equal_json(item, &arg(0)))
                    .map_or(-1, |at| at as i64))),
                "join" => {
                    let separator = match arg(0) {
                        Val::Undefined => ",".to_owned(),
                        value => js_string(&value)?,
                    };
                    let parts: Result<Vec<String>> = items
                        .iter()
                        .map(|item| {
                            if item.is_null() {
                                Ok(String::new())
                            } else {
                                js_string(&Val::json(item.clone()))
                            }
                        })
                        .collect();
                    Ok(string(&parts?.join(&separator)))
                }
                "slice" => {
                    let (start, end) = range(items.len(), &arg(0), &arg(1))?;
                    Ok(Val::json(Value::Array(
                        items[start..end.max(start)].to_vec(),
                    )))
                }
                "at" => {
                    let at = relative(items.len(), to_integer(&arg(0))?);
                    Ok(at
                        .and_then(|at| items.get(at))
                        .cloned()
                        .map_or(Val::Undefined, Val::json))
                }
                "concat" => {
                    let mut out = items.clone();
                    for value in &arguments {
                        match value {
                            Val::Json(Value::Array(more)) => out.extend(more.iter().cloned()),
                            value => out.push(value.clone().into_json()?),
                        }
                    }
                    Ok(Val::json(Value::Array(out)))
                }
                "toReversed" => Ok(Val::json(Value::Array(
                    items.iter().rev().cloned().collect(),
                ))),
                "map" => {
                    let callback = arg(0);
                    let mut out = Vec::with_capacity(items.len());
                    for (position, item) in items.iter().enumerate() {
                        out.push(self.each(&callback, item, position)?.into_json()?);
                    }
                    Ok(Val::json(Value::Array(out)))
                }
                "filter" | "some" | "every" | "find" | "findIndex" => {
                    let callback = arg(0);
                    let mut kept = Vec::new();
                    for (position, item) in items.iter().enumerate() {
                        let pass = truthy(&self.each(&callback, item, position)?);
                        match name {
                            "some" if pass => return Ok(bool(true)),
                            "every" if !pass => return Ok(bool(false)),
                            "find" if pass => return Ok(Val::json(item.clone())),
                            "findIndex" if pass => return Ok(int(position as i64)),
                            "filter" if pass => kept.push(item.clone()),
                            _ => {}
                        }
                    }
                    Ok(match name {
                        "some" => bool(false),
                        "every" => bool(true),
                        "find" => Val::Undefined,
                        "findIndex" => int(-1),
                        _ => Val::json(Value::Array(kept)),
                    })
                }
                "reduce" => {
                    let Val::Function(closure) = arg(0) else {
                        return Err(Unsupported);
                    };
                    let mut entries = items.iter().enumerate();
                    let mut total = match arguments.get(1) {
                        Some(initial) => initial.clone(),
                        None => Val::json(entries.next().ok_or(Unsupported)?.1.clone()),
                    };
                    for (position, item) in entries {
                        total = self.apply(
                            &closure,
                            vec![
                                total,
                                Val::json(item.clone()),
                                Val::json(Value::from(position)),
                            ],
                        )?;
                    }
                    Ok(total)
                }
                "toSorted" => {
                    let mut sorted = items.clone();
                    match arg(0) {
                        // Without a comparator, JavaScript compares the items as strings.
                        Val::Undefined => {
                            let mut keyed: Vec<(String, Value)> = sorted
                                .into_iter()
                                .map(|item| Ok((js_string(&Val::json(item.clone()))?, item)))
                                .collect::<Result<_>>()?;
                            keyed.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
                            sorted = keyed.into_iter().map(|(_, item)| item).collect();
                        }
                        Val::Function(closure) => {
                            // A stable merge sort through the comparator.
                            let mut failed = false;
                            let mut compare = |a: &Value, b: &Value| -> std::cmp::Ordering {
                                if failed {
                                    return std::cmp::Ordering::Equal;
                                }
                                match self
                                    .apply(
                                        &closure,
                                        vec![Val::json(a.clone()), Val::json(b.clone())],
                                    )
                                    .and_then(|value| to_number(&value))
                                {
                                    Ok(order) if order < 0.0 => std::cmp::Ordering::Less,
                                    Ok(order) if order > 0.0 => std::cmp::Ordering::Greater,
                                    Ok(_) => std::cmp::Ordering::Equal,
                                    Err(_) => {
                                        failed = true;
                                        std::cmp::Ordering::Equal
                                    }
                                }
                            };
                            sorted.sort_by(|a, b| compare(a, b));
                            if failed {
                                return Err(Unsupported);
                            }
                        }
                        _ => return Err(Unsupported),
                    }
                    Ok(Val::json(Value::Array(sorted)))
                }
                _ => Err(Unsupported),
            },
            Val::Json(Value::String(text)) => {
                let units: Vec<u16> = text.encode_utf16().collect();
                let from_units = |units: &[u16]| string(&String::from_utf16_lossy(units));
                match name {
                    "includes" => Ok(bool(text.contains(js_string(&arg(0))?.as_str()))),
                    "startsWith" => Ok(bool(text.starts_with(js_string(&arg(0))?.as_str()))),
                    "endsWith" => Ok(bool(text.ends_with(js_string(&arg(0))?.as_str()))),
                    "indexOf" => {
                        let needle: Vec<u16> = js_string(&arg(0))?.encode_utf16().collect();
                        Ok(int(find_units(&units, &needle).map_or(-1, |at| at as i64)))
                    }
                    "slice" => {
                        let (start, end) = range(units.len(), &arg(0), &arg(1))?;
                        Ok(from_units(&units[start..end.max(start)]))
                    }
                    "substring" => {
                        let clamp = |value: &Val, default: usize| -> Result<usize> {
                            Ok(match value {
                                Val::Undefined => default,
                                value => to_integer(value)?.clamp(0, units.len() as i64) as usize,
                            })
                        };
                        let (a, b) = (clamp(&arg(0), 0)?, clamp(&arg(1), units.len())?);
                        Ok(from_units(&units[a.min(b)..a.max(b)]))
                    }
                    "at" | "charAt" => {
                        let at = if name == "at" {
                            relative(units.len(), to_integer(&arg(0))?)
                        } else {
                            usize::try_from(to_integer(&arg(0))?).ok()
                        };
                        match at.filter(|at| *at < units.len()) {
                            Some(at) => Ok(from_units(&units[at..=at])),
                            None if name == "at" => Ok(Val::Undefined),
                            None => Ok(string("")),
                        }
                    }
                    "trim" => Ok(string(text.trim_matches(is_js_space))),
                    "trimStart" => Ok(string(text.trim_start_matches(is_js_space))),
                    "trimEnd" => Ok(string(text.trim_end_matches(is_js_space))),
                    // Only the locale-free mappings that every engine agrees on (ASCII).
                    "toUpperCase" if text.is_ascii() => Ok(string(&text.to_ascii_uppercase())),
                    "toLowerCase" if text.is_ascii() => Ok(string(&text.to_ascii_lowercase())),
                    "padStart" | "padEnd" => {
                        let length = to_integer(&arg(0))?.max(0) as usize;
                        let fill: Vec<u16> = match arg(1) {
                            Val::Undefined => vec![b' ' as u16],
                            value => js_string(&value)?.encode_utf16().collect(),
                        };
                        if units.len() >= length || fill.is_empty() {
                            return Ok(Val::json(Value::String(text.clone())));
                        }
                        let padding: Vec<u16> = fill
                            .iter()
                            .cycle()
                            .take(length - units.len())
                            .copied()
                            .collect();
                        let joined: Vec<u16> = if name == "padStart" {
                            [padding, units].concat()
                        } else {
                            [units, padding].concat()
                        };
                        Ok(from_units(&joined))
                    }
                    "repeat" => {
                        let count = to_integer(&arg(0))?;
                        if !(0..=10_000).contains(&count) {
                            return Err(Unsupported);
                        }
                        Ok(string(&text.repeat(count as usize)))
                    }
                    "split" => match arg(0) {
                        Val::Json(Value::String(separator)) if !separator.is_empty() => {
                            Ok(Val::json(Value::Array(
                                text.split(separator.as_str())
                                    .map(|part| Value::String(part.to_owned()))
                                    .collect(),
                            )))
                        }
                        _ => Err(Unsupported),
                    },
                    "replaceAll" | "replace" => match (arg(0), arg(1)) {
                        (Val::Json(Value::String(from)), Val::Json(Value::String(to)))
                            if !from.is_empty() && !to.contains('$') =>
                        {
                            Ok(string(&if name == "replace" {
                                text.replacen(from.as_str(), &to, 1)
                            } else {
                                text.replace(from.as_str(), &to)
                            }))
                        }
                        _ => Err(Unsupported),
                    },
                    "toString" => Ok(Val::json(Value::String(text.clone()))),
                    _ => Err(Unsupported),
                }
            }
            Val::Json(Value::Number(value)) => {
                let value = value.as_f64().ok_or(Unsupported)?;
                match name {
                    "toFixed" => {
                        let digits = match arg(0) {
                            Val::Undefined => 0,
                            value => to_integer(&value)?,
                        };
                        if !(0..=100).contains(&digits) {
                            return Err(Unsupported);
                        }
                        Ok(string(&to_fixed(value, digits as usize)))
                    }
                    "toString" if matches!(arg(0), Val::Undefined) => {
                        Ok(string(&format_number(value)))
                    }
                    _ => Err(Unsupported),
                }
            }
            Val::Function(closure) if name == "call" => {
                // `fn.call(thisArg, …)`: arrows ignore `this`.
                let closure = closure.clone();
                self.apply(&closure, arguments.into_iter().skip(1).collect())
            }
            _ => Err(Unsupported),
        }
    }
}

fn simple_name(pattern: &BindingPattern<'_>) -> Result<String> {
    pattern
        .get_binding_identifier()
        .map(|identifier| identifier.name.to_string())
        .ok_or(Unsupported)
}

// ---- built-ins ------------------------------------------------------------------------------

fn builtin(namespace: &str, name: &str, arguments: &[Val]) -> Result<Val> {
    let numbers = || {
        arguments
            .iter()
            .map(to_number)
            .collect::<Result<Vec<f64>>>()
    };
    let first = || to_number(arguments.first().unwrap_or(&Val::Undefined));
    match (namespace, name) {
        ("Math", "min") if !arguments.is_empty() => {
            number(numbers()?.into_iter().fold(f64::INFINITY, |a, b| {
                if a.is_nan() || b.is_nan() {
                    f64::NAN
                } else {
                    a.min(b)
                }
            }))
        }
        ("Math", "max") if !arguments.is_empty() => {
            number(numbers()?.into_iter().fold(f64::NEG_INFINITY, |a, b| {
                if a.is_nan() || b.is_nan() {
                    f64::NAN
                } else {
                    a.max(b)
                }
            }))
        }
        // JavaScript rounds halves up (toward +∞): Math.round(-2.5) is -2.
        ("Math", "round") => number(js_round(first()?)),
        ("Math", "floor") => number(first()?.floor()),
        ("Math", "ceil") => number(first()?.ceil()),
        ("Math", "trunc") => number(first()?.trunc()),
        ("Math", "abs") => number(first()?.abs()),
        ("Math", "sign") => {
            let value = first()?;
            number(if value > 0.0 {
                1.0
            } else if value < 0.0 {
                -1.0
            } else {
                value
            })
        }
        // Exact in IEEE 754 everywhere (unlike pow, exp, sin…, whose results may differ).
        ("Math", "sqrt") => number(first()?.sqrt()),
        ("Number", "isInteger") => Ok(bool(
            matches!(arguments.first(), Some(Val::Json(Value::Number(n))) if n.as_f64().is_some_and(|n| n.fract() == 0.0)),
        )),
        ("Number", "isFinite") => Ok(bool(matches!(
            arguments.first(),
            Some(Val::Json(Value::Number(_)))
        ))),
        ("Array", "isArray") => Ok(bool(matches!(
            arguments.first(),
            Some(Val::Json(Value::Array(_)))
        ))),
        ("Object", "keys" | "values" | "entries") => match arguments.first() {
            Some(Val::Json(Value::Object(fields))) => Ok(Val::json(Value::Array(
                fields
                    .iter()
                    .map(|(key, value)| match name {
                        "keys" => Value::String(key.clone()),
                        "values" => value.clone(),
                        _ => Value::Array(vec![Value::String(key.clone()), value.clone()]),
                    })
                    .collect(),
            ))),
            _ => Err(Unsupported),
        },
        _ => Err(Unsupported),
    }
}

fn global(name: &str, arguments: &[Val]) -> Result<Val> {
    let first = arguments.first().cloned().unwrap_or(Val::Undefined);
    match name {
        "Number" => number(if arguments.is_empty() {
            0.0
        } else {
            to_number(&first)?
        }),
        "String" => Ok(string(&if arguments.is_empty() {
            String::new()
        } else {
            js_string(&first)?
        })),
        "Boolean" => Ok(bool(truthy(&first))),
        "parseInt" if arguments.len() == 1 => {
            let text = js_string(&first)?;
            let text = text.trim_start_matches(is_js_space);
            let (sign, digits) = match text.strip_prefix('-') {
                Some(rest) => (-1.0, rest),
                None => (1.0, text.strip_prefix('+').unwrap_or(text)),
            };
            let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
            if digits.is_empty() || digits.len() > 15 {
                return Err(Unsupported);
            }
            number(sign * digits.parse::<f64>().map_err(|_| Unsupported)?)
        }
        _ => Err(Unsupported),
    }
}

// ---- values ---------------------------------------------------------------------------------

fn number(value: f64) -> Result<Val> {
    // JSON holds finite numbers only; NaN and ±Infinity stay in the browser.
    if !value.is_finite() {
        return Err(Unsupported);
    }
    let value = if value == 0.0 { 0.0 } else { value }; // -0 prints as 0 anyway
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Ok(Val::json(Value::from(value as i64)))
    } else {
        Ok(Val::json(
            serde_json::Number::from_f64(value)
                .map(Value::Number)
                .ok_or(Unsupported)?,
        ))
    }
}

fn string(text: &str) -> Val {
    Val::json(Value::String(text.to_owned()))
}

fn bool(value: bool) -> Val {
    Val::json(Value::Bool(value))
}

fn int(value: i64) -> Val {
    Val::json(Value::from(value))
}

fn is_nullish(value: &Val) -> bool {
    matches!(value, Val::Undefined | Val::Json(Value::Null))
}

pub fn truthy(value: &Val) -> bool {
    match value {
        Val::Undefined => false,
        Val::Function(_) => true,
        Val::Json(value) => crate::expression::is_truthy(value),
    }
}

fn to_number(value: &Val) -> Result<f64> {
    match value {
        Val::Json(Value::Number(n)) => n.as_f64().ok_or(Unsupported),
        Val::Json(Value::Bool(b)) => Ok(if *b { 1.0 } else { 0.0 }),
        Val::Json(Value::Null) => Ok(0.0),
        Val::Json(Value::String(text)) => {
            let text = text.trim_matches(is_js_space);
            if text.is_empty() {
                return Ok(0.0);
            }
            // Decimal only (no hex, no Infinity); anything else would be NaN.
            if text.bytes().all(|byte| {
                byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'+' | b'e' | b'E')
            }) {
                text.parse::<f64>().map_err(|_| Unsupported)
            } else {
                Err(Unsupported)
            }
        }
        _ => Err(Unsupported),
    }
}

fn to_integer(value: &Val) -> Result<i64> {
    match value {
        Val::Undefined => Ok(0),
        value => Ok(to_number(value)?.trunc() as i64),
    }
}

/// JavaScript's `String(value)`, for what has a fixed spelling.
fn js_string(value: &Val) -> Result<String> {
    match value {
        Val::Undefined => Ok("undefined".to_owned()),
        Val::Json(Value::Null) => Ok("null".to_owned()),
        Val::Json(Value::Bool(b)) => Ok(b.to_string()),
        Val::Json(Value::Number(n)) => Ok(format_number(n.as_f64().ok_or(Unsupported)?)),
        Val::Json(Value::String(text)) => Ok(text.clone()),
        Val::Json(Value::Array(items)) => {
            let parts: Result<Vec<String>> = items
                .iter()
                .map(|item| {
                    if item.is_null() {
                        Ok(String::new())
                    } else {
                        js_string(&Val::json(item.clone()))
                    }
                })
                .collect();
            Ok(parts?.join(","))
        }
        _ => Err(Unsupported),
    }
}

/// `Number.prototype.toString()` for finite numbers: the shortest round-trip digits, in plain
/// notation between 1e-7 and 1e21 (and exponent notation outside, which we leave alone).
pub fn format_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if !(1e-7..1e21).contains(&magnitude) {
        // Exponent notation: rare in templates; keep Rust's spelling close to JavaScript's.
        let text = format!("{value:e}");
        let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
        let exponent = if exponent.starts_with('-') {
            exponent.to_owned()
        } else {
            format!("+{exponent}")
        };
        return format!("{mantissa}e{exponent}");
    }
    let text = value.to_string(); // Rust prints the shortest round-trip digits, like JavaScript
    text.strip_suffix(".0").map_or(text.clone(), str::to_owned)
}

/// `Number.prototype.toFixed(digits)`: the exact decimal value rounded half away from zero
/// (the spec picks the larger n on a tie, on the magnitude).
fn to_fixed(value: f64, digits: usize) -> String {
    if value.abs() >= 1e21 {
        return format_number(value);
    }
    // Every double's exact decimal expansion fits in 1100 fractional digits.
    let exact = format!("{:.1100}", value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits_vec: Vec<u8> = whole
        .bytes()
        .chain(fraction.bytes().take(digits))
        .map(|byte| byte - b'0')
        .collect();
    let rest = &fraction.as_bytes()[digits.min(fraction.len())..];
    if rest.first().is_some_and(|digit| *digit >= b'5') {
        // Round up (a tie, exactly ...5000, rounds up too).
        let mut at = digits_vec.len();
        loop {
            if at == 0 {
                digits_vec.insert(0, 1);
                break;
            }
            at -= 1;
            if digits_vec[at] == 9 {
                digits_vec[at] = 0;
            } else {
                digits_vec[at] += 1;
                break;
            }
        }
    }
    let text: String = digits_vec
        .iter()
        .map(|digit| char::from(b'0' + digit))
        .collect();
    let split = text.len() - digits;
    let mut out = String::new();
    let negative = value < 0.0 && text.bytes().any(|byte| byte != b'0');
    if negative || (value.is_sign_negative() && value != 0.0) {
        out.push('-');
    }
    out.push_str(&text[..split]);
    if digits > 0 {
        out.push('.');
        out.push_str(&text[split..]);
    }
    out
}

fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

fn is_js_space(character: char) -> bool {
    character.is_whitespace() || character == '\u{FEFF}'
}

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn find_units(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Array/string `slice(start, end)` bounds.
fn range(length: usize, start: &Val, end: &Val) -> Result<(usize, usize)> {
    let bound = |value: &Val, default: usize| -> Result<usize> {
        Ok(match value {
            Val::Undefined => default,
            value => {
                let at = to_integer(value)?;
                if at < 0 {
                    (length as i64 + at).max(0) as usize
                } else {
                    (at as usize).min(length)
                }
            }
        })
    };
    Ok((bound(start, 0)?, bound(end, length)?))
}

fn relative(length: usize, at: i64) -> Option<usize> {
    let at = if at < 0 { length as i64 + at } else { at };
    usize::try_from(at).ok().filter(|at| *at < length)
}

fn property(object: &Val, name: &str) -> Result<Val> {
    match object {
        Val::Json(Value::Object(fields)) => {
            Ok(fields.get(name).cloned().map_or(Val::Undefined, Val::json))
        }
        Val::Json(Value::Array(items)) if name == "length" => Ok(int(items.len() as i64)),
        Val::Json(Value::String(text)) if name == "length" => {
            Ok(int(text.encode_utf16().count() as i64))
        }
        // Reading a property of null or undefined is a TypeError: the browser reports it.
        _ => Err(Unsupported),
    }
}

fn index(object: &Val, key: &Val) -> Result<Val> {
    match (object, key) {
        (Val::Json(Value::Array(items)), Val::Json(Value::Number(n))) => {
            let at = n.as_f64().ok_or(Unsupported)?;
            if at.fract() != 0.0 || at < 0.0 {
                return Ok(Val::Undefined);
            }
            Ok(items
                .get(at as usize)
                .cloned()
                .map_or(Val::Undefined, Val::json))
        }
        (Val::Json(Value::String(text)), Val::Json(Value::Number(n))) => {
            let at = n.as_f64().ok_or(Unsupported)?;
            let units: Vec<u16> = text.encode_utf16().collect();
            if at.fract() != 0.0 || at < 0.0 || at as usize >= units.len() {
                return Ok(Val::Undefined);
            }
            Ok(string(&String::from_utf16_lossy(
                &units[at as usize..=at as usize],
            )))
        }
        (object, key) => property(object, &js_string(key)?),
    }
}

fn strict_equal_json(a: &Value, b: &Val) -> bool {
    match b {
        Val::Json(b) => match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Array(_) | Value::Object(_), _) => false, // identity: never equal to a copy
            _ => a == b,
        },
        _ => false,
    }
}

fn same_value_zero(a: &Value, b: &Val) -> bool {
    strict_equal_json(a, b)
}

fn strict_equal(left: &Val, right: &Val) -> Result<bool> {
    Ok(match (left, right) {
        (Val::Undefined, Val::Undefined) => true,
        (Val::Undefined, _) | (_, Val::Undefined) => false,
        (Val::Json(a), b @ Val::Json(_)) => {
            if matches!(a, Value::Array(_) | Value::Object(_))
                && matches!(b, Val::Json(Value::Array(_) | Value::Object(_)))
            {
                // Two references: equal only if they're the same object, which we can't tell.
                return Err(Unsupported);
            }
            strict_equal_json(a, b)
        }
        _ => return Err(Unsupported),
    })
}

fn loose_equal(left: &Val, right: &Val) -> Result<bool> {
    if is_nullish(left) || is_nullish(right) {
        return Ok(is_nullish(left) && is_nullish(right));
    }
    match (left, right) {
        (Val::Json(a), Val::Json(b)) if std::mem::discriminant(a) == std::mem::discriminant(b) => {
            strict_equal(left, right)
        }
        (
            Val::Json(Value::Number(_) | Value::String(_) | Value::Bool(_)),
            Val::Json(Value::Number(_) | Value::String(_) | Value::Bool(_)),
        ) => Ok(to_number(left)? == to_number(right)?),
        _ => Err(Unsupported),
    }
}

fn binary_op(operator: BinaryOperator, left: &Val, right: &Val) -> Result<Val> {
    use BinaryOperator as Op;
    let numbers = || Ok::<_, Unsupported>((to_number(left)?, to_number(right)?));
    match operator {
        Op::StrictEquality => Ok(bool(strict_equal(left, right)?)),
        Op::StrictInequality => Ok(bool(!strict_equal(left, right)?)),
        Op::Equality => Ok(bool(loose_equal(left, right)?)),
        Op::Inequality => Ok(bool(!loose_equal(left, right)?)),
        Op::Addition => match (left, right) {
            (Val::Json(Value::String(_)), _) | (_, Val::Json(Value::String(_))) => {
                if matches!(left, Val::Json(Value::Object(_)))
                    || matches!(right, Val::Json(Value::Object(_)))
                {
                    return Err(Unsupported); // "[object Object]": almost certainly a mistake
                }
                Ok(string(&(js_string(left)? + &js_string(right)?)))
            }
            (
                Val::Json(Value::Number(_) | Value::Bool(_) | Value::Null),
                Val::Json(Value::Number(_) | Value::Bool(_) | Value::Null),
            ) => {
                let (a, b) = numbers()?;
                number(a + b)
            }
            _ => Err(Unsupported),
        },
        Op::Subtraction => numbers().and_then(|(a, b)| number(a - b)),
        Op::Multiplication => numbers().and_then(|(a, b)| number(a * b)),
        Op::Division => numbers().and_then(|(a, b)| number(a / b)),
        Op::Remainder => numbers().and_then(|(a, b)| number(a % b)),
        // Only where the result is exact (integers within 2^53): pow() itself may differ
        // between engines in the last bit.
        Op::Exponential => {
            let (base, exponent) = numbers()?;
            if base.fract() != 0.0 || exponent.fract() != 0.0 || !(0.0..=1074.0).contains(&exponent)
            {
                return Err(Unsupported);
            }
            let result = base.powi(exponent as i32);
            if result.abs() > 9_007_199_254_740_992.0 {
                return Err(Unsupported);
            }
            number(result)
        }
        Op::LessThan | Op::LessEqualThan | Op::GreaterThan | Op::GreaterEqualThan => {
            let ordering = match (left, right) {
                (Val::Json(Value::String(a)), Val::Json(Value::String(b))) => utf16_cmp(a, b),
                _ => {
                    let (a, b) = numbers()?;
                    a.partial_cmp(&b).ok_or(Unsupported)?
                }
            };
            Ok(bool(match operator {
                Op::LessThan => ordering.is_lt(),
                Op::LessEqualThan => ordering.is_le(),
                Op::GreaterThan => ordering.is_gt(),
                _ => ordering.is_ge(),
            }))
        }
        _ => Err(Unsupported),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(source: &str) -> Option<Value> {
        let lookup = |name: &str| match name {
            "rows" => Some(Val::json(
                serde_json::json!([{ "label": "a", "kg": 2.5 }, { "label": "b", "kg": 4 }]),
            )),
            "value" => Some(Val::json(serde_json::json!(["kale"]))),
            "money" => function("(cents) => \"$\" + (cents / 100).toFixed(2)"),
            "name" => Some(Val::json(Value::String("Ada".into()))),
            _ => None,
        };
        evaluate(source, &lookup)
            .ok()
            .map(|value| value.into_json().unwrap())
    }

    #[test]
    fn the_subset() {
        assert_eq!(run("value.includes('kale')"), Some(true.into()));
        assert_eq!(run("`Hi ${name}!`"), Some("Hi Ada!".into()));
        assert_eq!(
            run("Math.max(...[1])"),
            None,
            "spread arguments stay in the browser"
        );
        assert_eq!(run("Math.max(1, 3, 2)"), Some(3.into()));
        assert_eq!(
            run("rows.map((row) => row.kg * 2)"),
            Some(serde_json::json!([5, 8]))
        );
        assert_eq!(
            run("rows.reduce((sum, row) => sum + row.kg, 0)"),
            Some(serde_json::json!(6.5))
        );
        assert_eq!(
            run("rows.filter((row) => row.kg > 3).map((row) => row.label).join()"),
            Some("b".into())
        );
        assert_eq!(run("money(129900)"), Some("$1299.00".into()));
        assert_eq!(
            run("(2.5).toFixed(0)"),
            Some("3".into()),
            "JavaScript rounds a tie up"
        );
        assert_eq!(
            run("(1.005).toFixed(2)"),
            Some("1.00".into()),
            "1.005 is really 1.00499…"
        );
        assert_eq!(run("(-1.5).toFixed(0)"), Some("-2".into()));
        assert_eq!(run("Math.round(-2.5)"), Some((-2).into()));
        assert_eq!(run("String(7).padStart(3, '0')"), Some("007".into()));
        assert_eq!(
            run("0.1 + 0.2"),
            Some(serde_json::json!(0.30000000000000004))
        );
        assert_eq!(run("Math.random()"), None);
        assert_eq!(run("new Date()"), None);
        assert_eq!(run("Intl.NumberFormat"), None);
        assert_eq!(run("1 / 0"), None, "Infinity isn't JSON");
        assert_eq!(run("unknownThing.x"), None);
    }
}
