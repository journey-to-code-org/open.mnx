//! Components that use other components: `import "./x.mnx"` in a `<script>`.

use std::collections::HashMap;

use mnix_compiler::{compile, compile_html_with, compile_js_with, Diagnostic};

const BADGE: &str = r#"<mnx-badge label="new" count={0} info={{ color: "gray" }}>
  <span data-color={info.color}><mnx-slot name="icon"></mnx-slot><b>{label}</b> {count}<mnx-slot></mnx-slot></span>
</mnx-badge>"#;

const CARD: &str = r#"<mnx-card shadow heading="">
  <h2>{heading}</h2><mnx-slot></mnx-slot>
</mnx-card>"#;

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
    compile_html_with(source, "app.mnx", "{}", "{}", &loader)
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
    compile_js_with(source, "app.mnx", "@mnx/runtime", extension, &loader)
}

const INBOX: &str = r#"<script>
  import './badge.mnx'
</script>
<mnx-inbox who="Ada" unread={3}>
  <mnx-badge label={who} count={unread} info={{ color: unread > 0 ? "red" : "gray" }} class="row"><em slot="icon">{unread}</em>mail</mnx-badge>
</mnx-inbox>"#;

#[test]
fn renders_children_inline_with_props_as_values_and_content_in_their_slots() {
    let html = html(INBOX, &files(&[("./badge.mnx", BADGE)])).unwrap();
    assert!(
        html.contains(r#"<mnx-badge class="row" label="Ada" count="3" info="{&quot;color&quot;:&quot;red&quot;}">"#),
        "{html}"
    );
    assert!(
        html.contains(r#"<span data-color="red"><!--[!--><em slot="icon">3</em><!--]--><b>Ada</b><!----> 3<!--[!-->mail<!--]--></span>"#),
        "{html}"
    );
}

#[test]
fn shadow_children_render_a_declarative_shadow_root_with_content_in_light_dom() {
    let source = r#"<script>import './card.mnx'</script>
<mnx-page><mnx-card heading="Hi"><p>body</p></mnx-card></mnx-page>"#;
    let html = html(source, &files(&[("./card.mnx", CARD)])).unwrap();
    assert!(
        html.contains(r#"<mnx-card heading="Hi"><template shadowrootmode="open">"#),
        "{html}"
    );
    assert!(html.contains("<h2>Hi</h2><slot></slot>"), "{html}");
    assert!(html.contains("</template><p>body</p></mnx-card>"), "{html}");
}

#[test]
fn child_props_are_checked_against_the_childs_defaults() {
    let children = files(&[("./badge.mnx", BADGE)]);
    let wrong_type = r#"<script>import './badge.mnx'</script>
<mnx-x><mnx-badge count={"three"}></mnx-badge></mnx-x>"#;
    let error = html(wrong_type, &children).unwrap_err();
    assert!(error.message.contains("count"), "{}", error.message);
    assert_eq!(error.span.line, 2);
    assert!(
        error.file.is_none(),
        "the error is in the parent, where the attribute is"
    );

    let typo = r#"<script>import './badge.mnx'</script>
<mnx-x><mnx-badge lable={"x"}></mnx-badge></mnx-x>"#;
    let error = html(typo, &children).unwrap_err();
    assert_eq!(
        error.help.as_deref(),
        Some("did you mean `label`?"),
        "{error}"
    );

    let unknown_slot = r#"<script>import './badge.mnx'</script>
<mnx-x><mnx-badge><i slot="nope">x</i></mnx-badge></mnx-x>"#;
    assert!(html(unknown_slot, &children)
        .unwrap_err()
        .message
        .contains("nope"));
}

#[test]
fn errors_inside_an_imported_component_name_that_file() {
    let broken = "<mnx-badge><p>{missing}</p></mnx-badge>";
    let source = "<script>import './badge.mnx'</script>\n<mnx-x><mnx-badge></mnx-badge></mnx-x>";
    let error = html(source, &files(&[("./badge.mnx", broken)])).unwrap_err();
    let (path, _) = error.file.clone().expect("the error is in the child");
    assert_eq!(path, "badge.mnx");
    assert!(
        error
            .render_in(source, "app.mnx")
            .contains("--> badge.mnx:1:"),
        "{}",
        error.render_in(source, "app.mnx")
    );
}

#[test]
fn imports_are_checked_for_cycles_duplicates_and_missing_files() {
    let a = "<script>import './b.mnx'</script>\n<mnx-a><mnx-b></mnx-b></mnx-a>";
    let b = "<script>import './a.mnx'</script>\n<mnx-b><mnx-a></mnx-a></mnx-b>";
    let error = html(a, &files(&[("./a.mnx", a), ("./b.mnx", b)])).unwrap_err();
    assert!(error.message.contains("import cycle"), "{}", error.message);

    let twice = "<script>import './badge.mnx'\nimport './again.mnx'</script>\n<mnx-x></mnx-x>";
    let error = html(
        twice,
        &files(&[("./badge.mnx", BADGE), ("./again.mnx", BADGE)]),
    )
    .unwrap_err();
    assert!(
        error.message.contains("imported more than once"),
        "{}",
        error.message
    );

    let missing = "<script>import './gone.mnx'</script>\n<mnx-x></mnx-x>";
    let error = html(missing, &files(&[])).unwrap_err();
    assert!(
        error.message.contains("can't load `./gone.mnx`"),
        "{}",
        error.message
    );
    assert_eq!(error.span.line, 1);

    let error = compile(
        "<script>import './badge.mnx'</script>\n<mnx-x></mnx-x>",
        "{}",
    )
    .unwrap_err();
    assert!(
        error.message.contains("compile it from a file"),
        "{}",
        error.message
    );
}

#[test]
fn javascript_passes_child_props_as_properties_and_finds_slotted_content_when_hydrating() {
    let output = js(INBOX, &files(&[("./badge.mnx", BADGE)]), Some(".js")).unwrap();
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
fn a_bundler_keeps_mnx_import_specifiers() {
    let output = js(INBOX, &files(&[("./badge.mnx", BADGE)]), None).unwrap();
    assert!(output.contains("import './badge.mnx'"), "{output}");
}
