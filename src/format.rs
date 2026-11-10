//! `zubra fmt`: a `.zb` file laid out consistently, without changing what it compiles to.
//!
//! The formatter only touches whitespace the browser collapses or never sees:
//!
//! - **Indentation.** A run of whitespace in the template that already contains a line break is
//!   re-indented to its nesting depth (blank lines kept, at most one). In normal flow any run
//!   of whitespace renders as one space, so the page looks the same. A run without a line break
//!   is left as written: removing it, or adding one where there was none, could change how
//!   inline elements sit, so the formatter never does either.
//! - **Tags.** The whitespace inside a tag isn't text: attributes are separated by one space,
//!   `=` loses the spaces around it, `/>` gets one before it, and a tag that starts its line but
//!   doesn't fit in it puts one attribute per line (one inside a line of inline markup stays
//!   whole).
//! - **Top level.** The comment, `<script>`, `<style>` and host tag each start on their own
//!   line, with the blank line between them kept if there was one (one at most); no blank lines
//!   at the start; one line break at the end.
//!
//! Everything else is kept exactly as written: `{…}` expressions (markup in braces too),
//! comments, attribute values, `<script>` and `<style>` bodies, and everything inside `<pre>` and
//! `<textarea>`, whose whitespace shows. So the compiled output is the same except for the
//! length of whitespace runs with line breaks in them (`tests/format.rs` checks that for every
//! component in the repository). The one case it can't see: an element whose CSS sets
//! `white-space: pre` or similar shows its indentation; wrap such content in `<pre>`, or leave
//! that file unformatted.
//!
//! It refuses a file that doesn't parse (fix the error first) and a JSX component (`.zb.tsx`,
//! `.zb.jsx`: Prettier formats those), and checks that what it wrote still parses.

use crate::{
    diagnostic::{Diagnostic, Span},
    parser::{self, VOID_ELEMENTS},
    scanner::Cursor,
};

/// How the formatter lays a file out.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FormatOptions {
    /// Spaces per level (ignored with `use_tabs`).
    pub indent_width: usize,
    /// Indent with tabs instead of spaces.
    pub use_tabs: bool,
    /// The line width a tag is fitted into before its attributes go one per line.
    pub print_width: usize,
}

impl Default for FormatOptions {
    fn default() -> Self {
        Self {
            indent_width: 2,
            use_tabs: false,
            print_width: 100,
        }
    }
}

/// The comment that opts a file out: `<!-- zubra-fmt-ignore -->` as the first thing in it.
pub const IGNORE_COMMENT: &str = "zubra-fmt-ignore";

/// Whether the file opts out of formatting: its first non-blank content is the comment
/// `<!-- zubra-fmt-ignore -->`. For a fixture that is malformed on purpose, or a file laid out by
/// hand. It is read before parsing, so a file that doesn't parse can opt out too.
pub fn is_ignored(source: &str) -> bool {
    source
        .trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n'])
        .strip_prefix("<!--")
        .and_then(|rest| rest.split_once("-->"))
        .is_some_and(|(comment, _)| comment.trim() == IGNORE_COMMENT)
}

/// Whether the file's lines end in CRLF: its first line break decides. The formatter keeps the
/// file's line endings, so a CRLF checkout (Windows with `core.autocrlf`) isn't "unformatted".
fn uses_crlf(source: &str) -> bool {
    source
        .find('\n')
        .is_some_and(|at| at > 0 && source.as_bytes()[at - 1] == b'\r')
}

/// `source` formatted. An error when it doesn't parse (the compiler's own error), or is a JSX
/// component. A file that opts out ([`is_ignored`]) is returned as it is, and line endings are
/// kept: a CRLF file stays CRLF.
pub fn format(source: &str, options: &FormatOptions) -> Result<String, Diagnostic> {
    if is_ignored(source) {
        return Ok(source.to_owned());
    }
    let crlf = uses_crlf(source);
    let source = source.replace("\r\n", "\n").replace('\r', "\n");
    if crate::jsx::looks_like_jsx(&source) {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            "zubra fmt formats HTML-first .zb files; this is a JSX component",
        )
        .with_help("format JSX components (.zb.tsx, .zb.jsx) with Prettier"));
    }
    parser::parse(&source)?;
    let tokens = scan(&source)?;
    let formatted = Printer::new(options).print(&tokens);
    // The output is checked, not trusted: if it doesn't parse, the file is left alone.
    if let Err(error) = parser::parse(&formatted) {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            format!(
                "the formatter wrote markup that doesn't parse ({}), so the file is left as it was",
                error.message
            ),
        )
        .with_help("please report it: https://github.com/journey-to-code-org/zubra/issues"));
    }
    Ok(if crlf {
        formatted.replace('\n', "\r\n")
    } else {
        formatted
    })
}

/// A change to a file: `start..end` (bytes of the original) replaced by `text`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RangeEdit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// The edit that formats what `start..end` (bytes of `source`) touches, or `None` when that part
/// is already formatted. The whole file is laid out (nesting depth and line widths depend on
/// what comes before), and the edit is the output for the tokens the range covers: from the
/// whitespace before the first (it carries the first line's indentation) to the end of the
/// last. The range is widened to whole lines. So it is exactly what formatting the file would write there, and nothing else changes.
/// Like [`format`], an error when the file doesn't parse, nothing for a file that opts out, and
/// the edit's line breaks are the file's own. An offset inside a character counts as the
/// character's start, so no offset an editor sends can be out of place.
pub fn format_range(
    source: &str,
    start: usize,
    end: usize,
    options: &FormatOptions,
) -> Result<Option<RangeEdit>, Diagnostic> {
    if is_ignored(source) {
        return Ok(None);
    }
    let crlf = uses_crlf(source);
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    if crate::jsx::looks_like_jsx(&normalized) {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            "zubra fmt formats HTML-first .zb files; this is a JSX component",
        )
        .with_help("format JSX components (.zb.tsx, .zb.jsx) with Prettier"));
    }
    parser::parse(&normalized)?;
    let tokens = scan(&normalized)?;
    let (formatted, marks) = Printer::new(options).print_marked(&tokens);
    if let Err(error) = parser::parse(&formatted) {
        return Err(Diagnostic::new(
            Span::new(1, 1),
            format!(
                "the formatter wrote markup that doesn't parse ({}), so the file is left as it was",
                error.message
            ),
        )
        .with_help("please report it: https://github.com/journey-to-code-org/zubra/issues"));
    }
    // Offsets in the text with LF line endings, which is what was scanned.
    let (start, end) = (
        normalized_offset(source, start.min(source.len())),
        normalized_offset(source, end.min(source.len())),
    );
    // An offset inside a multi-byte character (a client counting in other units, or a stale
    // one) is moved back to the character's start: slicing there would panic.
    let floor = |mut offset: usize| {
        while !normalized.is_char_boundary(offset) {
            offset -= 1;
        }
        offset
    };
    let (start, mut end) = (floor(start.min(end)), floor(end.max(start)));
    // Whole lines: a cursor, or a selection that starts or ends mid-line, formats its lines
    // (and a selection that ends at the start of a line leaves that line alone).
    if end > start && normalized.as_bytes().get(end - 1) == Some(&b'\n') {
        end -= 1;
    }
    let start = normalized[..start].rfind('\n').map_or(0, |at| at + 1);
    let end = normalized[end..]
        .find('\n')
        .map_or(normalized.len(), |at| end + at);
    let mut ranges = Vec::with_capacity(tokens.len());
    let mut at = 0;
    for token in &tokens {
        let length = match token {
            Token::Space(text) | Token::Text(text) | Token::Comment(text) | Token::Body(text) => {
                text.len()
            }
            Token::Open { raw, .. } | Token::Close { raw, .. } => raw.len(),
        };
        ranges.push(at..at + length);
        at += length;
    }
    let covered = |index: usize| {
        let range = &ranges[index];
        if start == end {
            range.start <= start && start < range.end
        } else {
            range.start < end && range.end > start
        }
    };
    let content = |index: usize| !matches!(tokens[index], Token::Space(_));
    let Some(first) = (0..tokens.len()).find(|&index| covered(index) && content(index)) else {
        return Ok(None);
    };
    let last = (first..tokens.len())
        .rev()
        .find(|&index| covered(index) && content(index))
        .unwrap_or(first);
    // The whitespace before the first token is part of the window.
    let first = if first > 0 && !content(first - 1) {
        first - 1
    } else {
        first
    };
    let (from, to) = (ranges[first].start, ranges[last].end);
    let text = formatted[marks[first]..marks[last + 1]].to_owned();
    if normalized[from..to] == text {
        return Ok(None);
    }
    Ok(Some(RangeEdit {
        start: original_offset(source, from),
        end: original_offset(source, to),
        text: if crlf {
            text.replace('\n', "\r\n")
        } else {
            text
        },
    }))
}

/// A byte offset in `source` as an offset in the same text with `\r\n` and `\r` as `\n`.
fn normalized_offset(source: &str, offset: usize) -> usize {
    let bytes = source.as_bytes();
    let pairs = (0..offset.saturating_sub(1))
        .filter(|&index| bytes[index] == b'\r' && bytes[index + 1] == b'\n')
        .count();
    offset - pairs
}

/// The inverse: where an offset in the normalized text is in `source`.
fn original_offset(source: &str, normalized: usize) -> usize {
    let bytes = source.as_bytes();
    let (mut seen, mut index) = (0, 0);
    while index < bytes.len() && seen < normalized {
        if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            index += 1;
        }
        index += 1;
        seen += 1;
    }
    index
}

// ---- the file's pieces by position, for tools that work on a selection ---------------------

/// What a piece of a file is, as far as its boundaries matter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PieceKind {
    /// Whitespace between things.
    Space,
    /// A run of text without whitespace in it (a word, an entity).
    Text,
    /// A `{…}` in the template, whole: an expression, or markup in braces.
    Braces,
    /// `<!-- … -->`.
    Comment,
    /// A start tag, whole, attributes included (`void` or self-closing: it has no end tag).
    Open { childless: bool },
    /// An end tag.
    Close,
    /// The text inside a `<script>` or `<style>`.
    Body,
}

/// One piece of the file: every byte of the file is in exactly one, in order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Piece {
    pub kind: PieceKind,
    pub start: usize,
    pub end: usize,
    /// The tag's name, for a start or end tag.
    pub name: String,
}

/// `source` as its pieces. A selection that doesn't start and end on a piece's edge is inside a
/// tag, a comment, an expression or a word. An error when the file doesn't scan.
pub(crate) fn pieces(source: &str) -> Result<Vec<Piece>, Diagnostic> {
    let mut at = 0;
    Ok(scan(source)?
        .into_iter()
        .map(|token| {
            let (kind, length, name) = match &token {
                Token::Space(text) => (PieceKind::Space, text.len(), ""),
                Token::Text(text) if text.starts_with('{') => (PieceKind::Braces, text.len(), ""),
                Token::Text(text) => (PieceKind::Text, text.len(), ""),
                Token::Comment(text) => (PieceKind::Comment, text.len(), ""),
                Token::Body(text) => (PieceKind::Body, text.len(), ""),
                Token::Open {
                    name,
                    self_closing,
                    raw,
                    ..
                } => (
                    PieceKind::Open {
                        childless: *self_closing
                            || VOID_ELEMENTS.contains(&name.to_ascii_lowercase().as_str()),
                    },
                    raw.len(),
                    *name,
                ),
                Token::Close { name, raw } => (PieceKind::Close, raw.len(), *name),
            };
            let piece = Piece {
                kind,
                start: at,
                end: at + length,
                name: name.to_owned(),
            };
            at += length;
            piece
        })
        .collect())
}

// ---- scanning: the file as tokens, every byte accounted for -------------------------------

#[derive(Clone, Debug, Eq, PartialEq)]
enum Token<'a> {
    /// A run of whitespace outside tags.
    Space(&'a str),
    /// Text, an entity, or a `{…}` expression: kept as written.
    Text(&'a str),
    /// `<!-- … -->`, kept as written.
    Comment(&'a str),
    /// An opening tag: its attributes as written (without the whitespace between them).
    Open {
        name: &'a str,
        attributes: Vec<String>,
        self_closing: bool,
        raw: &'a str,
    },
    /// `</name>`.
    Close { name: &'a str, raw: &'a str },
    /// A `<script>` or `<style>` body.
    Body(&'a str),
}

/// Elements whose body is text the formatter doesn't look into.
const BODY_ELEMENTS: &[&str] = &["script", "style"];
/// Elements whose whitespace shows: kept exactly as written, tags inside included.
const VERBATIM_ELEMENTS: &[&str] = &["pre", "textarea"];

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')
}

fn scan(source: &str) -> Result<Vec<Token<'_>>, Diagnostic> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut at = 0;
    let error = |at: usize, message: &str| {
        let mut cursor = Cursor::new(source);
        cursor.advance(at);
        cursor.error(message.to_owned())
    };
    while at < bytes.len() {
        let rest = &source[at..];
        if rest.starts_with("<!--") {
            let end = rest
                .find("-->")
                .map(|end| at + end + 3)
                .ok_or_else(|| error(at, "unterminated comment"))?;
            tokens.push(Token::Comment(&source[at..end]));
            at = end;
        } else if rest.starts_with("</") && bytes.get(at + 2).is_some_and(u8::is_ascii_alphabetic) {
            let name_end = at + 2 + rest[2..].bytes().take_while(|&b| is_name_byte(b)).count();
            let end = source[name_end..]
                .find('>')
                .map(|end| name_end + end + 1)
                .ok_or_else(|| error(at, "expected > after closing tag"))?;
            tokens.push(Token::Close {
                name: &source[at + 2..name_end],
                raw: &source[at..end],
            });
            at = end;
        } else if rest.starts_with('<') && bytes.get(at + 1).is_some_and(u8::is_ascii_alphabetic) {
            let (token, end) = open_tag(source, at)?;
            let body = match &token {
                Token::Open {
                    name,
                    self_closing: false,
                    ..
                } if BODY_ELEMENTS
                    .iter()
                    .any(|body| name.eq_ignore_ascii_case(body)) =>
                {
                    let close = format!("</{}", name.to_ascii_lowercase());
                    let length = source[end..]
                        .to_ascii_lowercase()
                        .find(&close)
                        .ok_or_else(|| error(at, &format!("missing closing tag </{name}>")))?;
                    Some(&source[end..end + length])
                }
                _ => None,
            };
            tokens.push(token);
            at = end;
            if let Some(body) = body {
                tokens.push(Token::Body(body));
                at += body.len();
            }
        } else if rest.starts_with('{') {
            let end = parser::braces_end(source, at)?;
            tokens.push(Token::Text(&source[at..end]));
            at = end;
        } else if bytes[at].is_ascii_whitespace() {
            let length = rest.bytes().take_while(u8::is_ascii_whitespace).count();
            tokens.push(Token::Space(&source[at..at + length]));
            at += length;
        } else {
            // Text, up to whitespace, a brace or markup (a `<` that starts a tag or comment).
            let mut end = at + rest.chars().next().map_or(1, char::len_utf8);
            while end < bytes.len() {
                let byte = bytes[end];
                if byte.is_ascii_whitespace() || byte == b'{' {
                    break;
                }
                if byte == b'<'
                    && bytes.get(end + 1).is_some_and(|&next| {
                        next.is_ascii_alphabetic() || next == b'/' || next == b'!'
                    })
                {
                    break;
                }
                end += source[end..].chars().next().map_or(1, char::len_utf8);
            }
            tokens.push(Token::Text(&source[at..end]));
            at = end;
        }
    }
    Ok(tokens)
}

/// The opening tag at `at`: the token and where it ends.
fn open_tag(source: &str, at: usize) -> Result<(Token<'_>, usize), Diagnostic> {
    let bytes = source.as_bytes();
    let mut cursor = Cursor::new(source);
    cursor.advance(at + 1);
    let name_start = cursor.position();
    cursor.take_while(is_name_byte);
    let name = &source[name_start..cursor.position()];
    let mut attributes = Vec::new();
    let self_closing = loop {
        cursor.skip_whitespace();
        if cursor.consume("/>") {
            break true;
        }
        if cursor.consume(">") {
            break false;
        }
        if cursor.is_at_end() {
            return Err(cursor.error(format!("missing > after <{name}")));
        }
        if cursor.starts_with("{") {
            // `{...spread}`
            let start = cursor.position();
            cursor.scan_braced()?;
            attributes.push(source[start..cursor.position()].to_owned());
            continue;
        }
        let start = cursor.position();
        cursor.take_while(|b| !b.is_ascii_whitespace() && b != b'=' && b != b'>' && b != b'/');
        if cursor.position() == start {
            // A stray `/` not followed by `>`: keep it as written.
            cursor.advance(1);
        }
        let attribute_name = &source[start..cursor.position()];
        let mut lookahead = cursor.clone();
        lookahead.skip_whitespace();
        if !lookahead.starts_with("=") {
            attributes.push(attribute_name.to_owned());
            continue;
        }
        cursor = lookahead;
        cursor.advance(1);
        cursor.skip_whitespace();
        let value_start = cursor.position();
        match cursor.peek_byte() {
            Some(quote @ (b'"' | b'\'')) => {
                cursor.advance(1);
                loop {
                    match cursor.peek_byte() {
                        None => return Err(cursor.error("unterminated attribute value")),
                        Some(b'{') => {
                            cursor.scan_braced()?;
                        }
                        Some(byte) if byte == quote => {
                            cursor.advance(1);
                            break;
                        }
                        Some(_) => cursor.advance_char(),
                    }
                }
            }
            Some(b'{') => {
                cursor.scan_braced()?;
            }
            _ => {
                cursor.take_while(|b| !b.is_ascii_whitespace() && b != b'>');
            }
        }
        attributes.push(format!(
            "{attribute_name}={}",
            &source[value_start..cursor.position()]
        ));
    };
    let end = cursor.position();
    debug_assert!(bytes[end - 1] == b'>');
    Ok((
        Token::Open {
            name,
            attributes,
            self_closing,
            raw: &source[at..end],
        },
        end,
    ))
}

// ---- printing ---------------------------------------------------------------------------

struct Printer {
    options: FormatOptions,
    out: String,
    /// Elements open around the current position (the host tag is depth 1).
    depth: usize,
    /// Inside `<pre>` or `<textarea>` (nested ones counted): everything as written.
    verbatim: usize,
    /// The last thing printed opened an element: the next line break starts its content.
    just_opened: bool,
    /// Where in `out` each token's output starts (and a last one for the end): what a range
    /// edit is cut from.
    marks: Vec<usize>,
}

impl Printer {
    fn new(options: &FormatOptions) -> Self {
        Self {
            options: *options,
            out: String::new(),
            depth: 0,
            verbatim: 0,
            just_opened: false,
            marks: Vec::new(),
        }
    }

    fn indent(&self, depth: usize) -> String {
        if self.options.use_tabs {
            "\t".repeat(depth)
        } else {
            " ".repeat(depth * self.options.indent_width)
        }
    }

    /// The current line's indentation, and how wide the line is so far.
    fn line(&self) -> (&str, usize) {
        let line = self.out.rsplit('\n').next().unwrap_or("");
        let indent = &line[..line.len() - line.trim_start().len()];
        let tab = self.options.indent_width.max(1);
        let width = line
            .chars()
            .map(|character| if character == '\t' { tab } else { 1 })
            .sum();
        (indent, width)
    }

    fn print(self, tokens: &[Token<'_>]) -> String {
        self.print_marked(tokens).0
    }

    fn print_marked(mut self, tokens: &[Token<'_>]) -> (String, Vec<usize>) {
        let mut top_level_gap: Option<usize> = None; // line breaks seen between top-level items
        for (index, token) in tokens.iter().enumerate() {
            self.marks.push(self.out.len());
            // At the top level (outside the host tag) nothing is template: lay items out.
            if self.depth == 0 && self.verbatim == 0 {
                if let Token::Space(space) = token {
                    top_level_gap = Some(top_level_gap.unwrap_or(0) + space.matches('\n').count());
                    continue;
                }
                if !self.out.is_empty() {
                    // Each item on its own line, a blank line between them kept (one at most).
                    let gap = top_level_gap.unwrap_or(0).clamp(1, 2);
                    self.out.push_str(&"\n".repeat(gap));
                }
                top_level_gap = None;
            }
            match token {
                Token::Space(space) => self.space(space, tokens.get(index + 1)),
                Token::Text(text) | Token::Comment(text) | Token::Body(text) => {
                    self.out.push_str(text);
                    self.just_opened = false;
                }
                Token::Open {
                    name,
                    attributes,
                    self_closing,
                    raw,
                } => self.open(name, attributes, *self_closing, raw),
                Token::Close { name, raw } => self.close(name, raw),
            }
        }
        self.marks.push(self.out.len());
        let trimmed = self.out.trim_end().len();
        self.out.truncate(trimmed);
        self.out.push('\n');
        (self.out, self.marks)
    }

    fn space(&mut self, space: &str, next: Option<&Token<'_>>) {
        let breaks = space.matches('\n').count();
        if self.verbatim > 0 || breaks == 0 {
            self.out.push_str(space);
            return;
        }
        let closing = matches!(next, Some(Token::Close { .. }));
        let lines = if self.just_opened || closing || next.is_none() {
            1
        } else {
            breaks.min(2)
        };
        let depth = if closing {
            self.depth.saturating_sub(1)
        } else {
            self.depth
        };
        self.out.push_str(&"\n".repeat(lines));
        self.out.push_str(&self.indent(depth));
        self.just_opened = false;
    }

    fn open(&mut self, name: &str, attributes: &[String], self_closing: bool, raw: &str) {
        if self.verbatim > 0 {
            self.out.push_str(raw);
        } else {
            self.tag(name, attributes, self_closing);
        }
        let void = VOID_ELEMENTS
            .iter()
            .any(|void| name.eq_ignore_ascii_case(void));
        let body = BODY_ELEMENTS
            .iter()
            .any(|body| name.eq_ignore_ascii_case(body));
        self.just_opened = false;
        if self_closing || void {
            return;
        }
        if VERBATIM_ELEMENTS
            .iter()
            .any(|verbatim| name.eq_ignore_ascii_case(verbatim))
        {
            self.verbatim += 1;
        }
        self.depth += 1;
        self.just_opened = !body;
    }

    fn close(&mut self, name: &str, raw: &str) {
        self.depth = self.depth.saturating_sub(1);
        let verbatim_end = VERBATIM_ELEMENTS
            .iter()
            .any(|verbatim| name.eq_ignore_ascii_case(verbatim));
        if verbatim_end && self.verbatim > 0 {
            self.verbatim -= 1;
        }
        if self.verbatim > 0 {
            self.out.push_str(raw);
        } else {
            self.out.push_str("</");
            self.out.push_str(name);
            self.out.push('>');
        }
        self.just_opened = false;
    }

    /// An opening tag on one line when it fits, else one attribute per line.
    fn tag(&mut self, name: &str, attributes: &[String], self_closing: bool) {
        let end = if self_closing { " />" } else { ">" };
        let one_line: String = std::iter::once(format!("<{name}"))
            .chain(attributes.iter().map(|attribute| format!(" {attribute}")))
            .chain(std::iter::once(end.to_owned()))
            .collect();
        let (indent, width) = self.line();
        let indent = indent.to_owned();
        // Only a tag that starts its line is broken up: one in the middle of inline markup
        // (`<label><input …> Hide done</label>`) reads better kept whole.
        let starts_line = width
            == indent
                .chars()
                .map(|c| {
                    if c == '\t' {
                        self.options.indent_width.max(1)
                    } else {
                        1
                    }
                })
                .sum::<usize>();
        let too_wide = width + one_line.chars().count() > self.options.print_width;
        let spans_lines = attributes.iter().any(|attribute| attribute.contains('\n'));
        if attributes.len() < 2 || !starts_line || !(too_wide || spans_lines) {
            self.out.push_str(&one_line);
            return;
        }
        let inner = format!("{indent}{}", self.indent(1));
        self.out.push('<');
        self.out.push_str(name);
        for attribute in attributes {
            self.out.push('\n');
            self.out.push_str(&inner);
            self.out.push_str(attribute);
        }
        self.out.push('\n');
        self.out.push_str(&indent);
        self.out.push_str(if self_closing { "/>" } else { ">" });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(source: &str) -> String {
        format(source, &FormatOptions::default()).unwrap()
    }

    #[test]
    fn indentation_follows_nesting() {
        let source =
            "<x-a>\n<p>\n        hi {name}\n</p>\n      <ul>\n<li>one</li>\n</ul>\n</x-a>\n";
        assert_eq!(
            fmt(source),
            "<x-a>\n  <p>\n    hi {name}\n  </p>\n  <ul>\n    <li>one</li>\n  </ul>\n</x-a>\n"
        );
    }

    #[test]
    fn whitespace_without_a_line_break_is_left_alone() {
        // Adding or removing it could move inline elements; the formatter does neither.
        let source = "<x-a><b>a</b><i>b</i>  <span>c</span></x-a>\n";
        assert_eq!(fmt(source), source);
    }

    #[test]
    fn one_blank_line_at_most_and_none_just_inside_an_element() {
        let source = "<x-a>\n\n\n  <p>a</p>\n\n\n\n  <p>b</p>\n\n</x-a>\n";
        assert_eq!(fmt(source), "<x-a>\n  <p>a</p>\n\n  <p>b</p>\n</x-a>\n");
    }

    #[test]
    fn tags_are_tidied_inside() {
        let source = "<x-a>\n  <input   type = \"text\"    value={v}/>\n  <br/>\n</x-a>\n";
        assert_eq!(
            fmt(source),
            "<x-a>\n  <input type=\"text\" value={v} />\n  <br />\n</x-a>\n"
        );
    }

    #[test]
    fn a_wide_tag_puts_one_attribute_per_line_and_a_narrow_one_comes_back() {
        let wide = "<x-a>\n  <button type=\"button\" class=\"primary large rounded\" aria-label=\"Add the item to the list\" onclick={() => add(item)}>Add</button>\n</x-a>\n";
        let expected = "<x-a>\n  <button\n    type=\"button\"\n    class=\"primary large rounded\"\n    aria-label=\"Add the item to the list\"\n    onclick={() => add(item)}\n  >Add</button>\n</x-a>\n";
        assert_eq!(fmt(wide), expected);
        let narrow = "<x-a>\n  <b\n    class=\"x\"\n    id=\"y\"\n  >z</b>\n</x-a>\n";
        assert_eq!(
            fmt(narrow),
            "<x-a>\n  <b class=\"x\" id=\"y\">z</b>\n</x-a>\n"
        );
    }

    #[test]
    fn a_wide_tag_inside_a_line_of_inline_markup_stays_whole() {
        let source = "<x-a>\n  <label><input type=\"checkbox\" class=\"hide-done\" checked={hideDone} onchange={(e) => (hideDone = e.target.checked)}> Hide done</label>\n</x-a>\n";
        assert_eq!(fmt(source), source);
    }

    #[test]
    fn expressions_comments_and_bodies_are_kept_as_written() {
        let source = "<!-- A counter.\n     Second line. -->\n<script>\n    let count   = 0\n</script>\n<style>\n.a{color:red}\n</style>\n<x-a>\n  <!--   note   -->\n  <p>{  count   + 1 }</p>\n  {count > 1 && <b>Don't   {count}</b>}\n</x-a>\n";
        assert_eq!(fmt(source), source);
    }

    #[test]
    fn pre_and_textarea_keep_their_whitespace() {
        let source =
            "<x-a>\n      <pre>\n  a\n      <b   x=\"1\">b</b>\n</pre>\n<p>\nx\n</p>\n</x-a>\n";
        assert_eq!(
            fmt(source),
            "<x-a>\n  <pre>\n  a\n      <b   x=\"1\">b</b>\n</pre>\n  <p>\n    x\n  </p>\n</x-a>\n"
        );
    }

    #[test]
    fn the_top_level_has_each_item_on_its_own_line() {
        let source = "\n\n<!-- doc -->\n<script>let a = 1</script>   <style>p{}</style>\n\n\n\n<x-a></x-a>\n\n\n";
        assert_eq!(
            fmt(source),
            "<!-- doc -->\n<script>let a = 1</script>\n<style>p{}</style>\n\n<x-a></x-a>\n"
        );
    }

    #[test]
    fn tabs_and_widths() {
        let options = FormatOptions {
            use_tabs: true,
            ..FormatOptions::default()
        };
        assert_eq!(
            format("<x-a>\n<p>\nx\n</p>\n</x-a>\n", &options).unwrap(),
            "<x-a>\n\t<p>\n\t\tx\n\t</p>\n</x-a>\n"
        );
    }

    #[test]
    fn line_endings_are_kept() {
        assert_eq!(
            fmt("<x-a>\r\n<p>a</p>\r\n</x-a>\r\n"),
            "<x-a>\r\n  <p>a</p>\r\n</x-a>\r\n"
        );
        // A formatted CRLF file is formatted: `--check` has nothing to say about it.
        let formatted = "<script>\r\n  let a = 1\r\n</script>\r\n<x-a>\r\n  <p>a</p>\r\n</x-a>\r\n";
        assert_eq!(fmt(formatted), formatted);
        // The first line break decides; a stray one of the other kind follows it.
        assert_eq!(
            fmt("<x-a>\r\n<p>a</p>\n</x-a>\r\n"),
            "<x-a>\r\n  <p>a</p>\r\n</x-a>\r\n"
        );
        assert_eq!(
            fmt("<x-a>\n<p>a</p>\r\n</x-a>\n"),
            "<x-a>\n  <p>a</p>\n</x-a>\n"
        );
    }

    #[test]
    fn a_file_that_opts_out_is_left_alone_even_when_it_does_not_parse() {
        for source in [
            "<!-- zubra-fmt-ignore -->\n<x-a>\n<p>\n</x-a>\n",
            "\n  <!--zubra-fmt-ignore-->\n<x-a>\n      <p>a</p>\n</x-a>\n",
        ] {
            assert!(is_ignored(source));
            assert_eq!(fmt(source), source);
            assert_eq!(
                format_range(source, 0, source.len(), &FormatOptions::default()).unwrap(),
                None
            );
        }
        // Only as the first thing in the file, and only that comment.
        for source in [
            "<x-a>\n<!-- zubra-fmt-ignore -->\n<p>a</p>\n</x-a>\n",
            "<!-- about zubra-fmt-ignore -->\n<x-a>\n<p>a</p>\n</x-a>\n",
        ] {
            assert!(!is_ignored(source));
            assert_ne!(fmt(source), source);
        }
    }

    #[test]
    fn it_refuses_what_does_not_parse_and_jsx() {
        let error = format("<x-a>\n  <p>\n</x-a>\n", &FormatOptions::default()).unwrap_err();
        assert!(error.message.contains("closing tag"), "{}", error.message);
        let jsx = "export default function XA() {\n  return <x-a></x-a>\n}\n";
        let error = format(jsx, &FormatOptions::default()).unwrap_err();
        assert!(error.message.contains("JSX"), "{}", error.message);
    }

    #[test]
    fn formatting_twice_changes_nothing() {
        for source in [
            "<x-a>\n<p>\n        hi {name}\n</p>\n</x-a>\n",
            "<x-a>\n  <button type=\"button\" class=\"primary large rounded\" aria-label=\"Add the item to the list\" onclick={() => add(item)}>Add</button>\n</x-a>\n",
            "<!-- a -->\n\n<x-a>\n\n\n<i>x</i>\n</x-a>",
        ] {
            let once = fmt(source);
            assert_eq!(fmt(&once), once);
        }
    }

    fn range(source: &str, from: &str, to: &str) -> Option<(String, RangeEdit)> {
        let start = source.find(from).unwrap();
        let end = source[start..].find(to).unwrap() + start + to.len();
        let edit = format_range(source, start, end, &FormatOptions::default()).unwrap()?;
        let mut out = source.to_owned();
        out.replace_range(edit.start..edit.end, &edit.text);
        Some((out, edit))
    }

    #[test]
    fn a_range_formats_the_lines_it_touches_and_nothing_else() {
        let source =
            "<x-a>\n<p>\n        hi {name}\n</p>\n      <ul>\n<li>one</li>\n</ul>\n</x-a>\n";
        let (out, _) = range(source, "<li>one", "</li>").unwrap();
        // Only the <li> line is re-indented, at its depth in the whole file.
        assert_eq!(
            out,
            "<x-a>\n<p>\n        hi {name}\n</p>\n      <ul>\n    <li>one</li>\n</ul>\n</x-a>\n"
        );
        let (out, _) = range(source, "hi {name}", "hi {name}").unwrap();
        assert_eq!(
            out,
            "<x-a>\n<p>\n    hi {name}\n</p>\n      <ul>\n<li>one</li>\n</ul>\n</x-a>\n"
        );
    }

    #[test]
    fn the_range_of_everything_is_the_whole_format() {
        let source = "<!-- a -->\n\n\n<script>let a = 1</script>   <style>p{}</style>\n<x-a>\n<p>\n  <b   x = \"1\">hi</b>\n</p>\n</x-a>\n";
        let edit = format_range(source, 0, source.len(), &FormatOptions::default())
            .unwrap()
            .unwrap();
        let mut out = source.to_owned();
        out.replace_range(edit.start..edit.end, &edit.text);
        assert_eq!(
            format(&out, &FormatOptions::default()).unwrap(),
            format(source, &FormatOptions::default()).unwrap()
        );
    }

    #[test]
    fn a_formatted_range_has_no_edit_and_a_cursor_formats_its_line() {
        let source = "<x-a>\n  <p>a</p>\n</x-a>\n";
        assert_eq!(range(source, "<p>a</p>", "</p>"), None);
        let ragged = "<x-a>\n<p>a</p>\n</x-a>\n";
        let at = ragged.find("a</p>").unwrap();
        let edit = format_range(ragged, at, at, &FormatOptions::default())
            .unwrap()
            .unwrap();
        assert_eq!(edit.text, "\n  <p>a</p>");
        // A selection that ends at the start of a line leaves that line alone; one that reaches
        // into it formats it.
        let space = ragged.find("\n<p>").unwrap();
        assert!(
            format_range(ragged, space, space + 1, &FormatOptions::default())
                .unwrap()
                .is_none()
        );
        assert!(
            format_range(ragged, space, space + 2, &FormatOptions::default())
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_range_in_a_crlf_file_is_in_the_file_s_own_offsets() {
        let source = "<x-a>\r\n<p>\r\nx\r\n</p>\r\n<i>y</i>\r\n</x-a>\r\n";
        let start = source.find("x\r\n").unwrap();
        let edit = format_range(source, start, start + 1, &FormatOptions::default())
            .unwrap()
            .unwrap();
        let mut out = source.to_owned();
        out.replace_range(edit.start..edit.end, &edit.text);
        // The edit's line breaks are the file's: no bare LF in a CRLF file.
        assert_eq!(edit.text, "\r\n    x");
        assert_eq!(
            out,
            "<x-a>\r\n<p>\r\n    x\r\n</p>\r\n<i>y</i>\r\n</x-a>\r\n"
        );
    }

    #[test]
    fn an_offset_inside_a_character_is_that_character_s_start() {
        // "é" is two bytes and "日本" three each: every byte offset in the file must be safe.
        let source = "<x-a>\n<p>caf\u{e9} \u{65e5}\u{672c}</p>\n      <i>\u{1f600}</i>\n</x-a>\n";
        let whole = format(source, &FormatOptions::default()).unwrap();
        for start in 0..=source.len() {
            for end in [start, (start + 1).min(source.len()), source.len()] {
                let edit = format_range(source, start, end, &FormatOptions::default()).unwrap();
                if let Some(edit) = edit {
                    let mut out = source.to_owned();
                    out.replace_range(edit.start..edit.end, &edit.text);
                    assert!(
                        whole.contains(edit.text.trim_start_matches('\n')),
                        "{start}..{end}"
                    );
                }
            }
        }
        // And past the end.
        assert!(format_range(
            source,
            source.len() + 9,
            source.len() + 99,
            &FormatOptions::default()
        )
        .is_ok());
    }

    #[test]
    fn a_range_refuses_what_the_formatter_refuses() {
        let broken = "<x-a>\n  <p>\n</x-a>\n";
        assert!(format_range(broken, 0, 3, &FormatOptions::default()).is_err());
    }
}
