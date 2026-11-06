//! The events a component fires, inferred from its `emit("name", detail)` calls.
//!
//! Nothing is declared by hand: each call adds its event, and the detail's type comes from the
//! shape of the value passed (the union, when calls differ). JSDoc-style `@fires name - text`
//! lines in the component's description document events; when there are any, they must match
//! the events the code fires exactly, so the documentation can't drift.

use crate::{
    ast::ComponentAst,
    diagnostic::Diagnostic,
    script::{is_event_name, union},
};

#[derive(Clone, Debug, PartialEq)]
pub struct EventInterface {
    pub name: String,
    /// TypeScript type of `event.detail`.
    pub detail: String,
    pub description: Option<String>,
}

/// The component's events, and its description without the `@fires` lines.
pub fn events(
    component: &ComponentAst,
) -> Result<(Vec<EventInterface>, Option<String>), Diagnostic> {
    let mut events: Vec<EventInterface> = Vec::new();
    for emit in &component.script.emits {
        match events.iter_mut().find(|event| event.name == emit.name) {
            Some(event) => event.detail = union([event.detail.clone(), emit.detail.clone()]),
            None => events.push(EventInterface {
                name: emit.name.clone(),
                detail: emit.detail.clone(),
                description: None,
            }),
        }
    }

    let Some(description) = &component.description else {
        return Ok((events, None));
    };
    let mut documented = Vec::new();
    let mut text = Vec::new();
    for line in description.lines() {
        let Some(rest) = line.trim_start().strip_prefix("@fires") else {
            text.push(line);
            continue;
        };
        let rest = rest.trim();
        let (name, about) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        let about = about.trim().trim_start_matches('-').trim();
        if !is_event_name(name) {
            return Err(Diagnostic::new(
                component.tag_span,
                format!("`@fires {name}`: event names are lowercase letters and digits"),
            ));
        }
        let Some(event) = events.iter_mut().find(|event| event.name == name) else {
            let error = Diagnostic::new(
                component.tag_span,
                format!("the description documents `@fires {name}`, but the script never emits `{name}`"),
            );
            let names: Vec<&str> = events.iter().map(|event| event.name.as_str()).collect();
            return Err(crate::validate::with_suggestion(error, name, &names));
        };
        documented.push(name.to_owned());
        if !about.is_empty() {
            event.description = Some(about.to_owned());
        }
    }
    if !documented.is_empty() {
        if let Some(missing) = events
            .iter()
            .find(|event| !documented.contains(&event.name))
        {
            let span = component
                .script
                .emits
                .iter()
                .find(|emit| emit.name == missing.name)
                .map_or(component.tag_span, |emit| emit.span);
            return Err(Diagnostic::new(
                span,
                format!(
                    "`{}` is emitted but not documented; add `@fires {} - …` to the description",
                    missing.name, missing.name
                ),
            ));
        }
    }
    let description = text.join("\n").trim().to_owned();
    Ok((events, (!description.is_empty()).then_some(description)))
}
