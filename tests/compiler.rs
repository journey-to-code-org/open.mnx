use mnix_compiler::{compile, compile_value, compile_with_slots};
use serde_json::json;

const SOURCE: &str = "component: Greeting\nprop name: string\nprop url: url\n---\n<article class=\"greeting\"><h1>Hello, {{ name }}!</h1><a href=\"{{ url }}\">Visit</a></article>";

#[test]
fn renders_a_typed_component_as_semantic_html() {
    let html = compile(SOURCE, r#"{"name":"Mikey","url":"https://mnix.dev"}"#).unwrap();
    assert_eq!(
        html,
        "<article class=\"greeting\"><h1>Hello, Mikey!</h1><a href=\"https://mnix.dev\">Visit</a></article>"
    );
}

#[test]
fn escapes_text_and_attribute_interpolation() {
    let html = compile(
        SOURCE,
        r#"{"name":"<script>alert(1)</script> & \"quoted\"","url":"/search?q=one&x=two"}"#,
    )
    .unwrap();
    assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;"));
    assert!(html.contains("href=\"/search?q=one&amp;x=two\""));
    assert!(!html.contains("<script>"));
}

#[test]
fn escapes_static_text_and_attributes_deterministically() {
    let source = "component: Notice\nprop text: string\n---\n<p title=\"A &amp; B\">{{ text }}</p>";
    let html = compile(source, r#"{"text":"x > y"}"#).unwrap();
    assert_eq!(html, "<p title=\"A &amp; B\">x &gt; y</p>");
    assert_eq!(compile(source, r#"{"text":"x > y"}"#).unwrap(), html);
}

#[test]
fn emits_a_declared_custom_element_host_without_runtime_assumptions() {
    let source =
        "component: Greeting\ntag: mnix-greeting\nprop name: string\n---\n<p>Hello {{ name }}</p>";
    assert_eq!(
        compile(source, r#"{"name":"Mikey"}"#).unwrap(),
        "<mnix-greeting><p>Hello Mikey</p></mnix-greeting>"
    );
}

#[test]
fn rejects_unsafe_static_and_interpolated_urls() {
    let static_url = "component: Link\n---\n<a href=\"javascript:alert(1)\">Open</a>";
    assert!(compile(static_url, "{}")
        .unwrap_err()
        .message
        .contains("unsafe URL"));

    let entity_url = "component: Link\n---\n<a href=\"javascript&colon;alert(1)\">Open</a>";
    assert!(compile(entity_url, "{}")
        .unwrap_err()
        .message
        .contains("unsafe URL"));

    let wrong_type = "component: Link\nprop target: string\n---\n<a href=\"{{ target }}\">Open</a>";
    assert!(compile(wrong_type, r#"{"target":"/safe"}"#)
        .unwrap_err()
        .message
        .contains("requires a prop declared as url"));

    let unsafe_prop = "component: Link\nprop target: url\n---\n<a href=\"{{ target }}\">Open</a>";
    assert!(compile(unsafe_prop, r#"{"target":"data:text/html,bad"}"#)
        .unwrap_err()
        .message
        .contains("must be a safe URL"));
}

#[test]
fn rejects_missing_extra_and_mistyped_props() {
    assert!(compile(SOURCE, r#"{"name":"Mikey"}"#)
        .unwrap_err()
        .message
        .contains("missing required prop `url`"));
    assert!(
        compile(SOURCE, r#"{"name":"Mikey","url":"/","extra":true}"#)
            .unwrap_err()
            .message
            .contains("unknown prop `extra`")
    );
    assert!(compile(SOURCE, r#"{"name":42,"url":"/"}"#)
        .unwrap_err()
        .message
        .contains("must be a string"));
}

#[test]
fn rejects_unknown_interpolation_with_source_location() {
    let error = compile(
        "component: Greeting\nprop name: string\n---\n<p>Hi {{ visitor }}</p>",
        r#"{"name":"Mikey"}"#,
    )
    .unwrap_err();
    assert!(error.message.contains("unknown prop reference `visitor`"));
    assert_eq!(error.span.line, 4);
    assert_eq!(error.span.column, 7);
}

#[test]
fn rejects_malformed_html_and_unsafe_template_features() {
    for (source, expected) in [
        ("component: Bad\n---\n<p></section>", "does not match"),
        ("component: Bad\n---\n<p>", "missing closing tag"),
        ("component: Bad\n---\n<script>alert(1)</script>", "<script>"),
        (
            "component: Bad\n---\n<button onclick=\"run()\">Go</button>",
            "event-handler",
        ),
        (
            "component: Bad\n---\n<div style=\"color:red\">Text</div>",
            "inline style",
        ),
    ] {
        assert!(compile(source, "{}")
            .unwrap_err()
            .message
            .contains(expected));
    }
}

#[test]
fn rejects_duplicate_props_attributes_and_invalid_custom_tags() {
    for (source, expected) in [
        (
            "component: Bad\nprop value: string\nprop value: number\n---\n<p>{{ value }}</p>",
            "duplicate prop",
        ),
        (
            "component: Bad\n---\n<p id=\"a\" id=\"b\">Text</p>",
            "duplicate attribute",
        ),
        (
            "component: Bad\ntag: Not-Valid\n---\n<p>Text</p>",
            "not a valid custom-element name",
        ),
    ] {
        assert!(compile(source, "{}")
            .unwrap_err()
            .message
            .contains(expected));
    }
}

#[test]
fn reports_invalid_custom_element_names_at_their_declaration() {
    let error = compile("component: Bad\ntag: xml-widget\n---\n<p>Text</p>", "{}").unwrap_err();
    assert!(error.message.contains("not a valid custom-element name"));
    assert_eq!(error.span.line, 2);
}

#[test]
fn validates_srcset_candidates_and_rejects_dynamic_interpolation() {
    let safe =
        "component: Picture\n---\n<img srcset=\"/small.webp 1x, https://mnix.dev/large.webp 2x\">";
    assert!(compile(safe, "{}").is_ok());

    let unsafe_srcset =
        "component: Picture\n---\n<img srcset=\"/small.webp 1x, javascript:alert(1) 2x\">";
    assert!(compile(unsafe_srcset, "{}")
        .unwrap_err()
        .message
        .contains("unsafe or empty URL"));

    let dynamic = "component: Picture\nprop sources: string\n---\n<img srcset=\"{{ sources }}\">";
    assert!(compile(dynamic, r#"{"sources":"/image.webp 1x"}"#)
        .unwrap_err()
        .message
        .contains("srcset interpolation is not supported"));
}

#[test]
fn requires_exactly_one_template_root() {
    for source in [
        "component: Empty\n---\n",
        "component: Many\n---\n<p>One</p><p>Two</p>",
        "component: Text\n---\nleading <p>Root</p>",
    ] {
        assert!(compile(source, "{}")
            .unwrap_err()
            .message
            .contains("exactly one root element"));
    }
}

#[test]
fn supports_typed_scalar_values_and_rejects_non_objects() {
    let source = "component: Summary\nprop count: number\nprop active: boolean\n---\n<p>{{ count }} {{ active }}</p>";
    assert_eq!(
        compile_value(source, &json!({ "count": 3, "active": true })).unwrap(),
        "<p>3 true</p>"
    );
    assert!(compile(source, "[]")
        .unwrap_err()
        .message
        .contains("must be a JSON object"));
}

#[test]
fn renders_boolean_attributes_by_presence_and_rejects_wrong_prop_types() {
    let source = "component: Toggle\nprop active: boolean\n---\n<button disabled=\"{{ active }}\">Toggle</button>";
    assert_eq!(
        compile(source, r#"{"active":true}"#).unwrap(),
        "<button disabled>Toggle</button>"
    );
    assert_eq!(
        compile(source, r#"{"active":false}"#).unwrap(),
        "<button>Toggle</button>"
    );

    let invalid = "component: Toggle\nprop active: string\n---\n<button disabled=\"{{ active }}\">Toggle</button>";
    assert!(compile(invalid, r#"{"active":"true"}"#)
        .unwrap_err()
        .message
        .contains("requires one boolean prop"));
}

#[test]
fn parses_and_renders_unicode_template_text() {
    let source = "component: Greeting\nprop name: string\n---\n<p>Héllo, {{ name }}</p>";
    assert_eq!(
        compile(source, r#"{"name":"Zoë"}"#).unwrap(),
        "<p>Héllo, Zoë</p>"
    );
}

#[test]
fn preserves_case_sensitive_svg_names_and_rejects_srcdoc_interpolation() {
    let svg = "component: Icon\n---\n<svg viewBox=\"0 0 10 10\"><path d=\"M0 0\"></path></svg>";
    assert_eq!(
        compile(svg, "{}").unwrap(),
        "<svg viewBox=\"0 0 10 10\"><path d=\"M0 0\"></path></svg>"
    );

    let srcdoc =
        "component: Frame\nprop content: string\n---\n<iframe srcdoc=\"{{ content }}\"></iframe>";
    assert!(compile(srcdoc, r#"{"content":"<script>bad</script>"}"#)
        .unwrap_err()
        .message
        .contains("interpolation in srcdoc is not supported"));
}

#[test]
fn selects_compile_time_if_else_branches_without_emitting_directives() {
    let source = "component: Status\nprop active: boolean\nprop status: string\nprop count: number\n---\n<main><mnix-if test='active && (status == \"ready\" || count == 3)'><p>Ready</p><mnix-else><p>Waiting</p></mnix-else></mnix-if></main>";
    let selected = compile(source, r#"{"active":true,"status":"ready","count":0}"#).unwrap();
    assert!(selected.contains("<p>Ready</p>"));
    assert!(!selected.contains("<p>Waiting</p>"));
    assert!(!selected.contains("mnix-if"));
    assert!(!selected.contains("mnix-else"));

    let alternative = compile(source, r#"{"active":false,"status":"ready","count":0}"#).unwrap();
    assert!(alternative.contains("<p>Waiting</p>"));
    assert!(!alternative.contains("<p>Ready</p>"));
}

#[test]
fn rejects_unknown_and_non_boolean_compile_time_conditions() {
    let unknown = "component: Conditional\n---\n<main><mnix-if test=\"missing\"><p>Shown</p></mnix-if></main>";
    assert!(compile(unknown, "{}")
        .unwrap_err()
        .message
        .contains("unknown reference `missing`"));

    let non_boolean = "component: Conditional\nprop count: number\n---\n<main><mnix-if test=\"count\"><p>Shown</p></mnix-if></main>";
    assert!(compile(non_boolean, r#"{"count":1}"#)
        .unwrap_err()
        .message
        .contains("must evaluate to a boolean"));

    let unsupported = "component: Conditional\nprop count: number\n---\n<main><mnix-if test=\"count + 1 == 2\"><p>Shown</p></mnix-if></main>";
    assert!(compile(unsupported, r#"{"count":1}"#)
        .unwrap_err()
        .message
        .contains("invalid mnix-if test"));

    let unreachable_unknown = "component: Conditional\n---\n<main><mnix-if test=\"false && missing\"><p>Shown</p></mnix-if></main>";
    assert!(compile(unreachable_unknown, "{}")
        .unwrap_err()
        .message
        .contains("unknown reference `missing`"));

    let unreachable_type_error = "component: Conditional\nprop label: string\n---\n<main><mnix-if test=\"false && label\"><p>Shown</p></mnix-if></main>";
    assert!(compile(unreachable_type_error, r#"{"label":"no"}"#)
        .unwrap_err()
        .message
        .contains("operator && requires boolean operands"));

    let unused_branch = "component: Conditional\n---\n<main><mnix-if test=\"true\"><p>Shown</p><mnix-else><p>{{ missing }}</p></mnix-else></mnix-if></main>";
    assert!(compile(unused_branch, "{}")
        .unwrap_err()
        .message
        .contains("unknown prop reference `missing`"));

    let unsafe_unused_branch = "component: Conditional\n---\n<main><mnix-if test=\"true\"><p>Shown</p><mnix-else><a href=\"javascript:bad()\">Unsafe</a></mnix-else></mnix-if></main>";
    assert!(compile(unsafe_unused_branch, "{}")
        .unwrap_err()
        .message
        .contains("unsafe URL"));
}

#[test]
fn expands_typed_string_loops_with_contextual_escaping() {
    let source = "component: FeatureList\nprop features: strings\n---\n<ul><mnix-each items=\"features\" as=\"feature\"><li>{{ feature }}</li></mnix-each></ul>";
    let html = compile(
        source,
        r#"{"features":["Rust","<script>alert(1)</script>","HTML"]}"#,
    )
    .unwrap();
    assert_eq!(
        html,
        "<ul><li>Rust</li><li>&lt;script&gt;alert(1)&lt;/script&gt;</li><li>HTML</li></ul>"
    );
    assert!(!html.contains("mnix-each"));

    assert_eq!(compile(source, r#"{"features":[]}"#).unwrap(), "<ul></ul>");

    let invalid_empty_body = "component: FeatureList\nprop features: strings\n---\n<ul><mnix-each items=\"features\" as=\"feature\"><li>{{ missing }}</li></mnix-each></ul>";
    assert!(compile(invalid_empty_body, r#"{"features":[]}"#)
        .unwrap_err()
        .message
        .contains("unknown prop reference `missing`"));
}

#[test]
fn requires_string_lists_and_valid_loop_sources() {
    let source = "component: FeatureList\nprop features: strings\n---\n<ul><mnix-each items=\"features\" as=\"feature\"><li>{{ feature }}</li></mnix-each></ul>";
    assert!(compile(source, r#"{"features":["Rust",2]}"#)
        .unwrap_err()
        .message
        .contains("must be an array of strings"));

    let wrong_type = "component: FeatureList\nprop features: string\n---\n<ul><mnix-each items=\"features\" as=\"feature\"><li>{{ feature }}</li></mnix-each></ul>";
    assert!(compile(wrong_type, r#"{"features":"Rust"}"#)
        .unwrap_err()
        .message
        .contains("must have type strings"));

    let unknown = "component: FeatureList\nprop features: strings\n---\n<ul><mnix-each items=\"missing\" as=\"feature\"><li>{{ feature }}</li></mnix-each></ul>";
    assert!(compile(unknown, r#"{"features":[]}"#)
        .unwrap_err()
        .message
        .contains("unknown prop `missing`"));
}

#[test]
fn fills_named_and_default_slots_from_parsed_template_fragments() {
    let source = "component: Panel\nprop title: string\n---\n<main><mnix-slot name=\"heading\"><h1>{{ title }}</h1></mnix-slot><mnix-slot><p>Default fallback</p></mnix-slot></main>";
    let html = compile_with_slots(
        source,
        r#"{"title":"Panel title"}"#,
        r#"{"heading":"<h2>{{ title }}</h2>","default":"<p>Supplied default</p>"}"#,
    )
    .unwrap();
    assert_eq!(
        html,
        "<main><h2>Panel title</h2><p>Supplied default</p></main>"
    );
    assert!(!html.contains("mnix-slot"));

    assert_eq!(
        compile(source, r#"{"title":"Fallback title"}"#).unwrap(),
        "<main><h1>Fallback title</h1><p>Default fallback</p></main>"
    );
}

#[test]
fn rejects_unknown_slots_invalid_slot_markup_and_recursive_expansion() {
    let source = "component: Panel\n---\n<main><mnix-slot name=\"content\"><p>Fallback</p></mnix-slot></main>";
    assert!(
        compile_with_slots(source, "{}", r#"{"unknown":"<p>Bad</p>"}"#)
            .unwrap_err()
            .message
            .contains("slot `unknown` is not declared")
    );
    assert!(
        compile_with_slots(source, "{}", r#"{"content":"<p>Broken</main>"}"#)
            .unwrap_err()
            .message
            .contains("does not match")
    );

    let recursive = "component: Panel\n---\n<main><mnix-slot name=\"content\"></mnix-slot></main>";
    assert!(compile_with_slots(
        recursive,
        "{}",
        r#"{"content":"<mnix-slot name=\"content\"></mnix-slot>"}"#
    )
    .unwrap_err()
    .message
    .contains("recursive slot expansion"));
}

#[test]
fn rejects_misplaced_else_and_unknown_directive_attributes() {
    let misplaced = "component: Bad\n---\n<main><mnix-else><p>Else</p></mnix-else></main>";
    assert!(compile(misplaced, "{}")
        .unwrap_err()
        .message
        .contains("only valid as a direct child"));

    let extra = "component: Bad\nprop enabled: boolean\n---\n<main><mnix-if test=\"enabled\" other=\"x\"><p>Yes</p></mnix-if></main>";
    assert!(compile(extra, r#"{"enabled":true}"#)
        .unwrap_err()
        .message
        .contains("unexpected attribute `other`"));

    let misplaced_else = "component: Bad\n---\n<main><mnix-if test=\"true\"><p>Yes</p><mnix-else><p>No</p></mnix-else><p>After</p></mnix-if></main>";
    assert!(compile(misplaced_else, "{}")
        .unwrap_err()
        .message
        .contains("mnix-else must be the final child"));
}
