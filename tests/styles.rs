//! `<style>` in components.

use mnix_compiler::{
    compile, compile_css, compile_html_with, compile_js, compile_js_for_bundler, StyleImports,
};

const CARD: &str = "<!-- A card. -->\n<style layer=\"ui\">\n  h2 { color: red }\n</style>\n<script>\n  const heading = \"Card\"\n</script>\n<mnx-card heading={heading}>\n  <h2>{heading}</h2><mnx-slot></mnx-slot>\n</mnx-card>";

#[test]
fn style_and_script_come_in_either_order_and_the_description_is_kept() {
    for source in [
        CARD.to_owned(),
        "<!-- A card. -->\n<script>\n  const heading = \"Card\"\n</script>\n<style layer=\"ui\">\n  h2 { color: red }\n</style>\n<mnx-card heading={heading}>\n  <h2>{heading}</h2><mnx-slot></mnx-slot>\n</mnx-card>".to_owned(),
    ] {
        let css = compile_css(&source).unwrap();
        assert!(css.contains("@layer ui {\n@scope (mnx-card) to ([data-mnx-slotted=\"mnx-card\"]) {\n  h2 { color: red }\n}\n}"), "{css}");
        let manifest = mnix_compiler::compile_manifest(&source, "card.js").unwrap();
        assert!(manifest.contains("\"description\": \"A card.\""), "{manifest}");
    }
}

#[test]
fn style_attributes_are_checked() {
    for (source, expected) in [
        (
            "<style scoped=\"x\"></style><mnx-x><p>x</p></mnx-x>",
            "not `scoped`",
        ),
        (
            "<style layer=\"a b\"></style><mnx-x><p>x</p></mnx-x>",
            "isn't a cascade layer name",
        ),
        (
            "<style lang=\"s c\"></style><mnx-x><p>x</p></mnx-x>",
            "isn't a stylesheet language",
        ),
        (
            "<style layer=x></style><mnx-x><p>x</p></mnx-x>",
            "needs a quoted value",
        ),
        (
            "<style></style><style></style><mnx-x><p>x</p></mnx-x>",
            "one <style>",
        ),
        ("<style>p {}<mnx-x><p>x</p></mnx-x>", "missing </style>"),
        (
            "<mnx-x><style>p {}</style></mnx-x>",
            "<style> elements are not supported inside a template",
        ),
    ] {
        let error = compile(source, "{}").unwrap_err();
        assert!(
            error.message.contains(expected),
            "{source}: {}",
            error.message
        );
    }
    let css = compile_css("<style layer=\"none\">p { margin: 0 }</style><mnx-x><p>x</p></mnx-x>")
        .unwrap();
    assert!(!css.contains("@layer"), "{css}");
    assert!(compile_css("<mnx-x><p>x</p></mnx-x>").unwrap().is_empty());
}

#[test]
fn html_marks_content_slotted_into_styled_components_only() {
    let page = |card: &str| {
        let files = std::collections::HashMap::from([("./card.mnx", card.to_owned())]);
        let loader = |specifier: &str, _: &str| {
            files
                .get(specifier)
                .map(|source| ("card.mnx".to_owned(), source.clone()))
                .ok_or_else(|| "missing".to_owned())
        };
        compile_html_with("<script>import './card.mnx'</script>\n<mnx-page><mnx-card><p>mine</p>text</mnx-card></mnx-page>", "page.mnx", "{}", "{}", &loader).unwrap()
    };
    let styled = page(CARD);
    assert!(
        styled.contains("<!--[!--><p data-mnx-slotted=\"mnx-card\">mine</p>text<!--]-->"),
        "{styled}"
    );
    let plain = page("<mnx-card><mnx-slot></mnx-slot></mnx-card>");
    assert!(!plain.contains("data-mnx-slotted"), "{plain}");
    // Light-DOM styles aren't repeated in the HTML: the page gets them once, from --emit css.
    assert!(!styled.contains("<style"), "{styled}");
}

#[test]
fn shadow_components_carry_their_styles_in_the_shadow_root() {
    let source =
        "<style>:host { display: block }</style>\n<mnx-panel shadow><h3>x</h3></mnx-panel>";
    let html = compile(source, "{}").unwrap();
    assert!(html.starts_with("<mnx-panel><template shadowrootmode=\"open\"><style data-mnx>@layer theme, base, components, utilities;\n@layer components {\n:host { display: block }\n}\n</style><h3>x</h3></template>"), "{html}");
}

#[test]
fn javascript_inlines_the_stylesheet_or_imports_it_through_the_bundler() {
    let inline = compile_js(CARD, "@mnx/runtime", "card.mnx").unwrap();
    assert!(
        inline.contains("  styled: true,\n  styles: \"@layer ui {\\n@scope (mnx-card)"),
        "{inline}"
    );

    let loader = |_: &str, _: &str| Err("no imports".to_owned());
    let imports = StyleImports {
        stylesheet: "/card.mnx?mnx=style&lang.css",
        inline: "/card.mnx?mnx=style&inline&lang.css",
    };
    let light = compile_js_for_bundler(CARD, "card.mnx", "@mnx/runtime", imports, &loader).unwrap();
    assert!(
        light.contains("import \"/card.mnx?mnx=style&lang.css\";"),
        "{light}"
    );
    assert!(
        light.contains("  styled: true,\n  template"),
        "the bundler adds the CSS to the page: {light}"
    );
    let shadow = compile_js_for_bundler(
        "<style>p{}</style><mnx-panel shadow><p>x</p></mnx-panel>",
        "panel.mnx",
        "@mnx/runtime",
        imports,
        &loader,
    )
    .unwrap();
    assert!(
        shadow.contains("import $styles from \"/card.mnx?mnx=style&inline&lang.css\";"),
        "{shadow}"
    );
    assert!(
        shadow.contains("  styled: true,\n  styles: $styles,"),
        "{shadow}"
    );

    let none = compile_js("<mnx-x><p>x</p></mnx-x>", "@mnx/runtime", "x.mnx").unwrap();
    assert!(
        !none.contains("styled") && !none.contains("styles"),
        "{none}"
    );
}

#[test]
fn preprocessor_languages_need_a_bundler() {
    let source = "<style lang=\"scss\">$c: red; p { color: $c }</style>\n<mnx-x><p>x</p></mnx-x>";
    for error in [
        compile(source, "{}").unwrap_err(),
        compile_js(source, "@mnx/runtime", "x.mnx").unwrap_err(),
    ] {
        assert!(
            error.message.contains("needs a bundler"),
            "{}",
            error.message
        );
        assert_eq!(error.span.line, 1);
    }
    let loader = |_: &str, _: &str| Err("no imports".to_owned());
    let imports = StyleImports {
        stylesheet: "/x.mnx?mnx=style&lang.scss",
        inline: "/x.mnx?mnx=style&inline&lang.scss",
    };
    assert!(compile_js_for_bundler(source, "x.mnx", "@mnx/runtime", imports, &loader).is_ok());
}
