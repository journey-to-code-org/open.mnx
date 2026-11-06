use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Span {
    pub line: usize,
    pub column: usize,
}

impl Span {
    pub const fn new(line: usize, column: usize) -> Self {
        Self { line, column }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub span: Span,
    pub message: String,
    /// An optional suggestion, e.g. "did you mean `title`?".
    pub help: Option<String>,
    /// When the error is in an imported component: that file's path and source.
    pub file: Option<(String, String)>,
}

impl Diagnostic {
    pub fn new(span: Span, message: impl Into<String>) -> Self {
        Self {
            span,
            message: message.into(),
            help: None,
            file: None,
        }
    }

    /// Mark the error as being in another file (an imported component). The innermost file wins.
    pub fn in_file(mut self, path: &str, source: &str) -> Self {
        self.file
            .get_or_insert_with(|| (path.to_owned(), source.to_owned()));
        self
    }

    /// Render for a terminal, using the imported component's source when the error is there.
    pub fn render_in(&self, source: &str, path: &str) -> String {
        match &self.file {
            Some((file, file_source)) => self.render(file_source, file),
            None => self.render(source, path),
        }
    }

    pub fn with_help(mut self, help: impl Into<String>) -> Self {
        self.help = Some(help.into());
        self
    }

    /// Render for a terminal, with the offending source line and a caret:
    ///
    /// ```text
    /// error: unknown reference `titel`
    ///  --> header.mnx:11:11
    ///    |
    /// 11 |       <h1>{titel}</h1>
    ///    |           ^
    ///    = help: did you mean `title`?
    /// ```
    pub fn render(&self, source: &str, path: &str) -> String {
        self.render_as("error", source, path)
    }

    /// The same, as a warning.
    pub fn render_warning(&self, source: &str, path: &str) -> String {
        self.render_as("warning", source, path)
    }

    fn render_as(&self, severity: &str, source: &str, path: &str) -> String {
        let mut output = format!(
            "{severity}: {}\n --> {path}:{}:{}\n",
            self.message, self.span.line, self.span.column
        );
        let normalized = source.replace("\r\n", "\n");
        if let Some(line) = normalized.lines().nth(self.span.line.saturating_sub(1)) {
            let number = self.span.line.to_string();
            let gutter = " ".repeat(number.len());
            // Columns count characters; tabs keep their width so the caret lines up.
            let lead: String = line
                .chars()
                .take(self.span.column.saturating_sub(1))
                .map(|character| if character == '\t' { '\t' } else { ' ' })
                .collect();
            output.push_str(&format!(
                "{gutter} |\n{number} | {line}\n{gutter} | {lead}^\n"
            ));
            if let Some(help) = &self.help {
                output.push_str(&format!("{gutter} = help: {help}\n"));
            }
        } else if let Some(help) = &self.help {
            output.push_str(&format!(" = help: {help}\n"));
        }
        output
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}:{}: {}",
            self.span.line, self.span.column, self.message
        )?;
        if let Some(help) = &self.help {
            write!(formatter, " (help: {help})")?;
        }
        Ok(())
    }
}

impl std::error::Error for Diagnostic {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_source_line_with_caret_and_help() {
        let source = "<p>\n  <h1>{titel}</h1>\n</p>";
        let diagnostic = Diagnostic::new(Span::new(2, 8), "unknown reference `titel`")
            .with_help("did you mean `title`?");
        assert_eq!(
            diagnostic.render(source, "x.mnx"),
            "error: unknown reference `titel`\n --> x.mnx:2:8\n  |\n2 |   <h1>{titel}</h1>\n  |        ^\n  = help: did you mean `title`?\n"
        );
    }
}
