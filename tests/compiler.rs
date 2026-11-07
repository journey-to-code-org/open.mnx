use mnix_compiler::{compile, compile_js, compile_value, compile_with_slots, Diagnostic};
use serde_json::json;

const GREETING: &str = r#"<mnx-greeting name url>
  <article class="greeting"><h1>Hello, {name}!</h1><a href={url}>Visit</a></article>
</mnx-greeting>"#;

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
        "<mnx-greeting name=\"Mikey\" url=\"https://mnix.dev\">\n  <article class=\"greeting\"><h1>Hello, Mikey!</h1><a href=\"https://mnix.dev\">Visit</a></article>\n</mnx-greeting>"
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
    let source = "<mnx-notice text>\n<p title=\"A &amp; B\">{text}</p>\n</mnx-notice>";
    let html = compile(source, r#"{"text":"x > y"}"#).unwrap();
    assert_eq!(
        html,
        "<mnx-notice text=\"x &gt; y\">\n<p title=\"A &amp; B\">x &gt; y</p>\n</mnx-notice>"
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
<mnx-card name={full} count={tags.length}>
  <p>{name} ({count} tags, first: {tags[0]})</p>
</mnx-card>"#;
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-card>\n  <p>Mikey Nichols (2 tags, first: rust)</p>\n</mnx-card>"
    );
}

#[test]
fn props_shadow_script_bindings_inside_the_template() {
    let source =
        "<script>const title = \"Script\"</script>\n<mnx-x title={title}><h1>{title}</h1></mnx-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-x><h1>Script</h1></mnx-x>"
    );
    assert_eq!(
        compile(source, r#"{"title":"Override"}"#).unwrap(),
        "<mnx-x title=\"Override\"><h1>Override</h1></mnx-x>"
    );
}

#[test]
fn renders_scalars_member_access_and_expressions() {
    let source = "<mnx-summary count={0} active={false} user={null}><p>{count + 1} {active} {user?.name ?? \"anon\"} {count > 0 ? \"some\" : \"none\"}</p></mnx-summary>";
    assert_eq!(
        compile_value(source, &json!({ "count": 3, "active": true, "user": { "name": "Zoë" } })).unwrap(),
        "<mnx-summary count=\"3\" active user=\"{&quot;name&quot;:&quot;Zoë&quot;}\"><p>4 true Zoë some</p></mnx-summary>"
    );
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-summary><p>1 false anon none</p></mnx-summary>"
    );
    assert!(compile(source, "[]")
        .unwrap_err()
        .message
        .contains("must be a JSON object"));
}

#[test]
fn camel_case_props_are_written_kebab_case_on_the_host() {
    let source = "<mnx-counter max-value={10}><p>{maxValue}</p></mnx-counter>";
    assert_eq!(
        compile(source, r#"{"maxValue":5}"#).unwrap(),
        "<mnx-counter max-value=\"5\"><p>5</p></mnx-counter>"
    );
    assert_error(
        "<mnx-counter maxValue={10}><p></p></mnx-counter>",
        "{}",
        "lowercases attribute names",
    );
}

#[test]
fn boolean_attributes_render_by_presence_and_require_booleans() {
    let source =
        "<mnx-toggle active={false}><button disabled={active}>Toggle</button></mnx-toggle>";
    assert_eq!(
        compile(source, r#"{"active":true}"#).unwrap(),
        "<mnx-toggle active><button disabled>Toggle</button></mnx-toggle>"
    );
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-toggle><button>Toggle</button></mnx-toggle>"
    );

    assert_error(
        "<mnx-toggle label=\"x\"><button disabled={label}>Toggle</button></mnx-toggle>",
        "{}",
        "must be true or false",
    );
    assert_error(
        "<mnx-toggle active={true}><button disabled=\"{active}\">Toggle</button></mnx-toggle>",
        "{}",
        "bind it with disabled={…}",
    );
}

#[test]
fn default_true_booleans_round_trip_as_false() {
    let source = "<mnx-panel open={true}><p>{open}</p></mnx-panel>";
    assert_eq!(
        compile(source, r#"{"open":false}"#).unwrap(),
        "<mnx-panel open=\"false\"><p>false</p></mnx-panel>"
    );
}

#[test]
fn null_valued_attributes_are_omitted() {
    let source = "<mnx-x label={null}><p title={label}>x</p></mnx-x>";
    assert_eq!(compile(source, "{}").unwrap(), "<mnx-x><p>x</p></mnx-x>");
}

#[test]
fn parses_unicode_svg_and_comments() {
    let source = "<!-- a note -->\n<mnx-icon name=\"Zoë\"><!-- inner --><svg viewBox=\"0 0 10 10\"><title>Héllo, {name}</title><path d=\"M0 0\"></path></svg></mnx-icon>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-icon><svg viewBox=\"0 0 10 10\"><title>Héllo, Zoë</title><path d=\"M0 0\"></path></svg></mnx-icon>"
    );
}

#[test]
fn records_the_shadow_flag_without_making_it_a_prop() {
    let source = "<mnx-x shadow><p>x</p></mnx-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-x><template shadowrootmode=\"open\"><p>x</p></template></mnx-x>"
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
        "<mnx-x count={0}><p>{count}</p></mnx-x>",
        r#"{"count":"3"}"#,
        "prop `count` must be a number (like its default), found a string",
    );
}

#[test]
fn rejects_duplicate_props_attributes_and_invalid_host_names() {
    assert_error("<mnx-x a a><p></p></mnx-x>", "{}", "duplicate attribute");
    assert_error(
        "<mnx-x><p id=\"a\" id=\"b\">Text</p></mnx-x>",
        "{}",
        "duplicate attribute",
    );
    let no_hyphen = error("<header><p></p></header>", "{}");
    assert!(no_hyphen
        .message
        .contains("not a valid custom-element name"));
    assert_eq!(
        no_hyphen.help.as_deref(),
        Some("custom element names need a hyphen, e.g. `header-element`")
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
        "<mnx-x label=\"a {b}\"><p></p></mnx-x>",
        "{}",
        "can't interpolate",
    );
}

// ---- script ---------------------------------------------------------------------------------

#[test]
fn runtime_only_script_names_resolve_but_cannot_render_statically() {
    let source = "<script>\nconst now = Date.now()\nfunction label() { return 'x' }\n</script>\n<mnx-clock><p>{now}</p></mnx-clock>";
    let diagnostic = error(source, "{}");
    assert!(diagnostic.message.contains("`now` only exists at runtime"));
    assert_eq!(diagnostic.span.line, 5);

    // Declared but unused runtime names are fine.
    let unused = "<script>function label() { return 'x' }</script>\n<mnx-x><p>static</p></mnx-x>";
    assert_eq!(
        compile(unused, "{}").unwrap(),
        "<mnx-x><p>static</p></mnx-x>"
    );

    // A runtime-only prop default can be supplied at build time instead.
    let default =
        "<script>const now = Date.now()</script>\n<mnx-clock at={now}><p>{at}</p></mnx-clock>";
    assert_error(default, "{}", "only exists at runtime");
    assert!(compile(default, r#"{"at":5}"#)
        .unwrap()
        .contains("<p>5</p>"));
}

#[test]
fn script_errors_are_reported_where_they_happen() {
    let syntax = error(
        "<script>\nconst ok = 1\nconst = 2\n</script>\n<mnx-x><p></p></mnx-x>",
        "{}",
    );
    assert!(syntax.message.starts_with("invalid <script>"));
    assert_eq!(syntax.span.line, 3);

    let order = error(
        "<script>\nconst a = b + 1\nconst b = 2\n</script>\n<mnx-x><p></p></mnx-x>",
        "{}",
    );
    assert!(order.message.contains("`b` is used before it is declared"));

    let types = error(
        "<script>\nconst x = 1 - \"a\"\n</script>\n<mnx-x><p></p></mnx-x>",
        "{}",
    );
    assert!(types.message.contains("in `x`"));
    assert_eq!(types.span, mnix_compiler::Span::new(2, 7));

    assert_error(
        "<script>const a = 1\nconst a = 2</script><mnx-x><p></p></mnx-x>",
        "{}",
        "declared more than once",
    );
}

// ---- references -----------------------------------------------------------------------------

#[test]
fn rejects_unknown_references_with_location_and_suggestion() {
    let diagnostic = error(
        "<mnx-greeting name>\n  <p>Hi {nmae}</p>\n</mnx-greeting>",
        r#"{"name":"Mikey"}"#,
    );
    assert_eq!(diagnostic.message, "unknown reference `nmae`");
    assert_eq!(diagnostic.span, mnix_compiler::Span::new(2, 9));
    assert_eq!(diagnostic.help.as_deref(), Some("did you mean `name`?"));
}

#[test]
fn checks_references_in_branches_that_are_not_rendered() {
    // A typo behind a false condition, inside an else, or in an empty loop is still an error.
    for source in [
        "<mnx-x><main><mnx-if test={false && missing}><p></p></mnx-if></main></mnx-x>",
        "<mnx-x><main><mnx-if test={true}><p>Shown</p><mnx-else><p>{missing}</p></mnx-else></mnx-if></main></mnx-x>",
        "<mnx-x items={[]}><ul><mnx-each items={items} as=\"item\"><li>{missing}</li></mnx-each></ul></mnx-x>",
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
        "<mnx-x name><p>{{ name }}</p></mnx-x>",
        "{}",
        "v0.3 uses single braces",
    );
    assert_error(
        "<mnx-x><main><mnix-if test={true}><p></p></mnix-if></main></mnx-x>",
        "{}",
        "renamed to <mnx-if>",
    );
}

// ---- safety ---------------------------------------------------------------------------------

#[test]
fn rejects_unsafe_static_and_dynamic_urls() {
    assert_error(
        "<mnx-link><a href=\"javascript:alert(1)\">Open</a></mnx-link>",
        "{}",
        "unsafe URL",
    );
    assert_error(
        "<mnx-link><a href=\"javascript&colon;alert(1)\">Open</a></mnx-link>",
        "{}",
        "unsafe URL",
    );
    assert_error(
        GREETING,
        r#"{"name":"x","url":"data:text/html,bad"}"#,
        "unsafe URL in `href`",
    );
    assert_error(
        "<mnx-link host=\"evil\"><a href=\"//{host}.example\">Open</a></mnx-link>",
        "{}",
        "unsafe URL",
    );
    assert_error(
        "<mnx-link scheme=\"javascript\"><a href=\"{scheme}:alert(1)\">Open</a></mnx-link>",
        "{}",
        "unsafe URL",
    );
    // An unsafe literal URL in a branch that isn't rendered is still rejected.
    assert_error(
        "<mnx-x><main><mnx-if test={true}><p>Shown</p><mnx-else><a href=\"javascript:bad()\">x</a></mnx-else></mnx-if></main></mnx-x>",
        "{}",
        "unsafe URL",
    );
    assert!(compile(GREETING, r#"{"name":"x","url":"/safe/path"}"#).is_ok());
}

#[test]
fn validates_srcset_and_rejects_dynamic_srcset_and_srcdoc() {
    assert!(compile(
        "<mnx-pic><img srcset=\"/small.webp 1x, https://mnix.dev/large.webp 2x\"></mnx-pic>",
        "{}"
    )
    .is_ok());
    assert_error(
        "<mnx-pic><img srcset=\"/small.webp 1x, javascript:alert(1) 2x\"></mnx-pic>",
        "{}",
        "unsafe or empty URL",
    );
    assert_error(
        "<mnx-pic s=\"/a 1x\"><img srcset={s}></mnx-pic>",
        "{}",
        "dynamic srcset",
    );
    assert_error(
        "<mnx-frame c=\"x\"><iframe srcdoc={c}></iframe></mnx-frame>",
        "{}",
        "srcdoc",
    );
}

#[test]
fn rejects_malformed_html_and_unsafe_template_features() {
    for (source, expected) in [
        ("<mnx-x><p></section></mnx-x>", "does not match"),
        ("<mnx-x><p></mnx-x>", "does not match"),
        ("<mnx-x><p>", "missing closing tag"),
        ("<mnx-x><script>alert(1)</script></mnx-x>", "<script>"),
        (
            "<mnx-x><button onclick=\"run()\">Go</button></mnx-x>",
            "event-handler",
        ),
        (
            "<mnx-x><div style=\"color:red\">Text</div></mnx-x>",
            "inline style",
        ),
        (
            "<mnx-x><p title=bare>x</p></mnx-x>",
            "quoted text or a {…} expression",
        ),
        ("<mnx-x><p>{ }</p></mnx-x>", "empty {} expression"),
        (
            "<script>const a = {}</script>\n<mnx-x><p>{a.b(1)}</p></mnx-x>",
            "runs in the browser only",
        ),
        ("<mnx-x><p>{a.b(1)}</p></mnx-x>", "unknown reference `a`"),
        ("<mnx-x></mnx-x><mnx-y></mnx-y>", "after the host element"),
    ] {
        assert_error(source, "{}", expected);
    }
}

#[test]
fn event_handlers_are_resolved_but_left_out_of_static_html() {
    let source = "<script>function go() {}</script>\n<mnx-x><button onclick={go} type=\"button\">Go</button></mnx-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-x><button type=\"button\">Go</button></mnx-x>"
    );
    assert_error(
        "<mnx-x><button onclick={og}>Go</button></mnx-x>",
        "{}",
        "unknown reference `og`",
    );
}

#[test]
fn dynamic_text_beside_other_nodes_gets_a_hydration_anchor() {
    let source = "<mnx-x name=\"Ada\"><p>Hi <b>there</b> {name}!</p></mnx-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-x><p>Hi <b>there</b><!----> Ada!</p></mnx-x>"
    );
    // An element's only child needs no anchor.
    assert_eq!(
        compile("<mnx-x n=\"A\"><p>Hi {n}</p></mnx-x>", "{}").unwrap(),
        "<mnx-x><p>Hi A</p></mnx-x>"
    );
    // Text split by a comment is one text node.
    assert_eq!(
        compile("<mnx-x n=\"A\"><p>Hi <!-- c -->{n}</p></mnx-x>", "{}").unwrap(),
        "<mnx-x><p>Hi A</p></mnx-x>"
    );
}

#[test]
fn reports_expression_errors_at_their_position_in_the_file() {
    let diagnostic = error("<mnx-x a={1}>\n  <p>{a +* 2}</p>\n</mnx-x>", "{}");
    assert_eq!(diagnostic.span, mnix_compiler::Span::new(2, 10));
}

#[test]
fn rejects_interpolating_objects() {
    assert_error(
        "<mnx-x data={{ a: 1 }}><p>{data}</p></mnx-x>",
        "{}",
        "cannot interpolate an object",
    );
}

#[test]
fn the_host_is_the_root_so_templates_may_have_any_number_of_top_level_nodes() {
    assert_eq!(compile("<mnx-x></mnx-x>", "{}").unwrap(), "<mnx-x></mnx-x>");
    assert_eq!(
        compile(
            "<mnx-x name=\"Ada\">Hi {name} <p>One</p><p>Two</p></mnx-x>",
            "{}"
        )
        .unwrap(),
        "<mnx-x><!---->Hi Ada <p>One</p><p>Two</p></mnx-x>"
    );
    let js = compile_js(
        "<mnx-x name=\"Ada\">Hi {name} <p>One</p></mnx-x>",
        "@mnx/runtime",
        "x.mnx",
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
    let source = r#"<mnx-status active={false} status="" count={0}>
<main><mnx-if test={active && (status == "ready" || count)}><p>Ready</p><mnx-else><p>Waiting</p></mnx-else></mnx-if></main>
</mnx-status>"#;
    let ready = compile(source, r#"{"active":true,"status":"","count":3}"#).unwrap();
    assert!(ready.contains("<p>Ready</p>") && !ready.contains("Waiting"));
    assert!(!ready.contains("mnx-if") && !ready.contains("mnx-else"));
    let waiting = compile(source, r#"{"active":true,"status":"","count":0}"#).unwrap();
    assert!(waiting.contains("<p>Waiting</p>") && !waiting.contains("Ready"));
}

#[test]
fn directive_attributes_are_expressions() {
    assert_error(
        "<mnx-x><main><mnx-if test=\"ready\"><p></p></mnx-if></main></mnx-x>",
        "{}",
        "write test={…}",
    );
    assert_error(
        "<mnx-x><main><mnx-if><p></p></mnx-if></main></mnx-x>",
        "{}",
        "requires a `test={…}`",
    );
    assert_error(
        "<mnx-x><main><mnx-if test={true} other=\"x\"><p>Yes</p></mnx-if></main></mnx-x>",
        "{}",
        "unexpected attribute `other`",
    );
}

#[test]
fn expands_loops_over_any_values_with_member_access_and_index() {
    let source = r#"<script>
const people = [{ name: "Ada", role: "<admin>" }, { name: "Linus", role: "dev" }]
</script>
<mnx-team people={people}>
<ul><mnx-each items={people} as="person" index="i"><li data-n={i + 1}>{person.name} ({person.role})</li></mnx-each></ul>
</mnx-team>"#;
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-team>\n<ul><!--[--><!--[--><li data-n=\"1\">Ada (&lt;admin&gt;)</li><!--]--><!--[--><li data-n=\"2\">Linus (dev)</li><!--]--><!--]--></ul>\n</mnx-team>"
    );
    assert!(compile(source, r#"{"people":[]}"#)
        .unwrap()
        .contains("<ul><!--[--><!--]--></ul>"));
    assert_error(source, r#"{"people":{"a":1}}"#, "must be an array");
}

#[test]
fn loop_variables_shadow_props_and_stay_scoped() {
    let source = "<mnx-x name=\"outer\" items={[\"inner\"]}><p><mnx-each items={items} as=\"name\">{name}</mnx-each>/{name}</p></mnx-x>";
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<mnx-x><p><!--[--><!--[--><!---->inner<!--]--><!--]--><!---->/outer</p></mnx-x>"
    );
    assert_error(
        "<mnx-x items={[1]}><p><mnx-each items={items} as=\"item\" index=\"item\">x</mnx-each></p></mnx-x>",
        "{}",
        "different from `as`",
    );
}

#[test]
fn rejects_misplaced_else() {
    assert_error(
        "<mnx-x><main><mnx-else><p>Else</p></mnx-else></main></mnx-x>",
        "{}",
        "only valid as a direct child",
    );
    assert_error(
        "<mnx-x><main><mnx-if test={true}><p>Yes</p><mnx-else><p>No</p></mnx-else><p>After</p></mnx-if></main></mnx-x>",
        "{}",
        "mnx-else must be the final child",
    );
}

// ---- slots ----------------------------------------------------------------------------------

#[test]
fn fills_named_and_default_slots_from_parsed_template_fragments() {
    let source = "<mnx-panel title><main><mnx-slot name=\"heading\"><h1>{title}</h1></mnx-slot><mnx-slot><p>Default fallback</p></mnx-slot></main></mnx-panel>";
    let html = compile_with_slots(
        source,
        r#"{"title":"Panel title"}"#,
        r#"{"heading":"<h2>{title}</h2>","default":"<p>Supplied default</p>"}"#,
    )
    .unwrap();
    assert_eq!(html, "<mnx-panel title=\"Panel title\"><main><!--[!--><h2>Panel title</h2><!--]--><!--[!--><p>Supplied default</p><!--]--></main></mnx-panel>");
    assert!(!html.contains("mnx-slot"));
    assert_eq!(
        compile(source, r#"{"title":"Fallback title"}"#).unwrap(),
        "<mnx-panel title=\"Fallback title\"><main><!--[--><h1>Fallback title</h1><!--]--><!--[--><p>Default fallback</p><!--]--></main></mnx-panel>"
    );
}

#[test]
fn rejects_unknown_slots_invalid_slot_markup_and_recursive_expansion() {
    let source =
        "<mnx-panel><main><mnx-slot name=\"content\"><p>Fallback</p></mnx-slot></main></mnx-panel>";
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

    let recursive = "<mnx-panel><main><mnx-slot name=\"content\"></mnx-slot></main></mnx-panel>";
    assert!(compile_with_slots(
        recursive,
        "{}",
        r#"{"content":"<mnx-slot name=\"content\"></mnx-slot>"}"#
    )
    .unwrap_err()
    .message
    .contains("recursive slot expansion"));
}

// ---- diagnostics ----------------------------------------------------------------------------

#[test]
fn renders_diagnostics_with_the_source_line() {
    let source = "<mnx-x title>\n  <h1>{titel}</h1>\n</mnx-x>";
    let rendered = error(source, r#"{"title":"t"}"#).render(source, "x.mnx");
    assert_eq!(
        rendered,
        "error: unknown reference `titel`\n --> x.mnx:2:7\n  |\n2 |   <h1>{titel}</h1>\n  |       ^\n  = help: did you mean `title`?\n"
    );
}

// ---- JavaScript output ----------------------------------------------------------------------

fn js(source: &str) -> String {
    compile_js(source, "@mnx/runtime", "test.mnx").unwrap()
}

#[test]
fn js_output_binds_text_attributes_and_events_by_path() {
    let module = js(r#"<script>
import { state } from '@mnx/runtime'
const count = state(0)
function go() {}
</script>
<mnx-x label="Hi" href="/" off={false}>
  <p>Hi <b>there</b> {label}!</p>
  <a href={href} class="link {label}" hidden={off} onclick={go}>{count}</a>
</mnx-x>"#);
    assert!(module.contains(
        "import { define, $r, $t } from \"@mnx/runtime\";\nimport { state } from '@mnx/runtime';"
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
    let module = js("<mnx-x max-value name><p>{maxValue} {name}</p></mnx-x>");
    assert!(module
        .contains(r#""maxValue": { attribute: "max-value", default: undefined, required: true }"#));
    assert!(module.contains(r#"{ path: [0], text: () => $t($p.maxValue) + " " + $t($p.name) }"#));
}

#[test]
fn js_output_rejects_what_it_cannot_do_yet() {
    let slot_in_loop = compile_js(
        "<mnx-x items={[]}><ul><mnx-each items={items} as=\"i\"><li><mnx-slot></mnx-slot></li></mnx-each></ul></mnx-x>",
        "r",
        "t",
    )
    .unwrap_err();
    assert!(slot_in_loop
        .message
        .contains("mnx-slot can't be inside mnx-each"));
    let reserved = compile_js(
        "<script>const $p = 1</script><mnx-x><p></p></mnx-x>",
        "r",
        "t",
    )
    .unwrap_err();
    assert!(reserved.message.contains("reserved"));
    let typo = compile_js("<mnx-x name><p>{nmae}</p></mnx-x>", "r", "t").unwrap_err();
    assert_eq!(typo.help.as_deref(), Some("did you mean `name`?"));
}

#[test]
fn both_backends_agree_on_anchors() {
    let source = "<mnx-x name=\"Ada\"><p>Hi <b>there</b> {name}!</p></mnx-x>";
    assert!(compile(source, "{}")
        .unwrap()
        .contains("<b>there</b><!----> Ada!"));
    assert!(js(source).contains("<b>there</b><!---->"));
}

#[test]
fn js_output_compiles_regions_to_nested_blocks() {
    let module = js(r#"<mnx-x items={["a"]} show={true}>
<section><mnx-if test={show}><ul><mnx-each items={items} as="item" index="i"><li data-i={i}>{item}</li></mnx-each></ul><mnx-else><p>none</p></mnx-else></mnx-if><footer>{items.length}</footer></section>
</mnx-x>"#);
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
        r#"<mnx-x name="outer" names={["a"]}><p><mnx-each items={names} as="name">{name}</mnx-each>{name}</p></mnx-x>"#,
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
    let source = r#"<mnx-x todos={[{ id: 1, t: "a" }, { id: "two", t: "b" }]}><ul><mnx-each items={todos} as="todo" key={todo.id}><li>{todo.t}</li></mnx-each></ul></mnx-x>"#;
    assert!(compile(source, "{}").unwrap().contains("<li>a</li>"));
    let duplicate = error(source, r#"{"todos":[{"id":1,"t":"a"},{"id":1,"t":"b"}]}"#);
    assert_eq!(duplicate.message, "duplicate mnx-each key 1 (row 2)");
    assert_error(
        source,
        r#"{"todos":[{"id":null,"t":"a"}]}"#,
        "key must be a string or number, found null",
    );
    assert_error(
        "<mnx-x todos={[]}><ul><mnx-each items={todos} as=\"todo\" key={tood.id}><li></li></mnx-each></ul></mnx-x>",
        "{}",
        "unknown reference `tood`",
    );
    assert_error(
        "<mnx-x todos={[]}><ul><mnx-each items={todos} as=\"todo\" key=\"id\"><li></li></mnx-each></ul></mnx-x>",
        "{}",
        "write key={…}",
    );
}

#[test]
fn keyed_lists_compile_a_key_function_over_plain_values() {
    let module = js(
        r#"<mnx-x todos={[]}><ul><mnx-each items={todos} as="todo" key={todo.id}><li>{todo.t}</li></mnx-each></ul></mnx-x>"#,
    );
    assert!(
        module.contains("each: () => $p.todos, key: (todo, $index) => $r(todo).id, block:"),
        "{module}"
    );
}

#[test]
fn slots_compile_to_regions_in_light_dom_and_native_slots_in_shadow_dom() {
    let light = js("<mnx-x title=\"t\"><main><mnx-slot name=\"heading\"><h1>{title}</h1></mnx-slot><mnx-slot></mnx-slot></main></mnx-x>");
    assert!(
        light.contains(r#"slots: ["default", "heading"],"#),
        "{light}"
    );
    assert!(light.contains(r#"{ path: [0, 0], slot: "heading", fallback: { template: "<h1></h1>", parts: () => [{ path: [0], text: () => $t($p.title) }] } }"#), "{light}");
    assert!(
        light.contains(r#"{ path: [0, 1], slot: "default", fallback: null }"#),
        "{light}"
    );

    let shadow = js("<mnx-x shadow title=\"t\"><main><mnx-slot name=\"heading\"><h1>{title}</h1></mnx-slot></main></mnx-x>");
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
    let source = "<mnx-x shadow><main><mnx-slot name=\"heading\"><h1>Fallback</h1></mnx-slot><mnx-slot>empty</mnx-slot></main></mnx-x>";
    assert_eq!(
        compile_with_slots(source, "{}", r#"{"heading":"<h2>Mine</h2>","default":"Body"}"#).unwrap(),
        "<mnx-x><template shadowrootmode=\"open\"><main><slot name=\"heading\"><h1>Fallback</h1></slot><slot>empty</slot></main></template><h2 slot=\"heading\">Mine</h2>Body</mnx-x>"
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
    let source = "<mnx-x form-associated label=\"L\"><p>{label}</p></mnx-x>";
    assert_eq!(compile(source, "{}").unwrap(), "<mnx-x><p>L</p></mnx-x>");
    assert!(js(source).contains("  form: true,\n"));
    assert!(js("<mnx-x><p>x</p></mnx-x>").contains("  form: false,\n"));
    assert!(compile(source, r#"{"formAssociated":true}"#)
        .unwrap_err()
        .message
        .contains("unknown prop"));
    let dts = mnix_compiler::compile_declarations(source, "x.mnx").unwrap();
    assert!(dts.contains("readonly form: HTMLFormElement | null;"));
    assert!(dts.contains("name: string | null;"));
    assert!(dts.contains("checkValidity(): boolean;"));
    let named = mnix_compiler::compile_declarations(
        "<mnx-x form-associated name=\"n\"><p>{name}</p></mnx-x>",
        "x.mnx",
    )
    .unwrap();
    assert!(
        !named.contains("name: string | null;"),
        "a `name` prop takes precedence"
    );
}

#[test]
fn props_that_shadow_built_in_element_properties_are_warned_about() {
    let warnings = mnix_compiler::warnings(
        "<mnx-x title=\"\" hidden={false} label=\"\">\n  <p>{label}</p>\n</mnx-x>",
    );
    let messages: Vec<_> = warnings
        .iter()
        .map(|warning| warning.message.as_str())
        .collect();
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert!(messages[0].starts_with("prop `title` is also every element's built-in `title`"));
    assert!(messages[1].contains("also hides the element"));
    assert_eq!(warnings[0].span.column, 8);
    assert!(warnings[0]
        .render_warning("<mnx-x title=\"\">", "x.mnx")
        .starts_with("warning: prop `title`"));
    assert!(mnix_compiler::warnings("<mnx-x label=\"\"><p>x</p></mnx-x>").is_empty());
}

#[test]
fn defaults_that_use_runtime_values_are_computed_in_the_browser() {
    let source = "<script>\n  const start = Date.now()\n  const fallback = window.innerWidth ?? 0\n</script>\n<mnx-x since={start} width={fallback}>\n  <p>{since}</p>\n</mnx-x>";
    let js = compile_js(source, "@mnx/runtime", "x.mnx").unwrap();
    assert!(
        js.contains("\"since\": { attribute: \"since\", default: undefined, required: false }"),
        "{js}"
    );
    assert!(js.contains("  setup($p, $emit, $initial) {"), "{js}");
    assert!(js.contains("    $initial(\"since\", () => $r(start));\n    $initial(\"width\", () => $r(fallback));"), "{js}");
    let dts = mnix_compiler::compile_declarations(source, "x.mnx").unwrap();
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
        "<script>\n  const a = windw.x\n</script>\n<mnx-x><p>x</p></mnx-x>",
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
        compile_js("<mnx-x a=\"1\"><p>{a}</p></mnx-x>", "@mnx/runtime", "x.mnx")
            .unwrap()
            .contains("  setup($p, $emit) {")
    );
}

#[test]
fn server_rendered_slot_html_is_kept_as_written() {
    use mnix_compiler::{compile_html_from, SlotSource};
    let loader = |_: &str, _: &str| -> Result<(String, String), String> { Err("none".into()) };
    let source = "<mnx-panel><main><mnx-slot><p>Fallback</p></mnx-slot></main></mnx-panel>";
    let slots = serde_json::json!({
        "default": "<p data-x={a}>{\"json\"}</p><!--astro:end--><script type=\"application/json\">{\"a\":1}</script><input value=raw onclick=\"go()\"><mnx-slot></mnx-slot>"
    })
    .to_string();
    let html =
        compile_html_from(source, "panel.mnx", "{}", &slots, SlotSource::Html, &loader).unwrap();
    assert_eq!(
        html,
        "<mnx-panel><main><!--[!--><p data-x=\"{a}\">{\"json\"}</p><!--astro:end--><script type=\"application/json\">{\"a\":1}</script><input value=\"raw\" onclick=\"go()\"><mnx-slot></mnx-slot><!--]--></main></mnx-panel>"
    );
    // The same content is an error as a template (and stays one).
    assert!(compile_html_from(
        source,
        "panel.mnx",
        "{}",
        &slots,
        SlotSource::Template,
        &loader
    )
    .is_err());
    assert!(compile_html_from(
        source,
        "panel.mnx",
        "{}",
        r#"{"default":"<p>Broken</main>"}"#,
        SlotSource::Html,
        &loader
    )
    .unwrap_err()
    .message
    .contains("does not match"));
}
