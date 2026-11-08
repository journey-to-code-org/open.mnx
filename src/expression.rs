//! The `{ … }` expression language: a strict subset of JavaScript expressions.
//!
//! Three things have to agree about every expression — this parser, the build-time evaluator
//! below, and the browser that will eventually run the same text as real JavaScript. So the
//! grammar admits only constructs whose meaning is identical in both places, and
//! [`Expression::evaluate`] follows JavaScript semantics (truthiness, `+` concatenation,
//! short-circuiting) rather than inventing its own. Anything outside the subset — calls,
//! assignment, `new`, `this`, template substitutions — is a parse error with a reason.
//!
//! Grammar (recursive descent, one function per precedence level):
//!
//! ```text
//! expression     → conditional
//! conditional    → nullish ( "?" expression ":" expression )?
//! nullish        → or ( "??" or )*
//! or             → and ( "||" and )*
//! and            → equality ( "&&" equality )*
//! equality       → comparison ( ( "===" | "!==" | "==" | "!=" ) comparison )*
//! comparison     → additive ( ( "<=" | ">=" | "<" | ">" ) additive )*
//! additive       → multiplicative ( ( "+" | "-" ) multiplicative )*
//! multiplicative → unary ( ( "*" | "/" | "%" ) unary )*
//! unary          → ( "!" | "-" ) unary | postfix
//! postfix        → primary ( "." IDENT | "?." IDENT | "[" expression "]" | "?.[" expression "]" )*
//! primary        → NUMBER | STRING | "true" | "false" | "null" | "undefined" | IDENT
//!                | "(" expression ")" | "[" elements? "]" | "{" properties? "}"
//! property       → ( IDENT | STRING ) ":" expression | IDENT        (shorthand)
//! ```
//!
//! `==` and `!=` are accepted for familiarity but mean strict equality; loose coercion is the
//! one JavaScript behavior deliberately not reproduced.

use std::fmt;

use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Expression {
    Identifier(String),
    String(String),
    /// Kept as source text so it re-prints exactly; parsed on evaluation.
    Number(String),
    Boolean(bool),
    Null,
    Array(Vec<Expression>),
    Object(Vec<(String, Expression)>),
    Unary {
        operator: UnaryOperator,
        operand: Box<Expression>,
    },
    Binary {
        operator: BinaryOperator,
        left: Box<Expression>,
        right: Box<Expression>,
    },
    Logical {
        operator: LogicalOperator,
        left: Box<Expression>,
        right: Box<Expression>,
    },
    Conditional {
        test: Box<Expression>,
        consequent: Box<Expression>,
        alternate: Box<Expression>,
    },
    Member {
        object: Box<Expression>,
        property: String,
        optional: bool,
    },
    Index {
        object: Box<Expression>,
        index: Box<Expression>,
        optional: bool,
    },
    /// Any other JavaScript expression (calls, functions, …): it runs in the browser only.
    Runtime {
        source: String,
        names: Vec<crate::runtime_expression::Name>,
    },
}

impl Expression {
    /// Whether this is JavaScript beyond the build-time subset (see [`Expression::Runtime`]).
    pub fn is_runtime(&self) -> bool {
        matches!(self, Self::Runtime { .. })
    }

    /// Free identifiers this expression assigns to (only runtime expressions can).
    pub fn written_names(&self) -> Vec<&str> {
        match self {
            Self::Runtime { names, .. } => names
                .iter()
                .filter(|name| name.written)
                .map(|name| name.name.as_str())
                .collect(),
            _ => Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnaryOperator {
    Not,
    Negate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BinaryOperator {
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    Add,
    Subtract,
    Multiply,
    Divide,
    Remainder,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogicalOperator {
    And,
    Or,
    Nullish,
}

/// A parse failure, located as a byte offset into the expression source so the caller can
/// turn it into a file position.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParseError {
    pub offset: usize,
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

/// Parse a complete expression; trailing non-whitespace is an error.
pub fn parse(source: &str) -> Result<Expression, ParseError> {
    let (expression, end) = parse_prefix(source)?;
    if end != source.len() {
        return Err(ParseError {
            offset: end,
            message: "unexpected characters after expression".to_owned(),
        });
    }
    Ok(expression)
}

/// Parse the longest expression at the start of `source`, returning it and the byte offset
/// just past it (after trailing whitespace). The `<script>` parser uses this to read an
/// initializer without knowing in advance where the statement ends.
pub fn parse_prefix(source: &str) -> Result<(Expression, usize), ParseError> {
    let mut parser = Parser {
        source,
        position: 0,
    };
    let expression = parser.parse_conditional()?;
    parser.skip_whitespace();
    Ok((expression, parser.position))
}

/// Why a runtime expression can't be evaluated at build time.
pub const RUNTIME_ONLY: &str = "this expression runs in the browser only (it uses something outside what the server can evaluate, such as a `function` declaration, `new`, `Date` or `Intl`), so it can't be rendered into static HTML";

// ---- evaluation ----------------------------------------------------------------------------

impl Expression {
    /// Evaluate at build time against a lookup for free identifiers (props, script locals,
    /// loop variables). Errors are plain messages; the caller attaches the file position.
    pub fn evaluate(&self, lookup: &dyn Fn(&str) -> Option<Value>) -> Result<Value, String> {
        match self {
            Self::Identifier(name) => {
                lookup(name).ok_or_else(|| format!("unknown reference `{name}`"))
            }
            Self::Runtime { .. } => Err(RUNTIME_ONLY.to_owned()),
            Self::String(value) => Ok(Value::String(value.clone())),
            Self::Number(text) => {
                serde_json::from_str(text).map_err(|_| format!("invalid number literal `{text}`"))
            }
            Self::Boolean(value) => Ok(Value::Bool(*value)),
            Self::Null => Ok(Value::Null),
            Self::Array(elements) => elements
                .iter()
                .map(|element| element.evaluate(lookup))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array),
            Self::Object(properties) => {
                let mut object = serde_json::Map::new();
                for (key, value) in properties {
                    object.insert(key.clone(), value.evaluate(lookup)?);
                }
                Ok(Value::Object(object))
            }
            Self::Unary { operator, operand } => {
                let value = operand.evaluate(lookup)?;
                match operator {
                    UnaryOperator::Not => Ok(Value::Bool(!is_truthy(&value))),
                    UnaryOperator::Negate => number_from(-expect_number(&value, "unary -")?),
                }
            }
            Self::Binary {
                operator,
                left,
                right,
            } => evaluate_binary(*operator, &left.evaluate(lookup)?, &right.evaluate(lookup)?),
            Self::Logical {
                operator,
                left,
                right,
            } => {
                let left = left.evaluate(lookup)?;
                let take_right = match operator {
                    LogicalOperator::And => is_truthy(&left),
                    LogicalOperator::Or => !is_truthy(&left),
                    LogicalOperator::Nullish => left.is_null(),
                };
                if take_right {
                    right.evaluate(lookup)
                } else {
                    Ok(left)
                }
            }
            Self::Conditional {
                test,
                consequent,
                alternate,
            } => {
                if is_truthy(&test.evaluate(lookup)?) {
                    consequent.evaluate(lookup)
                } else {
                    alternate.evaluate(lookup)
                }
            }
            Self::Member {
                object,
                property,
                optional,
            } => {
                let object = object.evaluate(lookup)?;
                if object.is_null() {
                    return if *optional {
                        Ok(Value::Null)
                    } else {
                        Err(format!("cannot read property `{property}` of null"))
                    };
                }
                read_property(&object, property)
            }
            Self::Index {
                object,
                index,
                optional,
            } => {
                let object = object.evaluate(lookup)?;
                if object.is_null() {
                    return if *optional {
                        Ok(Value::Null)
                    } else {
                        Err("cannot index null".to_owned())
                    };
                }
                let index = index.evaluate(lookup)?;
                match (&object, &index) {
                    (Value::Array(items), Value::Number(number)) => {
                        let position = number.as_f64().unwrap_or(f64::NAN);
                        if position.fract() != 0.0 || position < 0.0 {
                            return Err(format!(
                                "array index `{position}` must be a non-negative integer"
                            ));
                        }
                        Ok(items.get(position as usize).cloned().unwrap_or(Value::Null))
                    }
                    (Value::Object(_) | Value::String(_) | Value::Array(_), Value::String(key)) => {
                        read_property(&object, key)
                    }
                    _ => Err(format!(
                        "cannot index {} with {}",
                        type_name(&object),
                        type_name(&index)
                    )),
                }
            }
        }
    }

    /// Call `visit` with every free identifier, in source order. Object keys and member
    /// property names are not identifiers.
    pub fn for_each_identifier(&self, visit: &mut dyn FnMut(&str)) {
        match self {
            Self::Identifier(name) => visit(name),
            Self::Runtime { names, .. } => names.iter().for_each(|name| visit(&name.name)),
            Self::String(_) | Self::Number(_) | Self::Boolean(_) | Self::Null => {}
            Self::Array(elements) => elements
                .iter()
                .for_each(|element| element.for_each_identifier(visit)),
            Self::Object(properties) => properties
                .iter()
                .for_each(|(_, value)| value.for_each_identifier(visit)),
            Self::Unary { operand, .. } => operand.for_each_identifier(visit),
            Self::Binary { left, right, .. } | Self::Logical { left, right, .. } => {
                left.for_each_identifier(visit);
                right.for_each_identifier(visit);
            }
            Self::Conditional {
                test,
                consequent,
                alternate,
            } => {
                test.for_each_identifier(visit);
                consequent.for_each_identifier(visit);
                alternate.for_each_identifier(visit);
            }
            Self::Member { object, .. } => object.for_each_identifier(visit),
            Self::Index { object, index, .. } => {
                object.for_each_identifier(visit);
                index.for_each_identifier(visit);
            }
        }
    }

    /// Print as JavaScript. Fully parenthesized where precedence could matter, so the output
    /// is unambiguous without reproducing the precedence table in the printer.
    #[cfg(test)]
    pub fn to_js(&self) -> String {
        self.to_js_with(&|name| name.to_owned())
    }

    /// Print as JavaScript, with every free identifier replaced by `map(name)`. The JS backend
    /// uses this to turn `title` into `p.title` (a prop) or `$r(count)` (a script binding,
    /// unwrapped if it is a signal).
    pub fn to_js_with(&self, map: &dyn Fn(&str) -> String) -> String {
        match self {
            Self::Identifier(name) => map(name),
            Self::Runtime { source, names } => crate::runtime_expression::to_js(source, names, map),
            Self::String(value) => serde_json::to_string(value).unwrap_or_default(),
            Self::Number(text) => text.clone(),
            Self::Boolean(value) => value.to_string(),
            Self::Null => "null".to_owned(),
            Self::Array(elements) => format!(
                "[{}]",
                elements
                    .iter()
                    .map(|element| element.to_js_with(map))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            // Parenthesized: `() => { a: 1 }` would be a function body, not an object.
            Self::Object(properties) => format!(
                "({{ {} }})",
                properties
                    .iter()
                    .map(|(key, value)| format!(
                        "{}: {}",
                        serde_json::to_string(key).unwrap_or_default(),
                        value.to_js_with(map)
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Self::Unary { operator, operand } => {
                let symbol = match operator {
                    UnaryOperator::Not => "!",
                    UnaryOperator::Negate => "-",
                };
                format!("{symbol}({})", operand.to_js_with(map))
            }
            Self::Binary {
                operator,
                left,
                right,
            } => {
                let symbol = match operator {
                    BinaryOperator::Equal => "===",
                    BinaryOperator::NotEqual => "!==",
                    BinaryOperator::Less => "<",
                    BinaryOperator::LessEqual => "<=",
                    BinaryOperator::Greater => ">",
                    BinaryOperator::GreaterEqual => ">=",
                    BinaryOperator::Add => "+",
                    BinaryOperator::Subtract => "-",
                    BinaryOperator::Multiply => "*",
                    BinaryOperator::Divide => "/",
                    BinaryOperator::Remainder => "%",
                };
                format!(
                    "({} {symbol} {})",
                    left.to_js_with(map),
                    right.to_js_with(map)
                )
            }
            Self::Logical {
                operator,
                left,
                right,
            } => {
                let symbol = match operator {
                    LogicalOperator::And => "&&",
                    LogicalOperator::Or => "||",
                    LogicalOperator::Nullish => "??",
                };
                format!(
                    "({} {symbol} {})",
                    left.to_js_with(map),
                    right.to_js_with(map)
                )
            }
            Self::Conditional {
                test,
                consequent,
                alternate,
            } => format!(
                "({} ? {} : {})",
                test.to_js_with(map),
                consequent.to_js_with(map),
                alternate.to_js_with(map)
            ),
            Self::Member {
                object,
                property,
                optional,
            } => format!(
                "{}{}{property}",
                object.to_js_with(map),
                if *optional { "?." } else { "." }
            ),
            Self::Index {
                object,
                index,
                optional,
            } => format!(
                "{}{}[{}]",
                object.to_js_with(map),
                if *optional { "?." } else { "" },
                index.to_js_with(map)
            ),
        }
    }
}

/// JavaScript truthiness over JSON values. (`NaN` cannot occur: JSON has no NaN.)
pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript's `String(value)` for the scalar types; objects and arrays are rejected
/// because interpolating them is almost always a mistake (`[object Object]`).
pub fn to_display_string(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok(String::new()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(number) => Ok(format_number(number.as_f64().unwrap_or(0.0))),
        Value::String(text) => Ok(text.clone()),
        Value::Array(_) | Value::Object(_) => Err(format!(
            "cannot interpolate {}; access a field or iterate it instead",
            type_name(value)
        )),
    }
}

pub fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn format_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{}", number as i64)
    } else {
        number.to_string()
    }
}

fn expect_number(value: &Value, operator: &str) -> Result<f64, String> {
    value
        .as_f64()
        .ok_or_else(|| format!("{operator} requires a number, found {}", type_name(value)))
}

fn number_from(number: f64) -> Result<Value, String> {
    if !number.is_finite() {
        return Err("arithmetic produced a non-finite number".to_owned());
    }
    if number.fract() == 0.0 && number.abs() < i64::MAX as f64 {
        Ok(Value::from(number as i64))
    } else {
        Ok(Value::from(number))
    }
}

fn values_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        _ => left == right,
    }
}

fn read_property(object: &Value, property: &str) -> Result<Value, String> {
    match object {
        Value::Object(fields) => Ok(fields.get(property).cloned().unwrap_or(Value::Null)),
        Value::Array(items) if property == "length" => Ok(Value::from(items.len())),
        Value::String(text) if property == "length" => Ok(Value::from(text.chars().count())),
        _ => Err(format!(
            "cannot read property `{property}` of {}",
            type_name(object)
        )),
    }
}

fn evaluate_binary(operator: BinaryOperator, left: &Value, right: &Value) -> Result<Value, String> {
    use BinaryOperator as Op;
    match operator {
        Op::Equal => Ok(Value::Bool(values_equal(left, right))),
        Op::NotEqual => Ok(Value::Bool(!values_equal(left, right))),
        Op::Add => match (left, right) {
            (Value::String(_), _) | (_, Value::String(_)) => Ok(Value::String(
                to_display_string(left)? + &to_display_string(right)?,
            )),
            (Value::Number(left), Value::Number(right)) => {
                number_from(left.as_f64().unwrap_or(0.0) + right.as_f64().unwrap_or(0.0))
            }
            _ => Err(format!(
                "operator + requires numbers or strings, found {} and {}",
                type_name(left),
                type_name(right)
            )),
        },
        Op::Less | Op::LessEqual | Op::Greater | Op::GreaterEqual => {
            let ordering = match (left, right) {
                (Value::Number(left), Value::Number(right)) => left
                    .as_f64()
                    .partial_cmp(&right.as_f64())
                    .ok_or_else(|| "cannot compare these numbers".to_owned())?,
                (Value::String(left), Value::String(right)) => left.cmp(right),
                _ => {
                    return Err(format!(
                        "comparison requires two numbers or two strings, found {} and {}",
                        type_name(left),
                        type_name(right)
                    ))
                }
            };
            Ok(Value::Bool(match operator {
                Op::Less => ordering.is_lt(),
                Op::LessEqual => ordering.is_le(),
                Op::Greater => ordering.is_gt(),
                _ => ordering.is_ge(),
            }))
        }
        Op::Subtract | Op::Multiply | Op::Divide | Op::Remainder => {
            let symbol = match operator {
                Op::Subtract => "-",
                Op::Multiply => "*",
                Op::Divide => "/",
                _ => "%",
            };
            let left = expect_number(left, &format!("operator {symbol}"))?;
            let right = expect_number(right, &format!("operator {symbol}"))?;
            number_from(match operator {
                Op::Subtract => left - right,
                Op::Multiply => left * right,
                Op::Divide => left / right,
                _ => left % right,
            })
        }
    }
}

// ---- parser --------------------------------------------------------------------------------

struct Parser<'a> {
    source: &'a str,
    position: usize,
}

impl Parser<'_> {
    fn parse_conditional(&mut self) -> Result<Expression, ParseError> {
        let test = self.parse_nullish()?;
        self.skip_whitespace();
        // `?.` is optional chaining, handled in postfix; a lone `?` starts a conditional.
        if self.peek() == Some(b'?') && !matches!(self.peek_at(1), Some(b'.' | b'?')) {
            self.advance(1);
            let consequent = self.parse_conditional()?;
            self.skip_whitespace();
            if !self.consume(":") {
                return Err(self.error("expected : in conditional expression"));
            }
            let alternate = self.parse_conditional()?;
            return Ok(Expression::Conditional {
                test: Box::new(test),
                consequent: Box::new(consequent),
                alternate: Box::new(alternate),
            });
        }
        Ok(test)
    }

    fn parse_nullish(&mut self) -> Result<Expression, ParseError> {
        let mut expression = self.parse_or()?;
        loop {
            self.skip_whitespace();
            if !self.consume("??") {
                return Ok(expression);
            }
            expression = logical(LogicalOperator::Nullish, expression, self.parse_or()?);
        }
    }

    fn parse_or(&mut self) -> Result<Expression, ParseError> {
        let mut expression = self.parse_and()?;
        loop {
            self.skip_whitespace();
            if !self.consume("||") {
                return Ok(expression);
            }
            expression = logical(LogicalOperator::Or, expression, self.parse_and()?);
        }
    }

    fn parse_and(&mut self) -> Result<Expression, ParseError> {
        let mut expression = self.parse_equality()?;
        loop {
            self.skip_whitespace();
            if !self.consume("&&") {
                return Ok(expression);
            }
            expression = logical(LogicalOperator::And, expression, self.parse_equality()?);
        }
    }

    fn parse_equality(&mut self) -> Result<Expression, ParseError> {
        let mut expression = self.parse_comparison()?;
        loop {
            self.skip_whitespace();
            let operator = if self.consume("===") || self.consume("==") {
                BinaryOperator::Equal
            } else if self.consume("!==") || self.consume("!=") {
                BinaryOperator::NotEqual
            } else {
                return Ok(expression);
            };
            expression = binary(operator, expression, self.parse_comparison()?);
        }
    }

    fn parse_comparison(&mut self) -> Result<Expression, ParseError> {
        let mut expression = self.parse_additive()?;
        loop {
            self.skip_whitespace();
            let operator = if self.consume("<=") {
                BinaryOperator::LessEqual
            } else if self.consume(">=") {
                BinaryOperator::GreaterEqual
            } else if self.consume("<") {
                BinaryOperator::Less
            } else if self.consume(">") {
                BinaryOperator::Greater
            } else {
                return Ok(expression);
            };
            expression = binary(operator, expression, self.parse_additive()?);
        }
    }

    fn parse_additive(&mut self) -> Result<Expression, ParseError> {
        let mut expression = self.parse_multiplicative()?;
        loop {
            self.skip_whitespace();
            let operator = if self.consume("+") {
                BinaryOperator::Add
            } else if self.consume("-") {
                BinaryOperator::Subtract
            } else {
                return Ok(expression);
            };
            expression = binary(operator, expression, self.parse_multiplicative()?);
        }
    }

    fn parse_multiplicative(&mut self) -> Result<Expression, ParseError> {
        let mut expression = self.parse_unary()?;
        loop {
            self.skip_whitespace();
            let operator = if self.consume("*") {
                BinaryOperator::Multiply
            } else if self.consume("/") {
                BinaryOperator::Divide
            } else if self.consume("%") {
                BinaryOperator::Remainder
            } else {
                return Ok(expression);
            };
            expression = binary(operator, expression, self.parse_unary()?);
        }
    }

    fn parse_unary(&mut self) -> Result<Expression, ParseError> {
        self.skip_whitespace();
        let operator = if self.peek() == Some(b'!') && self.peek_at(1) != Some(b'=') {
            self.advance(1);
            UnaryOperator::Not
        } else if self.peek() == Some(b'-') {
            self.advance(1);
            UnaryOperator::Negate
        } else {
            return self.parse_postfix();
        };
        Ok(Expression::Unary {
            operator,
            operand: Box::new(self.parse_unary()?),
        })
    }

    fn parse_postfix(&mut self) -> Result<Expression, ParseError> {
        let mut expression = self.parse_primary()?;
        loop {
            self.skip_whitespace();
            let optional = self.consume("?.");
            if self.consume("[") {
                let index = self.parse_conditional()?;
                self.skip_whitespace();
                if !self.consume("]") {
                    return Err(self.error("expected ] after index"));
                }
                expression = Expression::Index {
                    object: Box::new(expression),
                    index: Box::new(index),
                    optional,
                };
            } else if optional || self.consume(".") {
                let property = self.take_identifier();
                if property.is_empty() {
                    return Err(self.error("expected a property name after ."));
                }
                expression = Expression::Member {
                    object: Box::new(expression),
                    property,
                    optional,
                };
            } else if self.peek() == Some(b'(') {
                return Err(self.error("function calls are not supported in template expressions"));
            } else {
                return Ok(expression);
            }
        }
    }

    fn parse_primary(&mut self) -> Result<Expression, ParseError> {
        self.skip_whitespace();
        let Some(first) = self.peek() else {
            return Err(self.error("expected an expression"));
        };
        match first {
            b'(' => {
                self.advance(1);
                let expression = self.parse_conditional()?;
                self.skip_whitespace();
                if !self.consume(")") {
                    return Err(self.error("expected )"));
                }
                Ok(expression)
            }
            b'[' => {
                self.advance(1);
                let elements = self.parse_list(b']', |parser| parser.parse_conditional())?;
                Ok(Expression::Array(elements))
            }
            b'{' => {
                self.advance(1);
                let properties = self.parse_list(b'}', |parser| {
                    parser.skip_whitespace();
                    let (key, quoted) = match parser.peek() {
                        Some(b'\'' | b'"') => (parser.parse_string()?, true),
                        _ => {
                            let identifier = parser.take_identifier();
                            if identifier.is_empty() {
                                return Err(parser.error("expected a property name"));
                            }
                            (identifier, false)
                        }
                    };
                    parser.skip_whitespace();
                    // `{ open }`: shorthand for `{ open: open }`.
                    if !quoted && matches!(parser.peek(), Some(b',' | b'}')) {
                        return Ok((key.clone(), Expression::Identifier(key)));
                    }
                    if !parser.consume(":") {
                        return Err(parser.error("expected : after object key"));
                    }
                    Ok((key, parser.parse_conditional()?))
                })?;
                Ok(Expression::Object(properties))
            }
            b'\'' | b'"' | b'`' => Ok(Expression::String(self.parse_string()?)),
            b'0'..=b'9' => self.parse_number(),
            _ if is_identifier_start(first) => {
                let identifier = self.take_identifier();
                Ok(match identifier.as_str() {
                    "true" => Expression::Boolean(true),
                    "false" => Expression::Boolean(false),
                    "null" | "undefined" => Expression::Null,
                    "new" | "this" | "function" | "typeof" | "await" | "yield" => {
                        return Err(ParseError {
                            offset: self.position - identifier.len(),
                            message: format!(
                                "`{identifier}` is not supported in template expressions"
                            ),
                        });
                    }
                    _ => Expression::Identifier(identifier),
                })
            }
            b'=' => Err(self.error("assignment is not supported in template expressions")),
            _ => Err(self.error("expected a literal, identifier, !, -, (, [ or {")),
        }
    }

    /// Comma-separated items up to `close`, allowing a trailing comma.
    fn parse_list<T>(
        &mut self,
        close: u8,
        mut item: impl FnMut(&mut Self) -> Result<T, ParseError>,
    ) -> Result<Vec<T>, ParseError> {
        let mut items = Vec::new();
        loop {
            self.skip_whitespace();
            if self.peek() == Some(close) {
                self.advance(1);
                return Ok(items);
            }
            if self.peek().is_none() {
                return Err(self.error(&format!("expected {}", close as char)));
            }
            items.push(item(self)?);
            self.skip_whitespace();
            if self.consume(",") {
                continue;
            }
            if self.peek() == Some(close) {
                self.advance(1);
                return Ok(items);
            }
            return Err(self.error(&format!("expected , or {}", close as char)));
        }
    }

    fn parse_string(&mut self) -> Result<String, ParseError> {
        let start = self.position;
        let quote = self.peek().expect("caller checked for a quote");
        self.advance(1);
        let mut value = String::new();
        while let Some(character) = self.peek_char() {
            if character as u32 == quote as u32 {
                self.advance(1);
                return Ok(value);
            }
            if quote == b'`' && character == '$' && self.peek_at(1) == Some(b'{') {
                return Err(self.error("template substitutions are not supported; use + instead"));
            }
            if character == '\\' {
                self.advance(1);
                let Some(escaped) = self.peek_char() else {
                    break;
                };
                value.push(match escaped {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    '0' => '\0',
                    '\\' | '\'' | '"' | '`' => escaped,
                    _ => return Err(self.error(&format!("unsupported escape `\\{escaped}`"))),
                });
                self.advance(escaped.len_utf8());
                continue;
            }
            value.push(character);
            self.advance(character.len_utf8());
        }
        Err(ParseError {
            offset: start,
            message: "unterminated string literal".to_owned(),
        })
    }

    fn parse_number(&mut self) -> Result<Expression, ParseError> {
        let start = self.position;
        self.take_digits();
        if self.peek() == Some(b'.') {
            self.advance(1);
            if self.take_digits().is_empty() {
                return Err(self.error("expected digits after decimal point"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.advance(1);
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.advance(1);
            }
            if self.take_digits().is_empty() {
                return Err(self.error("expected digits in exponent"));
            }
        }
        if self.peek().is_some_and(is_identifier_start) {
            return Err(self.error("unexpected character after number"));
        }
        let text = &self.source[start..self.position];
        serde_json::from_str::<Value>(text).map_err(|_| ParseError {
            offset: start,
            message: format!("invalid number literal `{text}`"),
        })?;
        Ok(Expression::Number(text.to_owned()))
    }

    fn take_digits(&mut self) -> &str {
        let start = self.position;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.advance(1);
        }
        &self.source[start..self.position]
    }

    fn take_identifier(&mut self) -> String {
        let start = self.position;
        if self.peek().is_some_and(is_identifier_start) {
            self.advance(1);
            while self.peek().is_some_and(is_identifier_continue) {
                self.advance(1);
            }
        }
        self.source[start..self.position].to_owned()
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(|byte| byte.is_ascii_whitespace()) {
            self.advance(1);
        }
    }

    fn peek(&self) -> Option<u8> {
        self.source.as_bytes().get(self.position).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<u8> {
        self.source.as_bytes().get(self.position + offset).copied()
    }

    fn peek_char(&self) -> Option<char> {
        self.source[self.position..].chars().next()
    }

    fn consume(&mut self, value: &str) -> bool {
        if self.source[self.position..].starts_with(value) {
            self.advance(value.len());
            true
        } else {
            false
        }
    }

    fn advance(&mut self, byte_count: usize) {
        self.position += byte_count;
    }

    fn error(&self, message: &str) -> ParseError {
        ParseError {
            offset: self.position,
            message: message.to_owned(),
        }
    }
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$'
}

fn is_identifier_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

fn binary(operator: BinaryOperator, left: Expression, right: Expression) -> Expression {
    Expression::Binary {
        operator,
        left: Box::new(left),
        right: Box::new(right),
    }
}

fn logical(operator: LogicalOperator, left: Expression, right: Expression) -> Expression {
    Expression::Logical {
        operator,
        left: Box::new(left),
        right: Box::new(right),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn eval(source: &str, scope: Value) -> Result<Value, String> {
        let expression = parse(source).unwrap_or_else(|error| panic!("{source}: {error}"));
        expression.evaluate(&|name| scope.get(name).cloned())
    }

    #[test]
    fn evaluates_member_and_index_access() {
        let scope = json!({ "data": { "sample": "one", "list": [10, 20] }, "none": null });
        assert_eq!(eval("data.sample", scope.clone()).unwrap(), json!("one"));
        assert_eq!(eval("data.list[1]", scope.clone()).unwrap(), json!(20));
        assert_eq!(eval("data.list.length", scope.clone()).unwrap(), json!(2));
        assert_eq!(
            eval("data[\"sample\"]", scope.clone()).unwrap(),
            json!("one")
        );
        assert_eq!(eval("data.missing", scope.clone()).unwrap(), Value::Null);
        assert_eq!(eval("none?.field", scope.clone()).unwrap(), Value::Null);
        assert!(eval("none.field", scope).unwrap_err().contains("of null"));
    }

    #[test]
    fn follows_javascript_truthiness_and_short_circuits() {
        let scope = json!({ "count": 0, "name": "", "user": null });
        assert_eq!(eval("count || 5", scope.clone()).unwrap(), json!(5));
        assert_eq!(
            eval("name && name.length", scope.clone()).unwrap(),
            json!("")
        );
        assert_eq!(
            eval("user && user.name", scope.clone()).unwrap(),
            Value::Null
        );
        assert_eq!(
            eval("user ?? 'anon'", scope.clone()).unwrap(),
            json!("anon")
        );
        assert_eq!(eval("!count", scope.clone()).unwrap(), json!(true));
        assert_eq!(eval("count ? 'yes' : 'no'", scope).unwrap(), json!("no"));
    }

    #[test]
    fn evaluates_arithmetic_comparison_and_concatenation() {
        let scope = json!({ "a": 7, "b": 2, "s": "x" });
        assert_eq!(eval("a + b * 2", scope.clone()).unwrap(), json!(11));
        assert_eq!(eval("(a + b) * 2", scope.clone()).unwrap(), json!(18));
        assert_eq!(eval("a / b", scope.clone()).unwrap(), json!(3.5));
        assert_eq!(eval("a % b", scope.clone()).unwrap(), json!(1));
        assert_eq!(eval("-a", scope.clone()).unwrap(), json!(-7));
        assert_eq!(eval("a > b && b >= 2", scope.clone()).unwrap(), json!(true));
        assert_eq!(eval("s + a + '!'", scope.clone()).unwrap(), json!("x7!"));
        assert_eq!(
            eval("a == 7.0 && a !== b", scope.clone()).unwrap(),
            json!(true)
        );
        assert!(eval("a - s", scope.clone())
            .unwrap_err()
            .contains("requires a number"));
        assert!(eval("a < s", scope)
            .unwrap_err()
            .contains("two numbers or two strings"));
    }

    #[test]
    fn parses_literals() {
        let scope = json!({});
        assert_eq!(
            eval("{ a: 1, 'b': [true, null], c: { d: 'x' }, }", scope.clone()).unwrap(),
            json!({ "a": 1, "b": [true, null], "c": { "d": "x" } })
        );
        assert_eq!(eval("'it\\'s'", scope.clone()).unwrap(), json!("it's"));
        assert_eq!(eval("`plain`", scope.clone()).unwrap(), json!("plain"));
        assert_eq!(eval("1.5e3", scope.clone()).unwrap(), json!(1500.0));
        assert_eq!(eval("undefined", scope).unwrap(), Value::Null);
    }

    #[test]
    fn rejects_unsupported_syntax_with_offsets() {
        let error = parse("items.map(x)").unwrap_err();
        assert!(error.message.contains("function calls"));
        assert_eq!(error.offset, 9);
        assert!(parse("a = 1")
            .unwrap_err()
            .message
            .contains("unexpected characters"));
        assert!(parse("`a ${b}`")
            .unwrap_err()
            .message
            .contains("template substitutions"));
        assert!(parse("new Thing").unwrap_err().message.contains("`new`"));
        assert!(parse("a +")
            .unwrap_err()
            .message
            .contains("expected an expression"));
        assert!(parse("[1, 2").unwrap_err().message.contains("expected"));
    }

    #[test]
    fn parse_prefix_stops_at_the_end_of_the_expression() {
        let (expression, end) = parse_prefix("a.b + 1\nconst next = 2").unwrap();
        assert_eq!(&"a.b + 1\nconst next = 2"[end..], "const next = 2");
        assert_eq!(expression.to_js(), "(a.b + 1)");
    }

    #[test]
    fn collects_free_identifiers_and_prints_javascript() {
        let expression = parse("user?.name ?? items[i].label + { k: v }.k").unwrap();
        let mut names = Vec::new();
        expression.for_each_identifier(&mut |name| names.push(name.to_owned()));
        assert_eq!(names, ["user", "items", "i", "v"]);
        assert_eq!(
            expression.to_js(),
            "(user?.name ?? (items[i].label + ({ \"k\": v }).k))"
        );
    }
}
