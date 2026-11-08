//! Components that use other components: `import "./x.zb"` in a `<script>`.

use std::collections::HashMap;

use zubra::{compile, compile_html_with, compile_js_with, Diagnostic};

const BADGE: &str = r#"<zb-badge label="new" count={0} info={{ color: "gray" }}>
  <span data-color={info.color}><zb-slot name="icon"></zb-slot><b>{label}</b> {count}<zb-slot></zb-slot></span>
</zb-badge>"#;

const CARD: &str = r#"<zb-card shadow heading="">
  <h2>{heading}</h2><zb-slot></zb-slot>
</zb-card>"#;

/// An in-memory "filesystem": specifiers resolve to the names in `files`, ignoring the importer.
fn files(files: &[(&str, &str)]) -> HashMap<String, String> {
    files
        .iter()
        .map(|(name, source)| ((*name).to_owned(), (*source).to_owned()))
        .collect()
}

fn html(source: &str, children: &HashMap<String, String>) -> Result<String, Diagnostic> {
    let loader = |specifier: &str, _from: &str| {
        children
            .get(specifier)
            .map(|source| {
                (
                    specifier.trim_start_matches("./").to_owned(),
                    source.clone(),
                )
            })
            .ok_or_else(|| "not found".to_owned())
    };
    compile_html_with(source, "app.zb", "{}", "{}", &loader)
}

fn js(
    source: &str,
    children: &HashMap<String, String>,
    extension: Option<&str>,
) -> Result<String, Diagnostic> {
    let loader = |specifier: &str, _from: &str| {
        children
            .get(specifier)
            .map(|source| {
                (
                    specifier.trim_start_matches("./").to_owned(),
                    source.clone(),
                )
            })
            .ok_or_else(|| "not found".to_owned())
    };
    compile_js_with(source, "app.zb", "@zubra/runtime", extension, &loader)
}

const INBOX: &str = r#"<script>
  import './badge.zb'
</script>
<zb-inbox who="Ada" unread={3}>
  <zb-badge label={who} count={unread} info={{ color: unread > 0 ? "red" : "gray" }} class="row"><em slot="icon">{unread}</em>mail</zb-badge>
</zb-inbox>"#;

#[test]
fn renders_children_inline_with_props_as_values_and_content_in_their_slots() {
    let html = html(INBOX, &files(&[("./badge.zb", BADGE)])).unwrap();
    assert!(
        html.contains(r#"<zb-badge class="row" label="Ada" count="3" info="{&quot;color&quot;:&quot;red&quot;}">"#),
        "{html}"
    );
    assert!(
        html.contains(r#"<span data-color="red"><?zb [!?><em slot="icon">3</em><?zb ]?><b>Ada</b><?zb ?> 3<?zb [!?>mail<?zb ]?></span>"#),
        "{html}"
    );
}

#[test]
fn shadow_children_render_a_declarative_shadow_root_with_content_in_light_dom() {
    let source = r#"<script>import './card.zb'</script>
<zb-page><zb-card heading="Hi"><p>body</p></zb-card></zb-page>"#;
    let html = html(source, &files(&[("./card.zb", CARD)])).unwrap();
    assert!(
        html.contains(r#"<zb-card heading="Hi"><template shadowrootmode="open">"#),
        "{html}"
    );
    assert!(html.contains("<h2>Hi</h2><slot></slot>"), "{html}");
    assert!(html.contains("</template><p>body</p></zb-card>"), "{html}");
}

#[test]
fn child_props_are_checked_against_the_childs_defaults() {
    let children = files(&[("./badge.zb", BADGE)]);
    let wrong_type = r#"<script>import './badge.zb'</script>
<zb-x><zb-badge count={"three"}></zb-badge></zb-x>"#;
    let error = html(wrong_type, &children).unwrap_err();
    assert!(error.message.contains("count"), "{}", error.message);
    assert_eq!(error.span.line, 2);
    assert!(
        error.file.is_none(),
        "the error is in the parent, where the attribute is"
    );

    let typo = r#"<script>import './badge.zb'</script>
<zb-x><zb-badge lable={"x"}></zb-badge></zb-x>"#;
    let error = html(typo, &children).unwrap_err();
    assert_eq!(
        error.help.as_deref(),
        Some("did you mean `label`?"),
        "{error}"
    );

    let unknown_slot = r#"<script>import './badge.zb'</script>
<zb-x><zb-badge><i slot="nope">x</i></zb-badge></zb-x>"#;
    assert!(html(unknown_slot, &children)
        .unwrap_err()
        .message
        .contains("nope"));
}

#[test]
fn errors_inside_an_imported_component_name_that_file() {
    let broken = "<zb-badge><p>{missing}</p></zb-badge>";
    let source = "<script>import './badge.zb'</script>\n<zb-x><zb-badge></zb-badge></zb-x>";
    let error = html(source, &files(&[("./badge.zb", broken)])).unwrap_err();
    let (path, _) = error.file.clone().expect("the error is in the child");
    assert_eq!(path, "badge.zb");
    assert!(
        error
            .render_in(source, "app.zb")
            .contains("--> badge.zb:1:"),
        "{}",
        error.render_in(source, "app.zb")
    );
}

#[test]
fn imports_are_checked_for_cycles_duplicates_and_missing_files() {
    let a = "<script>import './b.zb'</script>\n<zb-a><zb-b></zb-b></zb-a>";
    let b = "<script>import './a.zb'</script>\n<zb-b><zb-a></zb-a></zb-b>";
    let error = html(a, &files(&[("./a.zb", a), ("./b.zb", b)])).unwrap_err();
    assert!(error.message.contains("import cycle"), "{}", error.message);

    let twice = "<script>import './badge.zb'\nimport './again.zb'</script>\n<zb-x></zb-x>";
    let error = html(
        twice,
        &files(&[("./badge.zb", BADGE), ("./again.zb", BADGE)]),
    )
    .unwrap_err();
    assert!(
        error.message.contains("imported more than once"),
        "{}",
        error.message
    );

    let missing = "<script>import './gone.zb'</script>\n<zb-x></zb-x>";
    let error = html(missing, &files(&[])).unwrap_err();
    assert!(
        error.message.contains("can't load `./gone.zb`"),
        "{}",
        error.message
    );
    assert_eq!(error.span.line, 1);

    let error = compile("<script>import './badge.zb'</script>\n<zb-x></zb-x>", "{}").unwrap_err();
    assert!(
        error.message.contains("compile it from a file"),
        "{}",
        error.message
    );
}

#[test]
fn javascript_passes_child_props_as_properties_and_finds_slotted_content_when_hydrating() {
    let output = js(INBOX, &files(&[("./badge.zb", BADGE)]), Some(".js")).unwrap();
    assert!(output.contains("import \"./badge.js\""), "{output}");
    assert!(
        output.contains(r#"property: "count", value: () => $p.unread"#),
        "{output}"
    );
    // Objects are parenthesized: `() => { … }` would be a function body.
    assert!(
        output.contains(r#"property: "info", value: () => ({ "color": "#),
        "{output}"
    );
    // Fresh: inside the content the parent clones; hydrating: where the child projected it.
    // badge [0] → its <span> [0] → the icon slot's region [0] → the <em> [0].
    assert!(
        output.contains("{ path: [0, 0], hydrate: [0, 0, 0, 0], text: () => $t($p.unread) }"),
        "{output}"
    );
}

#[test]
fn a_bundler_keeps_zb_import_specifiers() {
    let output = js(INBOX, &files(&[("./badge.zb", BADGE)]), None).unwrap();
    assert!(output.contains("import './badge.zb'"), "{output}");
}

#[test]
fn a_child_default_computed_in_the_browser_must_be_passed_to_render_html() {
    let child = "<script>const start = Date.now()</script>\n<zb-clock since={start}><p>{since}</p></zb-clock>";
    let children = files(&[("./clock.zb", child)]);
    let error = html(
        "<script>import './clock.zb'</script>\n<zb-x><zb-clock></zb-clock></zb-x>",
        &children,
    )
    .unwrap_err();
    assert!(
        error
            .message
            .contains("computes the default for `since` in the browser"),
        "{}",
        error.message
    );
    assert_eq!(error.span.line, 2);
    assert!(html(
        "<script>import './clock.zb'</script>\n<zb-x><zb-clock since={5}></zb-clock></zb-x>",
        &children
    )
    .unwrap()
    .contains("<p>5</p>"));
}

#[test]
fn both_outputs_check_how_a_child_is_used() {
    let children = files(&[("./badge.zb", BADGE)]);
    for (usage, expected) in [
        (
            "<zb-badge count={\"three\"}></zb-badge>",
            "prop `count` must be a number",
        ),
        ("<zb-badge lable={\"x\"}></zb-badge>", "has no prop `lable`"),
        ("<zb-badge onlabelchang={go}></zb-badge>", "never fires"),
    ] {
        let source = format!(
            "<script>import './badge.zb'\nfunction go() {{}}</script>\n<zb-x>{usage}</zb-x>"
        );
        let source = if expected == "never fires" {
            source
                .replace("./badge.zb'", "./emitter.zb'")
                .replace("zb-badge", "zb-emitter")
        } else {
            source
        };
        let children = if expected == "never fires" {
            files(&[("./emitter.zb", "<script>import { emit } from '@zubra/runtime'\nemit('labelchange')</script>\n<zb-emitter><p>x</p></zb-emitter>")])
        } else {
            children.clone()
        };
        let in_html = html(&source, &children).unwrap_err();
        let in_js = js(&source, &children, Some(".js")).unwrap_err();
        assert!(
            in_html.message.contains(expected),
            "html: {}",
            in_html.message
        );
        assert_eq!(
            in_js.message, in_html.message,
            "the same error from both outputs"
        );
        assert_eq!(in_js.help, in_html.help);
    }
    let required = "<zb-req name><p>{name}</p></zb-req>";
    let children = files(&[("./req.zb", required)]);
    let source = "<script>import './req.zb'</script>\n<zb-x><zb-req></zb-req></zb-x>";
    assert!(js(source, &children, None)
        .unwrap_err()
        .message
        .contains("requires the prop `name`"));
    // Values only known in the browser aren't checked at build time.
    let source =
        "<script>import './badge.zb'</script>\n<zb-x n={1}><zb-badge count={n}></zb-badge></zb-x>";
    assert!(js(source, &files(&[("./badge.zb", BADGE)]), None).is_ok());
}
