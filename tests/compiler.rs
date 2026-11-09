use serde_json::json;
use zubra::{compile, compile_js, compile_value, compile_with_slots, Diagnostic};

const GREETING: &str = r#"<zb-greeting name url>
  <article class="greeting"><h1>Hello, {name}!</h1><a href={url}>Visit</a></article>
</zb-greeting>"#;

fn error(source: &str, props: &str) -> Diagnostic {
    compile(source, props).expect_err("expected a compile error")
}

fn assert_error(source: &str, props: &str, expected: &str) {
    let diagnostic = error(source, props);
    assert!(
        diagnostic.message.contains(expected),
        "expected an error containing {expected:?}, got {:?}",
        diagnostic.message
    );
}

// ---- rendering ------------------------------------------------------------------------------

#[test]
fn renders_a_component_inside_its_host_element() {
    let html = compile(GREETING, r#"{"name":"Mikey","url":"https://mnix.dev"}"#).unwrap();
    assert_eq!(
        html,
        "<zb-greeting name=\"Mikey\" url=\"https://mnix.dev\">\n  <article class=\"greeting\"><h1>Hello, Mikey!</h1><a href=\"https://mnix.dev\">Visit</a></article>\n</zb-greeting>"
    );
}

#[test]
fn escapes_text_and_attribute_values() {
    let html = compile(
        GREETING,
        r#"{"name":"<script>alert(1)</script> & \"quoted\"","url":"/search?q=one&x=two"}"#,
    )
    .unwrap();
    assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;"));
    assert!(html.contains("href=\"/search?q=one&amp;x=two\""));
    assert!(!html.contains("<script>"));
}

#[test]
fn preserves_authored_markup_and_is_deterministic() {
    let source = "<zb-notice text>\n<p title=\"A &amp; B\">{text}</p>\n</zb-notice>";
    let html = compile(source, r#"{"text":"x > y"}"#).unwrap();
    assert_eq!(
        html,
        "<zb-notice text=\"x &gt; y\">\n<p title=\"A &amp; B\">x &gt; y</p>\n</zb-notice>"
    );
    assert_eq!(compile(source, r#"{"text":"x > y"}"#).unwrap(), html);
}

#[test]
fn script_bindings_feed_prop_defaults_and_the_template() {
    let source = r#"<script>
  const first = "Mikey"
  const last = "Nichols"
  const full = first + " " + last
  const tags = ["rust", "web"]
</script>
<zb-card name={full} count={tags.length}>
  <p>{name} ({count} tags, first: {tags[0]})</p>
</zb-card>"#;
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-card>\n  <p>Mikey Nichols (2 tags, first: rust)</p>\n</zb-card>"
    );
}

#[test]
fn a_prop_default_from_the_script_and_no_script_name_shared_with_a_prop() {
    let source = "<script>const titleDefault = \"Script\"</script>\n<zb-x title={titleDefault}><h1>{title}</h1></zb-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-x><h1>Script</h1></zb-x>"
    );
    assert_eq!(
        compile(source, r#"{"title":"Override"}"#).unwrap(),
        "<zb-x title=\"Override\"><h1>Override</h1></zb-x>"
    );
    // A prop's name is the prop in the script too, so the script can't declare it.
    let clash = compile(
        "<script>const title = \"Script\"</script>\n<zb-x title={title}></zb-x>",
        "{}",
    )
    .unwrap_err();
    assert_eq!(
        clash.message,
        "the script declares `title`, which is also a prop: a prop's name is the prop in the script too"
    );
    assert_eq!(clash.help.as_deref(), Some("rename the script's `title` (e.g. `titleDefault`, and `title={titleDefault}` on the host)"));
}

#[test]
fn renders_scalars_member_access_and_expressions() {
    let source = "<zb-summary count={0} active={false} user={null}><p>{count + 1} {active} {user?.name ?? \"anon\"} {count > 0 ? \"some\" : \"none\"}</p></zb-summary>";
    assert_eq!(
        compile_value(source, &json!({ "count": 3, "active": true, "user": { "name": "Zoë" } })).unwrap(),
        "<zb-summary count=\"3\" active user=\"{&quot;name&quot;:&quot;Zoë&quot;}\"><p>4 true Zoë some</p></zb-summary>"
    );
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-summary><p>1 false anon none</p></zb-summary>"
    );
    assert!(compile(source, "[]")
        .unwrap_err()
        .message
        .contains("must be a JSON object"));
}

#[test]
fn camel_case_props_are_written_kebab_case_on_the_host() {
    let source = "<zb-counter max-value={10}><p>{maxValue}</p></zb-counter>";
    assert_eq!(
        compile(source, r#"{"maxValue":5}"#).unwrap(),
        "<zb-counter max-value=\"5\"><p>5</p></zb-counter>"
    );
    assert_error(
        "<zb-counter maxValue={10}><p></p></zb-counter>",
        "{}",
        "lowercases attribute names",
    );
}

#[test]
fn boolean_attributes_render_by_presence_and_require_booleans() {
    let source = "<zb-toggle active={false}><button disabled={active}>Toggle</button></zb-toggle>";
    assert_eq!(
        compile(source, r#"{"active":true}"#).unwrap(),
        "<zb-toggle active><button disabled>Toggle</button></zb-toggle>"
    );
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-toggle><button>Toggle</button></zb-toggle>"
    );

    assert_error(
        "<zb-toggle label=\"x\"><button disabled={label}>Toggle</button></zb-toggle>",
        "{}",
        "must be true or false",
    );
    assert_error(
        "<zb-toggle active={true}><button disabled=\"{active}\">Toggle</button></zb-toggle>",
        "{}",
        "bind it with disabled={…}",
    );
}

#[test]
fn default_true_booleans_round_trip_as_false() {
    let source = "<zb-panel open={true}><p>{open}</p></zb-panel>";
    assert_eq!(
        compile(source, r#"{"open":false}"#).unwrap(),
        "<zb-panel open=\"false\"><p>false</p></zb-panel>"
    );
}

#[test]
fn null_valued_attributes_are_omitted() {
    let source = "<zb-x label={null}><p title={label}>x</p></zb-x>";
    assert_eq!(compile(source, "{}").unwrap(), "<zb-x><p>x</p></zb-x>");
}

#[test]
fn parses_unicode_svg_and_comments() {
    let source = "<!-- a note -->\n<zb-icon name=\"Zoë\"><!-- inner --><svg viewBox=\"0 0 10 10\"><title>Héllo, {name}</title><path d=\"M0 0\"></path></svg></zb-icon>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-icon><svg viewBox=\"0 0 10 10\"><title>Héllo, Zoë</title><path d=\"M0 0\"></path></svg></zb-icon>"
    );
}

#[test]
fn records_the_shadow_flag_without_making_it_a_prop() {
    let source = "<zb-x shadow><p>x</p></zb-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-x><template shadowrootmode=\"open\"><p>x</p></template></zb-x>"
    );
    assert_error(source, r#"{"shadow":true}"#, "unknown prop `shadow`");
}

// ---- props ----------------------------------------------------------------------------------

#[test]
fn rejects_missing_unknown_and_mistyped_props() {
    assert_error(
        GREETING,
        r#"{"name":"Mikey"}"#,
        "missing required prop `url`",
    );
    let unknown = error(GREETING, r#"{"name":"Mikey","url":"/","nmae":1}"#);
    assert!(unknown.message.contains("unknown prop `nmae`"));
    assert_eq!(unknown.help.as_deref(), Some("did you mean `name`?"));
    assert_error(
        "<zb-x count={0}><p>{count}</p></zb-x>",
        r#"{"count":"3"}"#,
        "prop `count` must be a number (like its default), found a string",
    );
}

#[test]
fn rejects_duplicate_props_attributes_and_invalid_host_names() {
    assert_error("<zb-x a a><p></p></zb-x>", "{}", "duplicate attribute");
    assert_error(
        "<zb-x><p id=\"a\" id=\"b\">Text</p></zb-x>",
        "{}",
        "duplicate attribute",
    );
    let no_hyphen = error("<header><p></p></header>", "{}");
    assert!(no_hyphen
        .message
        .contains("not a valid custom-element name"));
    let help = no_hyphen.help.as_deref().unwrap_or_default();
    assert!(
        help.starts_with("custom element names need a hyphen, e.g. `header-element`"),
        "{help}"
    );
    // The rule is the platform's, and the error says so.
    assert!(
        help.contains("https://html.spec.whatwg.org/#valid-custom-element-name"),
        "{help}"
    );
    let reserved = error(
        "<script></script>\n\n<xml-widget><p>Text</p></xml-widget>",
        "{}",
    );
    assert!(reserved.message.contains("not a valid custom-element name"));
    assert_eq!(reserved.span.line, 3);
}

#[test]
fn prop_defaults_cannot_interpolate() {
    assert_error(
        "<zb-x label=\"a {b}\"><p></p></zb-x>",
        "{}",
        "can't interpolate",
    );
}

// ---- script ---------------------------------------------------------------------------------

#[test]
fn runtime_only_script_names_resolve_but_cannot_render_statically() {
    let source = "<script>\nconst now = Date.now()\nfunction label() { return 'x' }\n</script>\n<zb-clock><p>{now}</p></zb-clock>";
    let diagnostic = error(source, "{}");
    assert!(diagnostic.message.contains("`now` only exists at runtime"));
    assert_eq!(diagnostic.span.line, 5);

    // Declared but unused runtime names are fine.
    let unused = "<script>function label() { return 'x' }</script>\n<zb-x><p>static</p></zb-x>";
    assert_eq!(compile(unused, "{}").unwrap(), "<zb-x><p>static</p></zb-x>");

    // A runtime-only prop default can be supplied at build time instead.
    let default =
        "<script>const now = Date.now()</script>\n<zb-clock at={now}><p>{at}</p></zb-clock>";
    assert_error(default, "{}", "only exists at runtime");
    assert!(compile(default, r#"{"at":5}"#)
        .unwrap()
        .contains("<p>5</p>"));
}

#[test]
fn script_errors_are_reported_where_they_happen() {
    let syntax = error(
        "<script>\nconst ok = 1\nconst = 2\n</script>\n<zb-x><p></p></zb-x>",
        "{}",
    );
    assert!(syntax.message.starts_with("invalid <script>"));
    assert_eq!(syntax.span.line, 3);

    let order = error(
        "<script>\nconst a = b + 1\nconst b = 2\n</script>\n<zb-x><p></p></zb-x>",
        "{}",
    );
    assert!(order.message.contains("`b` is used before it is declared"));

    let types = error(
        "<script>\nconst x = 1 - \"a\"\n</script>\n<zb-x><p></p></zb-x>",
        "{}",
    );
    assert!(types.message.contains("in `x`"));
    assert_eq!(types.span, zubra::Span::new(2, 7));

    assert_error(
        "<script>const a = 1\nconst a = 2</script><zb-x><p></p></zb-x>",
        "{}",
        "declared more than once",
    );
}

// ---- references -----------------------------------------------------------------------------

#[test]
fn rejects_unknown_references_with_location_and_suggestion() {
    let diagnostic = error(
        "<zb-greeting name>\n  <p>Hi {nmae}</p>\n</zb-greeting>",
        r#"{"name":"Mikey"}"#,
    );
    assert_eq!(diagnostic.message, "unknown reference `nmae`");
    assert_eq!(diagnostic.span, zubra::Span::new(2, 9));
    assert_eq!(diagnostic.help.as_deref(), Some("did you mean `name`?"));
}

#[test]
fn checks_references_in_branches_that_are_not_rendered() {
    // A typo behind a false condition, inside an else, or in an empty loop is still an error.
    for source in [
        "<zb-x><main><zb-if test={false && missing}><p></p></zb-if></main></zb-x>",
        "<zb-x><main><zb-if test={true}><p>Shown</p><zb-else><p>{missing}</p></zb-else></zb-if></main></zb-x>",
        "<zb-x items={[]}><ul><zb-each items={items} as=\"item\"><li>{missing}</li></zb-each></ul></zb-x>",
    ] {
        assert_error(source, "{}", "unknown reference `missing`");
    }
}

#[test]
fn reports_v0_2_syntax_with_migration_help() {
    assert_error(
        "component: Old\nprop name: string\n---\n<p>{{ name }}</p>",
        "{}",
        "v0.2 syntax; declare the component with its host tag",
    );
    assert_error(
        "<zb-x name><p>{{ name }}</p></zb-x>",
        "{}",
        "v0.3 uses single braces",
    );
    assert_error(
        "<zb-x><main><mnix-if test={true}><p></p></mnix-if></main></zb-x>",
        "{}",
        "renamed to <zb-if>",
    );
}

// ---- safety ---------------------------------------------------------------------------------

#[test]
fn rejects_unsafe_static_and_dynamic_urls() {
    assert_error(
        "<zb-link><a href=\"javascript:alert(1)\">Open</a></zb-link>",
        "{}",
        "unsafe URL",
    );
    assert_error(
        "<zb-link><a href=\"javascript&colon;alert(1)\">Open</a></zb-link>",
        "{}",
        "unsafe URL",
    );
    assert_error(
        GREETING,
        r#"{"name":"x","url":"data:text/html,bad"}"#,
        "unsafe URL in `href`",
    );
    assert_error(
        "<zb-link host=\"evil\"><a href=\"//{host}.example\">Open</a></zb-link>",
        "{}",
        "unsafe URL",
    );
    assert_error(
        "<zb-link scheme=\"javascript\"><a href=\"{scheme}:alert(1)\">Open</a></zb-link>",
        "{}",
        "unsafe URL",
    );
    // An unsafe literal URL in a branch that isn't rendered is still rejected.
    assert_error(
        "<zb-x><main><zb-if test={true}><p>Shown</p><zb-else><a href=\"javascript:bad()\">x</a></zb-else></zb-if></main></zb-x>",
        "{}",
        "unsafe URL",
    );
    assert!(compile(GREETING, r#"{"name":"x","url":"/safe/path"}"#).is_ok());
}

#[test]
fn validates_srcset_and_srcdoc() {
    assert!(compile(
        "<zb-pic><img srcset=\"/small.webp 1x, https://mnix.dev/large.webp 2x\"></zb-pic>",
        "{}"
    )
    .is_ok());
    assert_error(
        "<zb-pic><img srcset=\"/small.webp 1x, javascript:alert(1) 2x\"></zb-pic>",
        "{}",
        "unsafe or empty URL",
    );
    // A dynamic srcset: each candidate is checked once its value is known.
    let source = "<zb-pic s=\"\"><img srcset={s}><img srcset=\"{s}\"></zb-pic>";
    assert_eq!(
        compile(source, r#"{"s":"/a-480.webp 480w, https://mnix.dev/a-960.webp 960w,"}"#).unwrap(),
        "<zb-pic s=\"/a-480.webp 480w, https://mnix.dev/a-960.webp 960w,\"><img srcset=\"/a-480.webp 480w, https://mnix.dev/a-960.webp 960w,\"><img srcset=\"/a-480.webp 480w, https://mnix.dev/a-960.webp 960w,\"></zb-pic>"
    );
    // No candidates yet (the "" default): no attribute.
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-pic><img><img></zb-pic>"
    );
    for unsafe_value in [
        "/a 1x, javascript:alert(1) 2x",
        "data:image/png;base64,AAAA 1x",
        " , ",
    ] {
        assert_error(
            source,
            &serde_json::to_string(&json!({ "s": unsafe_value })).unwrap(),
            "unsafe or empty URL candidate",
        );
    }
    assert_error(
        "<zb-pic s={{}}><img {...s}></zb-pic>",
        r#"{"s":{"srcset":"/a 1x, javascript:alert(1) 2x"}}"#,
        "unsafe or empty URL candidate",
    );
    assert_error(
        "<zb-frame c=\"x\"><iframe srcdoc={c}></iframe></zb-frame>",
        "{}",
        "srcdoc",
    );
}

#[test]
fn rejects_malformed_html_and_unsafe_template_features() {
    for (source, expected) in [
        ("<zb-x><p></section></zb-x>", "does not match"),
        ("<zb-x><p></zb-x>", "does not match"),
        ("<zb-x><p>", "missing closing tag"),
        ("<zb-x><script>alert(1)</script></zb-x>", "<script>"),
        (
            "<zb-x><button onclick=\"run()\">Go</button></zb-x>",
            "event-handler",
        ),
        (
            "<zb-x c=\"red\"><div style=\"color: {c}\">Text</div></zb-x>",
            "can't interpolate",
        ),
        (
            "<zb-x><p title=bare>x</p></zb-x>",
            "quoted text or a {…} expression",
        ),
        ("<zb-x><p>{ }</p></zb-x>", "empty {} expression"),
        (
            "<script>const a = {}</script>\n<zb-x><p>{a.b(1)}</p></zb-x>",
            "runs in the browser only",
        ),
        ("<zb-x><p>{a.b(1)}</p></zb-x>", "unknown reference `a`"),
        ("<zb-x></zb-x><zb-y></zb-y>", "after the host element"),
    ] {
        assert_error(source, "{}", expected);
    }
}

#[test]
fn event_handlers_are_resolved_but_left_out_of_static_html() {
    let source = "<script>function go() {}</script>\n<zb-x><button onclick={go} type=\"button\">Go</button></zb-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-x><button type=\"button\">Go</button></zb-x>"
    );
    assert_error(
        "<zb-x><button onclick={og}>Go</button></zb-x>",
        "{}",
        "unknown reference `og`",
    );
}

#[test]
fn dynamic_text_beside_other_nodes_gets_a_hydration_anchor() {
    let source = "<zb-x name=\"Ada\"><p>Hi <b>there</b> {name}!</p></zb-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-x><p>Hi <b>there</b><?zb ?> Ada!</p></zb-x>"
    );
    // An element's only child needs no anchor.
    assert_eq!(
        compile("<zb-x n=\"A\"><p>Hi {n}</p></zb-x>", "{}").unwrap(),
        "<zb-x><p>Hi A</p></zb-x>"
    );
    // Text split by a comment is one text node.
    assert_eq!(
        compile("<zb-x n=\"A\"><p>Hi <!-- c -->{n}</p></zb-x>", "{}").unwrap(),
        "<zb-x><p>Hi A</p></zb-x>"
    );
}

#[test]
fn reports_expression_errors_at_their_position_in_the_file() {
    let diagnostic = error("<zb-x a={1}>\n  <p>{a +* 2}</p>\n</zb-x>", "{}");
    assert_eq!(diagnostic.span, zubra::Span::new(2, 10));
}

#[test]
fn rejects_interpolating_objects() {
    assert_error(
        "<zb-x data={{ a: 1 }}><p>{data}</p></zb-x>",
        "{}",
        "cannot interpolate an object",
    );
}

#[test]
fn the_host_is_the_root_so_templates_may_have_any_number_of_top_level_nodes() {
    assert_eq!(compile("<zb-x></zb-x>", "{}").unwrap(), "<zb-x></zb-x>");
    assert_eq!(
        compile(
            "<zb-x name=\"Ada\">Hi {name} <p>One</p><p>Two</p></zb-x>",
            "{}"
        )
        .unwrap(),
        "<zb-x><?zb ?>Hi Ada <p>One</p><p>Two</p></zb-x>"
    );
    let js = compile_js(
        "<zb-x name=\"Ada\">Hi {name} <p>One</p></zb-x>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap();
    assert!(js.contains(r#"template: "<!----><p>One</p>""#), "{js}");
    assert!(
        js.contains(r#"{ path: [0], anchor: () => "Hi " + $t($p.name) + " " }"#),
        "{js}"
    );
}

// ---- directives -----------------------------------------------------------------------------

#[test]
fn selects_compile_time_branches_with_javascript_truthiness() {
    let source = r#"<zb-status active={false} status="" count={0}>
<main><zb-if test={active && (status == "ready" || count)}><p>Ready</p><zb-else><p>Waiting</p></zb-else></zb-if></main>
</zb-status>"#;
    let ready = compile(source, r#"{"active":true,"status":"","count":3}"#).unwrap();
    assert!(ready.contains("<p>Ready</p>") && !ready.contains("Waiting"));
    assert!(!ready.contains("zb-if") && !ready.contains("zb-else"));
    let waiting = compile(source, r#"{"active":true,"status":"","count":0}"#).unwrap();
    assert!(waiting.contains("<p>Waiting</p>") && !waiting.contains("Ready"));
}

#[test]
fn directive_attributes_are_expressions() {
    assert_error(
        "<zb-x><main><zb-if test=\"ready\"><p></p></zb-if></main></zb-x>",
        "{}",
        "write test={…}",
    );
    assert_error(
        "<zb-x><main><zb-if><p></p></zb-if></main></zb-x>",
        "{}",
        "requires a `test={…}`",
    );
    assert_error(
        "<zb-x><main><zb-if test={true} other=\"x\"><p>Yes</p></zb-if></main></zb-x>",
        "{}",
        "unexpected attribute `other`",
    );
}

#[test]
fn expands_loops_over_any_values_with_member_access_and_index() {
    let source = r#"<script>
const everyone = [{ name: "Ada", role: "<admin>" }, { name: "Linus", role: "dev" }]
</script>
<zb-team people={everyone}>
<ul><zb-each items={people} as="person" index="i"><li data-n={i + 1}>{person.name} ({person.role})</li></zb-each></ul>
</zb-team>"#;
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-team>\n<ul><?zb [?><?zb [?><li data-n=\"1\">Ada (&lt;admin&gt;)</li><?zb ]?><?zb [?><li data-n=\"2\">Linus (dev)</li><?zb ]?><?zb ]?></ul>\n</zb-team>"
    );
    assert!(compile(source, r#"{"people":[]}"#)
        .unwrap()
        .contains("<ul><?zb [?><?zb ]?></ul>"));
    assert_error(source, r#"{"people":{"a":1}}"#, "must be an array");
}

#[test]
fn loop_variables_shadow_props_and_stay_scoped() {
    let source = "<zb-x name=\"outer\" items={[\"inner\"]}><p><zb-each items={items} as=\"name\">{name}</zb-each>/{name}</p></zb-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-x><p><?zb [?><?zb [?><?zb ?>inner<?zb ]?><?zb ]?><?zb ?>/outer</p></zb-x>"
    );
    assert_error(
        "<zb-x items={[1]}><p><zb-each items={items} as=\"item\" index=\"item\">x</zb-each></p></zb-x>",
        "{}",
        "different from `as`",
    );
}

#[test]
fn rejects_misplaced_else() {
    assert_error(
        "<zb-x><main><zb-else><p>Else</p></zb-else></main></zb-x>",
        "{}",
        "only valid as a direct child",
    );
    assert_error(
        "<zb-x><main><zb-if test={true}><p>Yes</p><zb-else><p>No</p></zb-else><p>After</p></zb-if></main></zb-x>",
        "{}",
        "zb-else must be the final child",
    );
}

// ---- slots ----------------------------------------------------------------------------------

#[test]
fn fills_named_and_default_slots_from_parsed_template_fragments() {
    let source = "<zb-panel title><main><zb-slot name=\"heading\"><h1>{title}</h1></zb-slot><zb-slot><p>Default fallback</p></zb-slot></main></zb-panel>";
    let html = compile_with_slots(
        source,
        r#"{"title":"Panel title"}"#,
        r#"{"heading":"<h2>{title}</h2>","default":"<p>Supplied default</p>"}"#,
    )
    .unwrap();
    assert_eq!(html, "<zb-panel title=\"Panel title\"><main><?zb [!?><h2>Panel title</h2><?zb ]?><?zb [!?><p>Supplied default</p><?zb ]?></main></zb-panel>");
    assert!(!html.contains("zb-slot"));
    assert_eq!(
        compile(source, r#"{"title":"Fallback title"}"#).unwrap(),
        "<zb-panel title=\"Fallback title\"><main><?zb [?><h1>Fallback title</h1><?zb ]?><?zb [?><p>Default fallback</p><?zb ]?></main></zb-panel>"
    );
}

#[test]
fn rejects_unknown_slots_invalid_slot_markup_and_recursive_expansion() {
    let source =
        "<zb-panel><main><zb-slot name=\"content\"><p>Fallback</p></zb-slot></main></zb-panel>";
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
    assert!(
        compile_with_slots(source, "{}", r#"{"content":"<p>{missing}</p>"}"#)
            .unwrap_err()
            .message
            .contains("unknown reference `missing`")
    );

    let recursive = "<zb-panel><main><zb-slot name=\"content\"></zb-slot></main></zb-panel>";
    assert!(compile_with_slots(
        recursive,
        "{}",
        r#"{"content":"<zb-slot name=\"content\"></zb-slot>"}"#
    )
    .unwrap_err()
    .message
    .contains("recursive slot expansion"));
}

// ---- diagnostics ----------------------------------------------------------------------------

#[test]
fn renders_diagnostics_with_the_source_line() {
    let source = "<zb-x title>\n  <h1>{titel}</h1>\n</zb-x>";
    let rendered = error(source, r#"{"title":"t"}"#).render(source, "x.zb");
    assert_eq!(
        rendered,
        "error: unknown reference `titel`\n --> x.zb:2:7\n  |\n2 |   <h1>{titel}</h1>\n  |       ^\n  = help: did you mean `title`?\n"
    );
}

// ---- JavaScript output ----------------------------------------------------------------------

fn js(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "test.zb").unwrap()
}

#[test]
fn js_output_binds_text_attributes_and_events_by_path() {
    let module = js(r#"<script>
import { state } from '@zubra/runtime'
const count = state(0)
function go() {}
</script>
<zb-x label="Hi" href="/" off={false}>
  <p>Hi <b>there</b> {label}!</p>
  <a href={href} class="link {label}" hidden={off} onclick={go}>{count}</a>
</zb-x>"#);
    assert!(module.contains(
        "import { $define, $r, $t } from \"@zubra/runtime\";\nimport { state } from '@zubra/runtime';"
    ));
    assert!(module.contains(r#"template: "\n  <p>Hi <b>there</b><!----></p>\n  <a></a>\n","#));
    for part in [
        r#"{ path: [0, 1], anchor: () => " " + $t($p.label) + "!" }"#,
        r#"{ path: [1], attribute: "href", url: true, value: () => $p.href }"#,
        r#"{ path: [1], attribute: "class", value: () => "link " + $t($p.label) }"#,
        r#"{ path: [1], attribute: "hidden", boolean: true, value: () => $p.off }"#,
        r#"{ path: [1], on: "click", handler: () => $r(go) }"#,
        r#"{ path: [1], text: () => $t($r(count)) }"#,
    ] {
        assert!(module.contains(part), "missing {part} in\n{module}");
    }
    assert!(
        module.contains("const count = state(0)"),
        "the script body runs in setup"
    );
    assert!(module.contains(r#""off": { attribute: "off", default: false, required: false }"#));
}

#[test]
fn js_output_keeps_props_without_defaults_and_kebab_attributes() {
    let module = js("<zb-x max-value name><p>{maxValue} {name}</p></zb-x>");
    assert!(module
        .contains(r#""maxValue": { attribute: "max-value", default: undefined, required: true }"#));
    assert!(module.contains(r#"{ path: [0], text: () => $t($p.maxValue) + " " + $t($p.name) }"#));
}

#[test]
fn js_output_rejects_what_it_cannot_do_yet() {
    let slot_in_loop = compile_js(
        "<zb-x items={[]}><ul><zb-each items={items} as=\"i\"><li><zb-slot></zb-slot></li></zb-each></ul></zb-x>",
        "r",
        "t",
    )
    .unwrap_err();
    assert!(slot_in_loop
        .message
        .contains("zb-slot can't be inside zb-each"));
    let reserved = compile_js(
        "<script>const $p = 1</script><zb-x><p></p></zb-x>",
        "r",
        "t",
    )
    .unwrap_err();
    assert!(reserved.message.contains("reserved"));
    let typo = compile_js("<zb-x name><p>{nmae}</p></zb-x>", "r", "t").unwrap_err();
    assert_eq!(typo.help.as_deref(), Some("did you mean `name`?"));
}

#[test]
fn both_backends_agree_on_anchors() {
    let source = "<zb-x name=\"Ada\"><p>Hi <b>there</b> {name}!</p></zb-x>";
    assert!(compile(source, "{}")
        .unwrap()
        .contains("<b>there</b><?zb ?> Ada!"));
    assert!(js(source).contains("<b>there</b><!---->"));
}

#[test]
fn js_output_compiles_regions_to_nested_blocks() {
    let module = js(r#"<zb-x items={["a"]} show={true}>
<section><zb-if test={show}><ul><zb-each items={items} as="item" index="i"><li data-i={i}>{item}</li></zb-each></ul><zb-else><p>none</p></zb-else></zb-if><footer>{items.length}</footer></section>
</zb-x>"#);
    // The region is one position in its parent, so the footer's path doesn't depend on it.
    assert!(
        module.contains(r#"template: "\n<section><!--[--><!--]--><footer></footer></section>\n","#)
    );
    assert!(module.contains(r#"{ path: [0, 1], text: () => $t($p.items.length) }"#));
    assert!(module.contains(r#"{ path: [0, 0], when: () => $p.show, blocks: [{ template: "<ul><!--[--><!--]--></ul>", parts: () => [{ path: [0, 0], each: () => $p.items, block: { template: "<li></li>", parts: (item, i) => [{ path: [0], attribute: "data-i", value: () => $r(i) }, { path: [0], text: () => $t($r(item)) }] } }] }, { template: "<p>none</p>", parts: () => [] }] }"#), "{module}");
}

#[test]
fn loop_variables_shadow_props_in_js_output_too() {
    let module = js(
        r#"<zb-x name="outer" names={["a"]}><p><zb-each items={names} as="name">{name}</zb-each>{name}</p></zb-x>"#,
    );
    assert!(
        module.contains(r#"parts: (name, $index) => [{ path: [0], anchor: () => $t($r(name)) }]"#),
        "{module}"
    );
    assert!(
        module.contains(r#"{ path: [0, 1], anchor: () => $t($p.name) }"#),
        "{module}"
    );
}

#[test]
fn keyed_lists_check_keys_at_build_time() {
    let source = r#"<zb-x todos={[{ id: 1, t: "a" }, { id: "two", t: "b" }]}><ul><zb-each items={todos} as="todo" key={todo.id}><li>{todo.t}</li></zb-each></ul></zb-x>"#;
    assert!(compile(source, "{}").unwrap().contains("<li>a</li>"));
    let duplicate = error(source, r#"{"todos":[{"id":1,"t":"a"},{"id":1,"t":"b"}]}"#);
    assert_eq!(duplicate.message, "duplicate zb-each key 1 (row 2)");
    assert_error(
        source,
        r#"{"todos":[{"id":null,"t":"a"}]}"#,
        "key must be a string or number, found null",
    );
    assert_error(
        "<zb-x todos={[]}><ul><zb-each items={todos} as=\"todo\" key={tood.id}><li></li></zb-each></ul></zb-x>",
        "{}",
        "unknown reference `tood`",
    );
    assert_error(
        "<zb-x todos={[]}><ul><zb-each items={todos} as=\"todo\" key=\"id\"><li></li></zb-each></ul></zb-x>",
        "{}",
        "write key={…}",
    );
}

#[test]
fn keyed_lists_compile_a_key_function_over_plain_values() {
    let module = js(
        r#"<zb-x todos={[]}><ul><zb-each items={todos} as="todo" key={todo.id}><li>{todo.t}</li></zb-each></ul></zb-x>"#,
    );
    assert!(
        module.contains("each: () => $p.todos, key: (todo, $index) => $r(todo).id, block:"),
        "{module}"
    );
}

#[test]
fn slots_compile_to_regions_in_light_dom_and_native_slots_in_shadow_dom() {
    let light = js("<zb-x title=\"t\"><main><zb-slot name=\"heading\"><h1>{title}</h1></zb-slot><zb-slot></zb-slot></main></zb-x>");
    assert!(
        light.contains(r#"slots: ["default", "heading"],"#),
        "{light}"
    );
    assert!(light.contains(r#"{ path: [0, 0], slot: "heading", fallback: { template: "<h1></h1>", parts: () => [{ path: [0], text: () => $t($p.title) }] } }"#), "{light}");
    assert!(
        light.contains(r#"{ path: [0, 1], slot: "default", fallback: null }"#),
        "{light}"
    );

    let shadow = js("<zb-x shadow title=\"t\"><main><zb-slot name=\"heading\"><h1>{title}</h1></zb-slot></main></zb-x>");
    assert!(
        shadow.contains(r#"template: "<main><slot name=\"heading\"><h1></h1></slot></main>","#),
        "{shadow}"
    );
    assert!(
        shadow.contains(r#"{ path: [0, 0, 0], text: () => $t($p.title) }"#),
        "{shadow}"
    );
}

#[test]
fn shadow_components_put_supplied_slot_content_in_light_dom() {
    let source = "<zb-x shadow><main><zb-slot name=\"heading\"><h1>Fallback</h1></zb-slot><zb-slot>empty</zb-slot></main></zb-x>";
    assert_eq!(
        compile_with_slots(source, "{}", r#"{"heading":"<h2>Mine</h2>","default":"Body"}"#).unwrap(),
        "<zb-x><template shadowrootmode=\"open\"><main><slot name=\"heading\"><h1>Fallback</h1></slot><slot>empty</slot></main></template><h2 slot=\"heading\">Mine</h2>Body</zb-x>"
    );
    assert!(
        compile_with_slots(source, "{}", r#"{"heading":"just text"}"#)
            .unwrap_err()
            .message
            .contains("must be elements")
    );
}

#[test]
fn form_associated_is_a_flag_not_a_prop() {
    let source = "<zb-x form-associated label=\"L\"><p>{label}</p></zb-x>";
    assert_eq!(compile(source, "{}").unwrap(), "<zb-x><p>L</p></zb-x>");
    assert!(js(source).contains("  form: true,\n"));
    assert!(js("<zb-x><p>x</p></zb-x>").contains("  form: false,\n"));
    assert!(compile(source, r#"{"formAssociated":true}"#)
        .unwrap_err()
        .message
        .contains("unknown prop"));
    let dts = zubra::compile_declarations(source, "x.zb").unwrap();
    assert!(dts.contains("readonly form: HTMLFormElement | null;"));
    assert!(dts.contains("name: string | null;"));
    assert!(dts.contains("checkValidity(): boolean;"));
    let named = zubra::compile_declarations(
        "<zb-x form-associated name=\"n\"><p>{name}</p></zb-x>",
        "x.zb",
    )
    .unwrap();
    assert!(
        !named.contains("name: string | null;"),
        "a `name` prop takes precedence"
    );
}

#[test]
fn props_that_shadow_built_in_element_properties_are_warned_about() {
    let warnings =
        zubra::warnings("<zb-x title=\"\" hidden={false} label=\"\">\n  <p>{label}</p>\n</zb-x>");
    let messages: Vec<_> = warnings
        .iter()
        .map(|warning| warning.message.as_str())
        .collect();
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert!(messages[0].starts_with("prop `title` is also every element's built-in `title`"));
    assert!(messages[1].contains("also hides the element"));
    assert_eq!(warnings[0].span.column, 7);
    assert!(warnings[0]
        .render_warning("<zb-x title=\"\">", "x.zb")
        .starts_with("warning: prop `title`"));
    assert!(zubra::warnings("<zb-x label=\"\"><p>x</p></zb-x>").is_empty());
}

#[test]
fn defaults_that_use_runtime_values_are_computed_in_the_browser() {
    let source = "<script>\n  const start = Date.now()\n  const fallback = window.innerWidth ?? 0\n</script>\n<zb-x since={start} width={fallback}>\n  <p>{since}</p>\n</zb-x>";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(
        js.contains("\"since\": { attribute: \"since\", default: undefined, required: false }"),
        "{js}"
    );
    assert!(js.contains("  setup($p, $emit, $initial) {"), "{js}");
    assert!(js.contains("    $initial(\"since\", () => $r(start));\n    $initial(\"width\", () => $r(fallback));"), "{js}");
    let dts = zubra::compile_declarations(source, "x.zb").unwrap();
    assert!(dts.contains("Default: computed by the component."), "{dts}");
    assert!(
        dts.contains("  since?: unknown;"),
        "optional in the props interface: {dts}"
    );
    // HTML needs the value from outside.
    let error = compile(source, "{}").unwrap_err();
    assert!(
        error.message.contains("only exists at runtime"),
        "{}",
        error.message
    );
    assert!(compile(source, r#"{"since": 1, "width": 2}"#)
        .unwrap()
        .contains("<p>1</p>"));
    // A typo is still a typo; only the browser's globals make a binding runtime-only.
    let error = compile(
        "<script>\n  const a = windw.x\n</script>\n<zb-x><p>x</p></zb-x>",
        "{}",
    )
    .unwrap_err();
    assert!(
        error
            .message
            .contains("`windw` is used before it is declared"),
        "{}",
        error.message
    );
    // Without runtime defaults, setup keeps its shape.
    assert!(
        compile_js("<zb-x a=\"1\"><p>{a}</p></zb-x>", "@zubra/runtime", "x.zb")
            .unwrap()
            .contains("  setup($p, $emit) {")
    );
}

#[test]
fn server_rendered_slot_html_is_kept_as_written() {
    use zubra::{compile_html_from, SlotSource};
    let loader = |_: &str, _: &str| -> Result<(String, String), String> { Err("none".into()) };
    let source = "<zb-panel><main><zb-slot><p>Fallback</p></zb-slot></main></zb-panel>";
    let slots = serde_json::json!({
        "default": "<p data-x={a}>{\"json\"}</p><!--astro:end--><script type=\"application/json\">{\"a\":1}</script><input value=raw onclick=\"go()\"><zb-slot></zb-slot>"
    })
    .to_string();
    let html =
        compile_html_from(source, "panel.zb", "{}", &slots, SlotSource::Html, &loader).unwrap();
    assert_eq!(
        html,
        "<zb-panel><main><?zb [!?><p data-x=\"{a}\">{\"json\"}</p><!--astro:end--><script type=\"application/json\">{\"a\":1}</script><input value=\"raw\" onclick=\"go()\"><zb-slot></zb-slot><?zb ]?></main></zb-panel>"
    );
    // The same content is an error as a template (and stays one).
    assert!(compile_html_from(
        source,
        "panel.zb",
        "{}",
        &slots,
        SlotSource::Template,
        &loader
    )
    .is_err());
    assert!(compile_html_from(
        source,
        "panel.zb",
        "{}",
        r#"{"default":"<p>Broken</main>"}"#,
        SlotSource::Html,
        &loader
    )
    .unwrap_err()
    .message
    .contains("does not match"));
}

#[test]
fn a_runtime_hook_used_without_its_import_is_an_error_with_the_fix() {
    let error = zubra::compile_js(
        "<script>\n  import { onMount } from '@zubra/runtime'\n  onMount(() => {})\n  const doubled = computed(() => 2)\n</script>\n<x-a><p>{doubled}</p></x-a>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert!(
        error
            .message
            .contains("`computed` is a hook from @zubra/runtime, but the script doesn't import it"),
        "{}",
        error.message
    );
    assert_eq!(
        error.help.as_deref(),
        Some("import it: `import { computed } from '@zubra/runtime'`")
    );
    // Declared or imported under the name, or a prop with it: fine.
    for source in [
        "<script>\n  import { computed } from '@zubra/runtime'\n  const d = computed(() => 2)\n</script>\n<x-a><p>{d}</p></x-a>",
        "<script>\n  function state() { return 1 }\n  const d = state()\n</script>\n<x-a><p>{d}</p></x-a>",
        "<script>\n  import * as id from './id.js'\n  const d = id.next()\n</script>\n<x-a><p>{d}</p></x-a>",
        "<script>\n  const d = keys + 1\n</script>\n<x-a keys={1}><p>{d}</p></x-a>",
    ] {
        zubra::compile_js(source, "@zubra/runtime", "x.zb").unwrap_or_else(|error| panic!("{source}: {}", error.message));
    }
}
