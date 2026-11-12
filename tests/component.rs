//! `zubra::Component`: a component and its imports held in memory, rendered from Rust.

use serde_json::json;
use zubra::Component;

const BADGE: &str =
    "<style>span { color: red; }</style>\n<x-badge label=\"none\"><span>{label}</span></x-badge>\n";
const CARD: &str = "<script>\n  import './badge.zb'\n</script>\n<style>section { padding: 1rem; }</style>\n<x-card title=\"Untitled\"><section><h2>{title}</h2><x-badge label={title}></x-badge></section></x-card>\n";

fn card() -> Component {
    Component::new(
        "/app/components/card.zb",
        CARD,
        &[("/app/components/badge.zb", BADGE)],
    )
}

#[test]
fn renders_with_props_and_resolves_imports_from_memory() {
    let html = card().render(&json!({ "title": "Hello" })).unwrap();
    assert!(html.contains("<h2>Hello</h2>"), "{html}");
    // The imported component rendered inside, with the prop passed down.
    assert!(html.contains("<span>Hello</span>"), "{html}");
}

#[test]
fn props_are_escaped() {
    let html = card().render(&json!({ "title": "<b>&" })).unwrap();
    assert!(html.contains("<h2>&lt;b&gt;&amp;</h2>"), "{html}");
}

#[test]
fn css_covers_the_component_and_its_imports() {
    let css = card().css().unwrap();
    assert!(css.contains("x-badge") && css.contains("x-card"), "{css}");
    assert!(
        css.contains("padding: 1rem") && css.contains("color: red"),
        "{css}"
    );
}

#[test]
fn module_imports_the_runtime_and_its_children_by_tag() {
    let module = card().module().unwrap();
    assert!(module.contains("from \"@zubra/runtime\""), "{module}");
    assert!(
        module.contains("./badge.zb.js") || module.contains("badge"),
        "{module}"
    );
    let custom = card().module_for("/vendor/zubra/index.js").unwrap();
    assert!(
        custom.contains("/vendor/zubra/index.js") && !custom.contains("\"@zubra/runtime\""),
        "{custom}"
    );
}

#[test]
fn tag_comes_from_the_source() {
    assert_eq!(card().tag().unwrap(), "x-card");
}

#[test]
fn a_missing_import_is_an_error_naming_it() {
    let component = Component::new("/app/card.zb", CARD, &[]);
    let error = component.check().unwrap_err().to_string();
    assert!(error.contains("badge.zb"), "{error}");
}

#[test]
fn relative_specifiers_resolve_against_the_importer() {
    // card.zb is in a subfolder and imports ../shared/badge.zb.
    let source = CARD.replace("./badge.zb", "../shared/badge.zb");
    let component = Component::new(
        "/app/ui/card.zb",
        &source,
        &[("/app/shared/badge.zb", BADGE)],
    );
    assert!(component.check().is_ok());
    // Paths are compared lexically, so a non-normal path finds it too.
    let component = Component::new(
        "/app/ui/./card.zb",
        &source,
        &[("/app/x/../shared/badge.zb", BADGE)],
    );
    assert!(component.check().is_ok());
}

#[test]
fn slots_take_html_the_server_already_rendered() {
    let source = "<x-box><div><zb-slot></zb-slot></div></x-box>\n";
    let component = Component::new("/app/box.zb", source, &[]);
    let html = component
        .render_with(
            &json!({}),
            &json!({ "default": "<p>{kept}</p>" }),
            zubra::SlotSource::Html,
        )
        .unwrap();
    assert!(html.contains("<p>{kept}</p>"), "{html}");
}

#[test]
fn matches_the_request_api_for_the_same_files() {
    let files = json!({ "/app/components/card.zb": CARD, "/app/components/badge.zb": BADGE });
    let reply: serde_json::Value = serde_json::from_str(&zubra::handle_request(
        &json!({ "command": "compile", "emit": "html", "path": "/app/components/card.zb",
                 "files": files, "props": { "title": "Hi" }, "partial": true, "slotSource": "html" })
        .to_string(),
    ))
    .unwrap();
    assert_eq!(
        reply["output"],
        card().render(&json!({ "title": "Hi" })).unwrap()
    );
}

#[test]
fn what_only_the_browser_computes_is_left_for_it() {
    // `Date.now()` differs per request, so a server can't write it: the element fills it in.
    let source = "<script>const now = Date.now()</script>\n<x-now a=\"x\"><p>{a}</p><p title={now}>{now}</p></x-now>\n";
    let component = Component::new("/app/now.zb", source, &[]);
    let html = component.render(&json!({})).unwrap();
    assert!(
        html.contains("<p>x</p>") && html.contains("<p></p>"),
        "{html}"
    );
    // Without partial rendering the same component is refused.
    let strict = zubra::compile_html_from(
        source,
        "/app/now.zb",
        "{}",
        "{}",
        zubra::SlotSource::Html,
        &|_, _| Err(String::new()),
    );
    assert!(strict.is_err());
}

#[test]
fn a_bare_import_is_a_packages_component_given_under_its_specifier() {
    // `@acme/kit/badge.zb` is keyed by its specifier, and its own relative imports under it.
    let source = CARD.replace("./badge.zb", "@acme/kit/badge.zb");
    let badge = "<script>\n  import './dot.zb'\n</script>\n<x-badge label=\"none\"><span>{label}</span><kit-dot></kit-dot></x-badge>\n";
    let dot = "<kit-dot><i></i></kit-dot>";
    let component = Component::new(
        "/app/card.zb",
        &source,
        &[("@acme/kit/badge.zb", badge), ("@acme/kit/dot.zb", dot)],
    );
    component.check().unwrap();
    assert!(component
        .module()
        .unwrap()
        .contains("\"@acme/kit/badge.js\""));
    // Missing: the reason, at the import.
    let alone = Component::new("/app/card.zb", &source, &[]);
    let error = alone.check().unwrap_err().to_string();
    assert!(error.contains("`@acme/kit/badge.zb` wasn't found: its package isn't installed, or doesn't export that file"), "{error}");
}

#[test]
fn module_names_children_with_the_js_extension() {
    let module = card().module().unwrap();
    assert!(
        module.contains("./badge.js") || module.contains("badge.zb.js"),
        "{module}"
    );
    assert!(!module.contains("badge.zb\""), "{module}");
}

#[test]
fn a_path_without_a_directory_resolves_its_imports_beside_it() {
    // `Component::new("card.zb", …)`, or `include_zb!("card.zb")` for a component next to
    // Cargo.toml: `./badge.zb` is `badge.zb`, not `/badge.zb`.
    let badge = r#"<ui-badge text=""><span>{text}</span></ui-badge>"#;
    let card = "<script>\n  import './badge.zb'\n</script>\n<ui-card label=\"x\"><ui-badge text={label}></ui-badge></ui-card>";
    for (path, import) in [
        ("card.zb", "badge.zb"),
        ("./card.zb", "./badge.zb"),
        ("card.zb", "./badge.zb"),
        ("ui/card.zb", "ui/badge.zb"),
        ("/card.zb", "/badge.zb"),
        ("..\\shared\\card.zb", "../shared/badge.zb"),
    ] {
        let component = Component::new(path, card, &[(import, badge)]);
        let html = component
            .render(&serde_json::json!({ "label": "new" }))
            .unwrap_or_else(|error| panic!("{path} + {import}: {}", error.message));
        assert!(html.contains("<span>new</span>"), "{path}: {html}");
        component.check().unwrap();
        assert!(component.css().is_ok());
    }
    // And upwards from a nested one, to a file with no directory.
    let nested = card.replace("./badge.zb", "../badge.zb");
    let component = Component::new("ui/card.zb", &nested, &[("badge.zb", badge)]);
    assert!(component
        .render(&serde_json::json!({ "label": "up" }))
        .unwrap()
        .contains("<span>up</span>"));
}

#[test]
fn the_request_api_resolves_them_the_same_way() {
    let request = serde_json::json!({
        "emit": "html",
        "path": "card.zb",
        "files": {
            "card.zb": "<script>\n  import './badge.zb'\n</script>\n<ui-card><ui-badge text=\"hi\"></ui-badge></ui-card>",
            "badge.zb": "<ui-badge text=\"\"><span>{text}</span></ui-badge>",
        },
        "props": {},
    });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    assert!(response["output"]
        .as_str()
        .unwrap()
        .contains("<span>hi</span>"));
}

#[test]
fn a_nested_form_control_carries_its_value_for_a_form_submitted_before_javascript() {
    const STEPPER: &str =
        "<x-step form-associated value:model={1}><output>{value}</output></x-step>\n";
    let render = |parent: &str, child: &str| {
        Component::new("/app/form.zb", parent, &[("/app/step.zb", child)])
            .render(&json!({ "n": 4 }))
            .unwrap()
    };
    let input = r#"<input type="hidden" name="qty" value="2" data-zb-fallback>"#;
    // Named, with a value known on the server: the host's last child is the stand-in.
    let html = render(
        "<script>\n  import './step.zb'\n</script>\n<x-form n={0}><form><x-step name=\"qty\" value={2}></x-step></form></x-form>\n",
        STEPPER,
    );
    assert!(
        html.contains(&format!("<output>2</output>{input}</x-step>")),
        "{html}"
    );
    // The default is what it renders, so it's what it submits.
    let html = render(
        "<script>\n  import './step.zb'\n</script>\n<x-form n={0}><form><x-step name=\"qty\"></x-step></form></x-form>\n",
        STEPPER,
    );
    assert!(
        html.contains(r#"name="qty" value="1" data-zb-fallback"#),
        "{html}"
    );
    // No name, nothing to submit.
    let html = render(
        "<script>\n  import './step.zb'\n</script>\n<x-form n={0}><form><x-step value={2}></x-step></form></x-form>\n",
        STEPPER,
    );
    assert!(!html.contains("data-zb-fallback"), "{html}");
    // A value only the browser knows: the child renders its default, which mustn't be submitted.
    let html = render(
        "<script>\n  import './step.zb'\n  const later = Date.now()\n</script>\n<x-form n={0}><form><x-step name=\"qty\" value={later}></x-step></form></x-form>\n",
        STEPPER,
    );
    assert!(!html.contains("data-zb-fallback"), "{html}");
    // A control that sets its own form value: only it knows what that is.
    let html = render(
        "<script>\n  import './step.zb'\n</script>\n<x-form n={0}><form><x-step name=\"qty\" value={2}></x-step></form></x-form>\n",
        "<script>\n  import { formValue } from '@zubra/runtime'\n  formValue(() => value * 10)\n</script>\n<x-step form-associated value:model={1}><output>{value}</output></x-step>\n",
    );
    assert!(!html.contains("data-zb-fallback"), "{html}");
    // The name only in a comment (or under another import): the child doesn't set its own value.
    let html = render(
        "<script>\n  import './step.zb'\n</script>\n<x-form n={0}><form><x-step name=\"qty\" value={2}></x-step></form></x-form>\n",
        "<script>\n  import { hydrated } from '@zubra/runtime'\n  // Unlike a stepper that calls formValue(), this one submits its value as it is.\n  const live = hydrated()\n</script>\n<x-step form-associated value:model={1}><output>{value}</output></x-step>\n",
    );
    assert!(
        html.contains(r#"<input type="hidden" name="qty" value="2" data-zb-fallback>"#),
        "{html}"
    );
}
