//! Code moved within a script (a field's value into the constructor, a decorator into its call):
//! the text it's moved as. It's the code's JavaScript with every rewrite inside it applied (a
//! namespace's `N.x`, a nested class's own lowering), on one line, so the lines it leaves and
//! the lines it joins keep their count. Putting code on one line is done the safe way: comments
//! go, a statement that ended at a line break gets its `;`, a template literal's line break is
//! written `\n`, and a string's line continuation is dropped.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    AccessorProperty, PropertyDefinition, Statement, StringLiteral, TaggedTemplateExpression,
    TemplateLiteral,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span as Range};

/// A copy: inserted at the offset, as `prefix` + the range's code + `suffix`.
pub(super) type Copy = (u32, String, Range, String);

/// The script's edits, to work out moved code from.
pub(super) struct Edits<'e> {
    /// The script with its types blanked.
    pub blanked: &'e str,
    pub blanks: &'e [Range],
    pub replacements: &'e [(Range, String)],
    pub copies: &'e [Copy],
}

impl Edits<'_> {
    /// The text copy `index` inserts, or the offset and message of why it can't be moved.
    pub fn copy_text(&self, index: usize) -> Result<String, (u32, String)> {
        self.copy_at_depth(index, 0)
    }

    fn copy_at_depth(&self, index: usize, depth: usize) -> Result<String, (u32, String)> {
        let (_, prefix, range, suffix) = &self.copies[index];
        if range.start == range.end {
            return Ok(format!("{prefix}{suffix}"));
        }
        let code = self.render(*range, index, depth)?;
        let line = one_line(&code).map_err(|message| (range.start, message))?;
        Ok(format!("{prefix}{line}{suffix}"))
    }

    /// The range's JavaScript (with the edits inside it), on one line.
    pub fn code(&self, range: Range) -> Result<String, (u32, String)> {
        let code = self.render(range, usize::MAX, 0)?;
        one_line(&code).map_err(|message| (range.start, message))
    }

    /// The range's JavaScript, with the edits inside it applied.
    fn render(&self, range: Range, own: usize, depth: usize) -> Result<String, (u32, String)> {
        let mut items: Vec<(Range, String)> = self
            .replacements
            .iter()
            .filter(|(edit, _)| {
                range.start <= edit.start && edit.end <= range.end && *edit != range
            })
            .cloned()
            .collect();
        // Copies inserted inside it (a class in a moved value lowers into copies of its own).
        if depth < 16 {
            for (index, (at, _, source, _)) in self.copies.iter().enumerate() {
                if index != own && range.start <= *at && *at <= range.end && *source != range {
                    let text = self.copy_at_depth(index, depth + 1)?;
                    items.push((Range::new(*at, *at), text));
                }
            }
        }
        let whole: Vec<Range> = items
            .iter()
            .map(|(edit, _)| *edit)
            .filter(|edit| edit.end > edit.start)
            .collect();
        items.retain(|(edit, _)| {
            let inside = |outer: &Range| {
                if edit.start == edit.end {
                    outer.start < edit.start && edit.start < outer.end
                } else {
                    outer.start <= edit.start && edit.end <= outer.end && outer != edit
                }
            };
            !self.blanks.iter().any(inside) && !whole.iter().any(inside)
        });
        // Two rewrites of the same name (a namespace's and an enum's own): the later one.
        let mut deduped: Vec<(Range, String)> = Vec::new();
        for (edit, text) in items {
            if edit.start < edit.end {
                if let Some(same) = deduped.iter_mut().find(|(other, _)| *other == edit) {
                    same.1 = text;
                    continue;
                }
            }
            deduped.push((edit, text));
        }
        let mut items = deduped;
        items.sort_by_key(|(edit, _)| (edit.start, edit.end));
        let mut out = String::new();
        let mut at = range.start as usize;
        for (edit, text) in &items {
            out.push_str(&self.blanked[at..edit.start as usize]);
            out.push_str(text);
            at = edit.end as usize;
        }
        out.push_str(&self.blanked[at..range.end as usize]);
        Ok(out)
    }
}

/// An expression's code on one line, meaning the same.
pub(super) fn one_line(code: &str) -> Result<String, String> {
    if !code.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return Ok(code.to_owned());
    }
    // Parsed where moved code can be: in a subclass's constructor (`super`, `new.target`),
    // inside parentheses (with a line break before the `)` to end a trailing `//` comment).
    const BEFORE: &str = "(class extends Object { constructor() { super(); (";
    const AFTER: &str = "\n); } });";
    let wrapped = format!("{BEFORE}{code}{AFTER}");
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &wrapped, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        // Not JavaScript on its own (it can't be checked): line breaks become spaces.
        return Ok(code.replace(['\n', '\r'], " "));
    }
    let mut finder = Breaks {
        source: &wrapped,
        edits: Vec::new(),
        error: None,
    };
    for comment in &parsed.program.comments {
        finder
            .edits
            .push((comment.span.start, comment.span.end, " ".to_owned()));
    }
    finder.visit_program(&parsed.program);
    if let Some(error) = finder.error {
        return Err(error);
    }
    let (start, end) = (BEFORE.len(), BEFORE.len() + code.len());
    let mut edits: Vec<(usize, usize, String)> = finder
        .edits
        .into_iter()
        .map(|(from, to, text)| (from as usize, to as usize, text))
        .filter(|(from, to, _)| start <= *from && *to <= end)
        .collect();
    edits.sort_by_key(|(from, to, _)| (*from, *to));
    let mut out = String::new();
    let mut at = start;
    for (from, to, text) in edits {
        if from < at {
            continue;
        }
        out.push_str(&wrapped[at..from]);
        out.push_str(&text);
        at = to;
    }
    out.push_str(&wrapped[at..end]);
    Ok(out.replace("\r\n", " ").replace(['\n', '\r'], " "))
}

/// What has to change for code to be on one line: `(start, end, text)` in the wrapped source.
struct Breaks<'s> {
    source: &'s str,
    edits: Vec<(u32, u32, String)>,
    error: Option<String>,
}

impl Breaks<'_> {
    /// A statement or class field that ended at a line break, without `;`.
    fn terminate(&mut self, span: Range) {
        if !self.source[span.start as usize..span.end as usize]
            .trim_end()
            .ends_with(';')
        {
            self.edits.push((span.end, span.end, ";".to_owned()));
        }
    }
}

impl<'a> Visit<'a> for Breaks<'_> {
    fn visit_statement(&mut self, it: &Statement<'a>) {
        if matches!(
            it,
            Statement::ExpressionStatement(_)
                | Statement::VariableDeclaration(_)
                | Statement::ReturnStatement(_)
                | Statement::ThrowStatement(_)
                | Statement::BreakStatement(_)
                | Statement::ContinueStatement(_)
                | Statement::DoWhileStatement(_)
                | Statement::DebuggerStatement(_)
        ) {
            self.terminate(it.span());
        }
        walk::walk_statement(self, it);
    }

    fn visit_property_definition(&mut self, it: &PropertyDefinition<'a>) {
        self.terminate(it.span);
        walk::walk_property_definition(self, it);
    }

    fn visit_accessor_property(&mut self, it: &AccessorProperty<'a>) {
        self.terminate(it.span);
        walk::walk_accessor_property(self, it);
    }

    fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
        // A line break in the text is the same string written `\n`.
        for quasi in &it.quasis {
            let text = &self.source[quasi.span.start as usize..quasi.span.end as usize];
            if text.contains(['\n', '\r']) {
                let escaped = text.replace("\r\n", "\\n").replace(['\n', '\r'], "\\n");
                self.edits.push((quasi.span.start, quasi.span.end, escaped));
            }
        }
        walk::walk_template_literal(self, it);
    }

    fn visit_tagged_template_expression(&mut self, it: &TaggedTemplateExpression<'a>) {
        // The tag sees the raw text, so its line breaks can't be rewritten.
        let text = &self.source[it.quasi.span.start as usize..it.quasi.span.end as usize];
        if text.contains(['\n', '\r']) && self.error.is_none() {
            self.error = Some(
                "a tagged template over more than one line can't be moved onto one line here"
                    .to_owned(),
            );
        }
        walk::walk_tagged_template_expression(self, it);
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        // A line continuation (`\` and a line break) adds nothing to the string.
        let text = &self.source[it.span.start as usize..it.span.end as usize];
        if text.contains(['\n', '\r']) {
            let joined = text
                .replace("\\\r\n", "")
                .replace("\\\n", "")
                .replace("\\\r", "");
            self.edits.push((it.span.start, it.span.end, joined));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::one_line;

    #[test]
    fn code_on_one_line_means_the_same() {
        for (code, line) in [
            ("[1, // one\n 2]", "[1,    2]"),
            ("`a\nb`", "`a\\nb`"),
            ("\"c\\\nd\"", "\"cd\""),
            (
                "() => {\n  a = 1\n  b = 2\n}",
                "() => {   a = 1;   b = 2; }",
            ),
            ("() => {\n  return\n  1\n}", "() => {   return;   1; }"),
            ("{ a: 1, /* x\ny */ b }", "{ a: 1,   b }"),
        ] {
            assert_eq!(one_line(code).unwrap(), line, "{code}");
        }
        assert!(one_line("tag`a\nb`").is_err());
        assert_eq!(one_line("tag`a`").unwrap(), "tag`a`");
    }
}
