use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Expression {
    Identifier(String),
    String(String),
    Number(String),
    Boolean(bool),
    Not(Box<Expression>),
    Equal(Box<Expression>, Box<Expression>),
    NotEqual(Box<Expression>, Box<Expression>),
    And(Box<Expression>, Box<Expression>),
    Or(Box<Expression>, Box<Expression>),
}

pub fn parse(source: &str) -> Result<Expression, String> {
    let mut parser = Parser {
        source,
        position: 0,
    };
    let expression = parser.parse_or()?;
    parser.skip_whitespace();
    if parser.position != source.len() {
        return Err("unexpected characters after expression".to_owned());
    }
    Ok(expression)
}

impl Expression {
    pub fn evaluate(&self, lookup: &impl Fn(&str) -> Option<Value>) -> Result<Value, String> {
        match self {
            Self::Identifier(name) => {
                lookup(name).ok_or_else(|| format!("unknown reference `{name}`"))
            }
            Self::String(value) => Ok(Value::String(value.clone())),
            Self::Number(value) => {
                serde_json::from_str(value).map_err(|_| format!("invalid number literal `{value}`"))
            }
            Self::Boolean(value) => Ok(Value::Bool(*value)),
            Self::Not(expression) => match expression.evaluate(lookup)? {
                Value::Bool(value) => Ok(Value::Bool(!value)),
                _ => Err("operator ! requires a boolean".to_owned()),
            },
            Self::Equal(left, right) => Ok(Value::Bool(
                left.evaluate(lookup)? == right.evaluate(lookup)?,
            )),
            Self::NotEqual(left, right) => Ok(Value::Bool(
                left.evaluate(lookup)? != right.evaluate(lookup)?,
            )),
            Self::And(left, right) => {
                let left = evaluate_boolean(left, lookup, "operator &&")?;
                let right = evaluate_boolean(right, lookup, "operator &&")?;
                Ok(Value::Bool(left && right))
            }
            Self::Or(left, right) => {
                let left = evaluate_boolean(left, lookup, "operator ||")?;
                let right = evaluate_boolean(right, lookup, "operator ||")?;
                Ok(Value::Bool(left || right))
            }
        }
    }
}

fn evaluate_boolean(
    expression: &Expression,
    lookup: &impl Fn(&str) -> Option<Value>,
    operator: &str,
) -> Result<bool, String> {
    match expression.evaluate(lookup)? {
        Value::Bool(value) => Ok(value),
        _ => Err(format!("{operator} requires boolean operands")),
    }
}

struct Parser<'a> {
    source: &'a str,
    position: usize,
}

impl Parser<'_> {
    fn parse_or(&mut self) -> Result<Expression, String> {
        let mut expression = self.parse_and()?;
        loop {
            self.skip_whitespace();
            if !self.consume("||") {
                return Ok(expression);
            }
            expression = Expression::Or(Box::new(expression), Box::new(self.parse_and()?));
        }
    }

    fn parse_and(&mut self) -> Result<Expression, String> {
        let mut expression = self.parse_equality()?;
        loop {
            self.skip_whitespace();
            if !self.consume("&&") {
                return Ok(expression);
            }
            expression = Expression::And(Box::new(expression), Box::new(self.parse_equality()?));
        }
    }

    fn parse_equality(&mut self) -> Result<Expression, String> {
        let mut expression = self.parse_unary()?;
        loop {
            self.skip_whitespace();
            if self.consume("==") {
                expression = Expression::Equal(Box::new(expression), Box::new(self.parse_unary()?));
            } else if self.consume("!=") {
                expression =
                    Expression::NotEqual(Box::new(expression), Box::new(self.parse_unary()?));
            } else {
                return Ok(expression);
            }
        }
    }

    fn parse_unary(&mut self) -> Result<Expression, String> {
        self.skip_whitespace();
        if self.consume("!") {
            if self.consume("=") {
                return Err("expected ! or !=, found != without a left operand".to_owned());
            }
            return Ok(Expression::Not(Box::new(self.parse_unary()?)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expression, String> {
        self.skip_whitespace();
        if self.consume("(") {
            let expression = self.parse_or()?;
            self.skip_whitespace();
            if !self.consume(")") {
                return Err("expected )".to_owned());
            }
            return Ok(expression);
        }
        if self.position >= self.source.len() {
            return Err("expected an expression".to_owned());
        }
        let first = self.source.as_bytes()[self.position];
        if first == b'\'' || first == b'"' {
            return self.parse_string(first as char);
        }
        if first.is_ascii_digit()
            || first == b'-'
                && self
                    .source
                    .as_bytes()
                    .get(self.position + 1)
                    .is_some_and(u8::is_ascii_digit)
        {
            return self.parse_number();
        }
        if first.is_ascii_alphabetic() || first == b'_' {
            let start = self.position;
            while self
                .source
                .as_bytes()
                .get(self.position)
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            {
                self.advance(1);
            }
            let identifier = &self.source[start..self.position];
            return Ok(match identifier {
                "true" => Expression::Boolean(true),
                "false" => Expression::Boolean(false),
                "and" | "or" | "null" => {
                    return Err(format!("unsupported expression keyword `{identifier}`"));
                }
                _ => Expression::Identifier(identifier.to_owned()),
            });
        }
        Err("expected a literal, identifier, !, or (".to_owned())
    }

    fn parse_string(&mut self, quote: char) -> Result<Expression, String> {
        self.advance(1);
        let mut value = String::new();
        while self.position < self.source.len() {
            let character = self.source[self.position..]
                .chars()
                .next()
                .expect("position is before the end of the expression");
            if character == quote {
                self.advance(character.len_utf8());
                return Ok(Expression::String(value));
            }
            if character == '\\' {
                self.advance(1);
                let escaped = self
                    .source
                    .get(self.position..)
                    .and_then(|rest| rest.chars().next())
                    .ok_or_else(|| "unterminated escape in string literal".to_owned())?;
                if escaped != quote && escaped != '\\' {
                    return Err("only escaped quotes and backslashes are supported".to_owned());
                }
                value.push(escaped);
                self.advance(escaped.len_utf8());
            } else {
                value.push(character);
                self.advance(character.len_utf8());
            }
        }
        Err("unterminated string literal".to_owned())
    }

    fn parse_number(&mut self) -> Result<Expression, String> {
        let start = self.position;
        self.consume("-");
        while self
            .source
            .as_bytes()
            .get(self.position)
            .is_some_and(u8::is_ascii_digit)
        {
            self.advance(1);
        }
        if self.consume(".") {
            let fraction_start = self.position;
            while self
                .source
                .as_bytes()
                .get(self.position)
                .is_some_and(u8::is_ascii_digit)
            {
                self.advance(1);
            }
            if fraction_start == self.position {
                return Err("expected digits after decimal point".to_owned());
            }
        }
        let value = self.source[start..self.position].to_owned();
        serde_json::from_str::<Value>(&value)
            .map_err(|_| format!("invalid number literal `{value}`"))?;
        Ok(Expression::Number(value))
    }

    fn skip_whitespace(&mut self) {
        while self
            .source
            .as_bytes()
            .get(self.position)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.advance(1);
        }
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
}
