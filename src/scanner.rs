//! Character-level scanning shared by the template, script, and expression parsers.
//!
//! The compiler reads three "languages" out of one `.zb` file: HTML-shaped markup, a small
//! JavaScript statement subset inside `<script>`, and JS-subset expressions inside `{ … }`.
//! Each has its own parser, but they all walk the same source with the same bookkeeping:
//! a byte position plus the line/column that position corresponds to, so every diagnostic
//! can point at the file. `Cursor` owns that bookkeeping.
//!
//! The one piece of real lexing here is [`Cursor::scan_braced`]: given a `{`, it finds the
//! matching `}` while respecting nested brackets and string literals, so the expression
//! parser is handed exactly the text between the braces. This is the markup-to-expression
//! "mode switch" — the same trick template-literal lexers use for `${ … }`.

use crate::diagnostic::{Diagnostic, Span};

#[derive(Clone, Debug)]
pub struct Cursor<'a> {
    source: &'a str,
    position: usize,
    line: usize,
    column: usize,
}

/// The text between a pair of braces, with the position of the opening brace and of the
/// first character inside it (for mapping expression-parser offsets back to the file).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Braced<'a> {
    pub inner: &'a str,
    pub open_span: Span,
    pub inner_span: Span,
}

impl<'a> Cursor<'a> {
    pub fn new(source: &'a str) -> Self {
        Self::at(source, Span::new(1, 1))
    }

    /// A cursor whose first character sits at `start` in the enclosing file. Used when a
    /// sub-parser receives a slice (a `<script>` body, a `{…}` expression) and must still
    /// report file-relative positions.
    pub fn at(source: &'a str, start: Span) -> Self {
        Self {
            source,
            position: 0,
            line: start.line,
            column: start.column,
        }
    }

    pub fn source(&self) -> &'a str {
        self.source
    }

    pub fn position(&self) -> usize {
        self.position
    }

    pub fn rest(&self) -> &'a str {
        &self.source[self.position..]
    }

    pub fn is_at_end(&self) -> bool {
        self.position >= self.source.len()
    }

    pub fn span(&self) -> Span {
        Span::new(self.line, self.column)
    }

    pub fn error(&self, message: impl Into<String>) -> Diagnostic {
        Diagnostic::new(self.span(), message)
    }

    pub fn peek_byte(&self) -> Option<u8> {
        self.source.as_bytes().get(self.position).copied()
    }

    pub fn peek_char(&self) -> Option<char> {
        self.rest().chars().next()
    }

    pub fn starts_with(&self, value: &str) -> bool {
        self.rest().starts_with(value)
    }

    pub fn starts_with_ignore_ascii_case(&self, value: &str) -> bool {
        self.rest()
            .get(..value.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(value))
    }

    /// Consume `value` if the cursor is on it.
    pub fn consume(&mut self, value: &str) -> bool {
        if self.starts_with(value) {
            self.advance(value.len());
            true
        } else {
            false
        }
    }

    /// Advance past `byte_count` bytes, updating line and column. `byte_count` must land on
    /// a character boundary.
    pub fn advance(&mut self, byte_count: usize) {
        let end = self.position + byte_count;
        for character in self.source[self.position..end].chars() {
            if character == '\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += 1;
            }
        }
        self.position = end;
    }

    /// Advance past the current character, whatever its UTF-8 width.
    pub fn advance_char(&mut self) {
        if let Some(character) = self.peek_char() {
            self.advance(character.len_utf8());
        }
    }

    pub fn skip_whitespace(&mut self) {
        while self
            .peek_byte()
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            self.advance(1);
        }
    }

    /// Consume bytes while `accept` holds and return the consumed slice (possibly empty).
    pub fn take_while(&mut self, accept: impl Fn(u8) -> bool) -> &'a str {
        let start = self.position;
        while self.peek_byte().is_some_and(&accept) {
            self.advance(1);
        }
        &self.source[start..self.position]
    }

    /// Consume the text between the cursor's `{` and its matching `}`.
    ///
    /// Nested `{}`, `[]`, and `()` are balanced, and quotes (`'`, `"`, `` ` ``) are skipped as
    /// string literals so a `}` inside a string never closes the expression. On return the
    /// cursor is just past the closing brace.
    pub fn scan_braced(&mut self) -> Result<Braced<'a>, Diagnostic> {
        let open_span = self.span();
        if !self.consume("{") {
            return Err(self.error("expected {"));
        }
        let inner_span = self.span();
        let inner_start = self.position;
        let mut depth = 1usize;
        while let Some(byte) = self.peek_byte() {
            match byte {
                b'{' | b'[' | b'(' => depth += 1,
                b'}' | b']' | b')' => {
                    depth -= 1;
                    if depth == 0 {
                        if byte != b'}' {
                            return Err(self.error(format!(
                                "unbalanced `{}` inside {{ }} expression",
                                byte as char
                            )));
                        }
                        let inner = &self.source[inner_start..self.position];
                        self.advance(1);
                        return Ok(Braced {
                            inner,
                            open_span,
                            inner_span,
                        });
                    }
                }
                b'\'' | b'"' | b'`' => {
                    self.skip_string(byte)?;
                    continue;
                }
                _ => {}
            }
            self.advance_char();
        }
        Err(Diagnostic::new(
            open_span,
            "unterminated { expression; expected a matching }",
        ))
    }

    /// Skip a quoted string literal starting at the cursor, honoring backslash escapes.
    fn skip_string(&mut self, quote: u8) -> Result<(), Diagnostic> {
        let start = self.span();
        self.advance(1);
        while let Some(byte) = self.peek_byte() {
            if byte == b'\\' {
                self.advance(1);
                self.advance_char();
                continue;
            }
            if byte == quote {
                self.advance(1);
                return Ok(());
            }
            self.advance_char();
        }
        Err(Diagnostic::new(start, "unterminated string literal"))
    }
}

/// Position `offset` bytes into `text`, starting from `start`.
pub fn span_after(start: Span, text: &str, offset: usize) -> Span {
    let mut cursor = Cursor::at(text, start);
    cursor.advance(offset.min(text.len()));
    cursor.span()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_lines_and_columns_through_multibyte_text() {
        let mut cursor = Cursor::new("Hé\nllo");
        cursor.advance_char();
        cursor.advance_char();
        assert_eq!(cursor.span(), Span::new(1, 3));
        cursor.advance(1);
        assert_eq!(cursor.span(), Span::new(2, 1));
    }

    #[test]
    fn scans_braced_expressions_with_nesting_and_strings() {
        let mut cursor = Cursor::new("{ a ? { b: \"}\" } : [1, (2)] } tail");
        let braced = cursor.scan_braced().unwrap();
        assert_eq!(braced.inner, " a ? { b: \"}\" } : [1, (2)] ");
        assert_eq!(braced.open_span, Span::new(1, 1));
        assert_eq!(braced.inner_span, Span::new(1, 2));
        assert_eq!(cursor.rest(), " tail");
    }

    #[test]
    fn reports_unterminated_and_unbalanced_braces() {
        assert!(Cursor::new("{ a + ")
            .scan_braced()
            .unwrap_err()
            .message
            .contains("unterminated"));
        assert!(Cursor::new("{ a ) }")
            .scan_braced()
            .unwrap_err()
            .message
            .contains("unbalanced"));
    }

    #[test]
    fn maps_offsets_to_spans() {
        assert_eq!(span_after(Span::new(3, 5), "ab\ncd", 4), Span::new(4, 2));
    }
}
