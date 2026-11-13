//! Regular expressions and URI encoding for the server's evaluator (`pure.rs`).
//!
//! A regular expression literal is evaluated with `regress`, an ECMAScript regex engine, matching on
//! the string's UTF-16 code units as a browser does: without `u` each half of a surrogate pair is a
//! character of its own (`/./` takes half an emoji), with `u` the pair is one. Only stateless uses are evaluated: `replace`, `replaceAll`, `split`, `match` with `g`,
//! `search` and `test` without `g`. `lastIndex`, sticky (`y`) matching and a non-global `match` (whose
//! array carries `index` and `groups`) are left for the browser.
//!
//! A backtracking engine can take exponential time on some patterns, and a build must never hang, so
//! a pattern is read before it is used: a repeated part that holds another repeat or a `|` (the shape
//! of `(a+)+` and `(a|a)*`) is left for the browser, and the text a pattern may search is limited by
//! how many repeats it has, so the work stays under [`WORK`] steps.

use oxc_allocator::Allocator;
use oxc_regular_expression::ast::{Disjunction, Term};
use oxc_regular_expression::{LiteralParser, Options};

/// About how many steps a pattern may take over its text: `length ^ (repeats + 1)` stays under this.
const WORK: f64 = 2.0e7;
/// The longest text any pattern searches on the server.
const MAX_UNITS: usize = 10_000;

/// A compiled regular expression literal, and what the evaluator needs to know about it.
#[derive(Debug)]
pub struct JsRegExp {
    regex: regress::Regex,
    pub global: bool,
    unicode: bool,
    /// Capturing groups, in order; a named one has its name.
    pub groups: Vec<Option<String>>,
    /// The longest text this pattern may search on the server.
    max_units: usize,
}

/// The pattern and flags of `/pattern/flags`, or `None` when the server leaves it for the browser.
pub fn compile(pattern: &str, flags: &str) -> Option<JsRegExp> {
    let mut seen = String::new();
    for flag in flags.chars() {
        // `y` makes matching depend on `lastIndex`; `d` only adds `indices` to `exec`'s result.
        if !"dgimsuv".contains(flag) || seen.contains(flag) {
            return None;
        }
        seen.push(flag);
    }
    if seen.contains('u') && seen.contains('v') {
        return None;
    }
    let allocator = Allocator::default();
    let parsed = LiteralParser::new(&allocator, pattern, Some(flags), Options::default())
        .parse()
        .ok()?;
    let mut shape = Shape::default();
    shape.disjunction(&parsed.body, false);
    if shape.dangerous {
        return None;
    }
    let max_units = (WORK.powf(1.0 / (shape.repeats as f64 + 1.0)) as usize).min(MAX_UNITS);
    let regex = regress::Regex::with_flags(pattern, regress::Flags::from(flags)).ok()?;
    Some(JsRegExp {
        regex,
        global: seen.contains('g'),
        unicode: seen.contains('u') || seen.contains('v'),
        groups: shape.groups,
        max_units,
    })
}

/// What a pattern's shape says about its cost, and its groups.
#[derive(Default)]
struct Shape {
    /// Quantifiers that can repeat (`*`, `+`, `{n,}`, `{n,m}` with m > 1).
    repeats: u32,
    /// A repeated part holds a quantifier or an alternation, or the pattern has a backreference.
    dangerous: bool,
    groups: Vec<Option<String>>,
}

impl Shape {
    fn disjunction(&mut self, disjunction: &Disjunction<'_>, repeated: bool) {
        if repeated && disjunction.body.len() > 1 {
            self.dangerous = true;
        }
        for alternative in &disjunction.body {
            for term in &alternative.body {
                self.term(term, repeated);
            }
        }
    }

    fn term(&mut self, term: &Term<'_>, repeated: bool) {
        match term {
            Term::Quantifier(quantifier) => {
                if repeated {
                    self.dangerous = true;
                }
                let repeats = quantifier.max.is_none_or(|max| max > 1);
                if repeats {
                    self.repeats += 1;
                }
                self.term(&quantifier.body, repeated || repeats);
            }
            Term::CapturingGroup(group) => {
                self.groups
                    .push(group.name.as_ref().map(|name| name.to_string()));
                self.disjunction(&group.body, repeated);
            }
            Term::IgnoreGroup(group) => self.disjunction(&group.body, repeated),
            Term::LookAroundAssertion(assertion) => self.disjunction(&assertion.body, repeated),
            // A backreference can make a pattern match work grow with what an earlier group took.
            Term::IndexedReference(_) | Term::NamedReference(_) => self.dangerous = true,
            _ => {}
        }
    }
}

/// One match: where it is and what each group took, in code units.
pub struct Found {
    pub start: usize,
    pub end: usize,
    pub captures: Vec<Option<(usize, usize)>>,
}

impl JsRegExp {
    /// Whether the server may search this text with this pattern.
    pub fn allows(&self, units: &[u16]) -> bool {
        units.len() <= self.max_units
    }

    /// The first match at or after `from`.
    pub fn find(&self, units: &[u16], from: usize) -> Option<Found> {
        // With `u` (or `v`) a surrogate pair is one character; without, JavaScript sees each half on
        // its own (`/./` takes half an emoji), which is regress's UCS-2 input.
        let found = if self.unicode {
            self.regex.find_from_utf16(units, from).next()?
        } else {
            self.regex.find_from_ucs2(units, from).next()?
        };
        Some(Found {
            start: found.range.start,
            end: found.range.end,
            captures: found
                .captures
                .iter()
                .map(|group| group.as_ref().map(|range| (range.start, range.end)))
                .collect(),
        })
    }

    /// Every match, the way a global `replace` or `match` walks them: after an empty match the
    /// search moves on one character (one code point with `u`), as `AdvanceStringIndex` does.
    pub fn find_all(&self, units: &[u16]) -> Vec<Found> {
        let mut all = Vec::new();
        let mut from = 0;
        while from <= units.len() {
            let Some(found) = self.find(units, from) else {
                break;
            };
            from = if found.end == found.start {
                self.advance(units, found.end)
            } else {
                found.end
            };
            all.push(found);
        }
        all
    }

    pub fn advance(&self, units: &[u16], at: usize) -> usize {
        let pair = self.unicode
            && at + 1 < units.len()
            && (0xD800..0xDC00).contains(&units[at])
            && (0xDC00..0xE000).contains(&units[at + 1]);
        at + if pair { 2 } else { 1 }
    }
}

/// `GetSubstitution`: a replacement string with `$$`, `$&`, `` $` ``, `$'`, `$1`–`$99` and `$<name>`.
pub fn substitute(
    template: &[u16],
    units: &[u16],
    found: &Found,
    groups: &[Option<String>],
) -> Vec<u16> {
    let capture = |index: usize| -> &[u16] {
        match found.captures.get(index).copied().flatten() {
            Some((start, end)) => &units[start..end],
            None => &[],
        }
    };
    let digit = |unit: u16| {
        (u16::from(b'0')..=u16::from(b'9'))
            .contains(&unit)
            .then(|| usize::from(unit - u16::from(b'0')))
    };
    let count = found.captures.len();
    let mut out = Vec::with_capacity(template.len());
    let mut at = 0;
    while at < template.len() {
        let unit = template[at];
        if unit != u16::from(b'$') || at + 1 >= template.len() {
            out.push(unit);
            at += 1;
            continue;
        }
        let next = template[at + 1];
        match next {
            n if n == u16::from(b'$') => {
                out.push(n);
                at += 2;
            }
            n if n == u16::from(b'&') => {
                out.extend_from_slice(&units[found.start..found.end]);
                at += 2;
            }
            n if n == u16::from(b'`') => {
                out.extend_from_slice(&units[..found.start]);
                at += 2;
            }
            n if n == u16::from(b'\'') => {
                out.extend_from_slice(&units[found.end.min(units.len())..]);
                at += 2;
            }
            n if n == u16::from(b'<') => {
                let close = template[at + 2..]
                    .iter()
                    .position(|&unit| unit == u16::from(b'>'));
                match close {
                    Some(close) if groups.iter().any(Option::is_some) => {
                        let name = String::from_utf16_lossy(&template[at + 2..at + 2 + close]);
                        if let Some(index) = groups
                            .iter()
                            .position(|group| group.as_deref() == Some(name.as_str()))
                        {
                            out.extend_from_slice(capture(index));
                        }
                        at += close + 3;
                    }
                    _ => {
                        out.extend_from_slice(&template[at..at + 2]);
                        at += 2;
                    }
                }
            }
            n => match digit(n) {
                Some(first) => {
                    let second = template.get(at + 2).copied().and_then(digit);
                    match second.map(|second| first * 10 + second) {
                        Some(both) if (1..=count).contains(&both) => {
                            out.extend_from_slice(capture(both - 1));
                            at += 3;
                        }
                        _ if (1..=count).contains(&first) => {
                            out.extend_from_slice(capture(first - 1));
                            at += 2;
                        }
                        _ => {
                            out.push(unit);
                            at += 1;
                        }
                    }
                }
                None => {
                    out.push(unit);
                    at += 1;
                }
            },
        }
    }
    out
}

// ----- URI encoding (ECMAScript's Encode and Decode) ------------------------------------------

const URI_UNRESERVED: &str = "-_.!~*'()";
const URI_RESERVED: &str = ";/?:@&=+$,#";

/// `encodeURIComponent` (`component`) or `encodeURI`. A Rust string has no lone surrogates, so
/// nothing here throws.
pub fn encode_uri(text: &str, component: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        let keep = character.is_ascii_alphanumeric()
            || URI_UNRESERVED.contains(character)
            || (!component && URI_RESERVED.contains(character));
        if keep {
            out.push(character);
        } else {
            let mut bytes = [0; 4];
            for byte in character.encode_utf8(&mut bytes).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

/// `decodeURIComponent` (`component`) or `decodeURI`; `None` where the browser throws `URIError`.
/// `decodeURI` keeps an escape for a reserved character (and `#`) as it was.
pub fn decode_uri(text: &str, component: bool) -> Option<String> {
    let bytes = text.as_bytes();
    let hex = |at: usize| -> Option<u8> {
        let pair = bytes.get(at + 1..at + 3)?;
        u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
    };
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'%' {
            let character = text[at..].chars().next()?;
            out.push(character);
            at += character.len_utf8();
            continue;
        }
        let first = hex(at)?;
        let length = match first {
            0x00..=0x7F => 1,
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut sequence = vec![first];
        for index in 1..length {
            let position = at + index * 3;
            if bytes.get(position) != Some(&b'%') {
                return None;
            }
            let byte = hex(position)?;
            if byte & 0xC0 != 0x80 {
                return None;
            }
            sequence.push(byte);
        }
        // Rust's UTF-8 check refuses overlong forms and surrogates, as the specification does.
        let decoded = std::str::from_utf8(&sequence).ok()?;
        if !component && length == 1 && URI_RESERVED.contains(decoded) {
            out.push_str(&text[at..at + 3]);
        } else {
            out.push_str(decoded);
        }
        at += length * 3;
    }
    Some(out)
}
