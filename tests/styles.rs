//! `<style>` in components.

use zubra::{
    compile, compile_css, compile_html_with, compile_js, compile_js_for_bundler, StyleImports,
};

const CARD: &str = "<!-- A card. -->\n<style layer=\"ui\">\n  h2 { color: red }\n</style>\n<script>\n  const headingDefault = \"Card\"\n</script>\n<zb-card heading={headingDefault}>\n  <h2>{heading}</h2><zb-slot></zb-slot>\n</zb-card>";

#[test]
fn style_and_script_come_in_either_order_and_the_description_is_kept() {
    for source in [
        CARD.to_owned(),
        "<!-- A card. -->\n<script>\n  const headingDefault = \"Card\"\n</script>\n<style layer=\"ui\">\n  h2 { color: red }\n</style>\n<zb-card heading={headingDefault}>\n  <h2>{heading}</h2><zb-slot></zb-slot>\n</zb-card>".to_owned(),
    ] {
        let css = compile_css(&source).unwrap();
        assert!(css.contains("@layer ui {\n@scope (zb-card) to ([data-zb-slotted=\"zb-card\"]) {\n  h2 { color: red }\n}\n}"), "{css}");
        let manifest = zubra::compile_manifest(&source, "card.js").unwrap();
        assert!(manifest.contains("\"description\": \"A card.\""), "{manifest}");
    }
}

#[test]
fn style_attributes_are_checked() {
    for (source, expected) in [
        (
            "<style scoped=\"x\"></style><zb-x><p>x</p></zb-x>",
            "not `scoped`",
        ),
        (
            "<style layer=\"a b\"></style><zb-x><p>x</p></zb-x>",
            "isn't a cascade layer name",
        ),
        (
            "<style lang=\"s c\"></style><zb-x><p>x</p></zb-x>",
            "isn't a stylesheet language",
        ),
        (
            "<style layer=x></style><zb-x><p>x</p></zb-x>",
            "needs a quoted value",
        ),
        (
            "<style></style><style></style><zb-x><p>x</p></zb-x>",
            "one <style>",
        ),
        ("<style>p {}<zb-x><p>x</p></zb-x>", "missing </style>"),
        (
            "<zb-x><style>p {}</style></zb-x>",
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
    let css =
        compile_css("<style layer=\"none\">p { margin: 0 }</style><zb-x><p>x</p></zb-x>").unwrap();
    assert!(!css.contains("@layer"), "{css}");
    assert!(compile_css("<zb-x><p>x</p></zb-x>").unwrap().is_empty());
}

#[test]
fn html_marks_content_slotted_into_styled_components_only() {
    let page = |card: &str| {
        let files = std::collections::HashMap::from([("./card.zb", card.to_owned())]);
        let loader = |specifier: &str, _: &str| {
            files
                .get(specifier)
                .map(|source| ("card.zb".to_owned(), source.clone()))
                .ok_or_else(|| "missing".to_owned())
        };
        compile_html_with("<script>import './card.zb'</script>\n<zb-page><zb-card><p>mine</p>text</zb-card></zb-page>", "page.zb", "{}", "{}", &loader).unwrap()
    };
    let styled = page(CARD);
    assert!(
        styled.contains("<!--[!--><p data-zb-slotted=\"zb-card\">mine</p>text<!--]-->"),
        "{styled}"
    );
    let plain = page("<zb-card><zb-slot></zb-slot></zb-card>");
    assert!(!plain.contains("data-zb-slotted"), "{plain}");
    // Light-DOM styles aren't repeated in the HTML: the page gets them once, from --emit css.
    assert!(!styled.contains("<style"), "{styled}");
}

#[test]
fn shadow_components_carry_their_styles_in_the_shadow_root() {
    let source = "<style>:host { display: block }</style>\n<zb-panel shadow><h3>x</h3></zb-panel>";
    let html = compile(source, "{}").unwrap();
    assert!(html.starts_with("<zb-panel><template shadowrootmode=\"open\"><style data-zubra>@layer theme, base, components, utilities;\n@layer components {\n:host { display: block }\n}\n</style><h3>x</h3></template>"), "{html}");
}

#[test]
fn javascript_inlines_the_stylesheet_or_imports_it_through_the_bundler() {
    let inline = compile_js(CARD, "@zubra/runtime", "card.zb").unwrap();
    assert!(
        inline.contains("  styled: true,\n  styles: \"@layer ui {\\n@scope (zb-card)"),
        "{inline}"
    );

    let loader = |_: &str, _: &str| Err("no imports".to_owned());
    let imports = StyleImports {
        stylesheet: "/card.zb?zubra=style&lang.css",
        inline: "/card.zb?zubra=style&inline&lang.css",
    };
    let light =
        compile_js_for_bundler(CARD, "card.zb", "@zubra/runtime", imports, &loader).unwrap();
    assert!(
        light.contains("import \"/card.zb?zubra=style&lang.css\";"),
        "{light}"
    );
    assert!(
        light.contains("import $styles from \"/card.zb?zubra=style&inline&lang.css\";")
            && light.contains("  styled: true,\n  styles: $styles,\n  inPage: true,\n  template"),
        "the bundler adds the CSS to the page, and the text comes for shadow roots: {light}"
    );
    let shadow = compile_js_for_bundler(
        "<style>p{}</style><zb-panel shadow><p>x</p></zb-panel>",
        "panel.zb",
        "@zubra/runtime",
        imports,
        &loader,
    )
    .unwrap();
    assert!(
        shadow.contains("import $styles from \"/card.zb?zubra=style&inline&lang.css\";"),
        "{shadow}"
    );
    assert!(
        shadow.contains("  styled: true,\n  styles: $styles,"),
        "{shadow}"
    );

    let none = compile_js("<zb-x><p>x</p></zb-x>", "@zubra/runtime", "x.zb").unwrap();
    assert!(
        !none.contains("styled") && !none.contains("styles"),
        "{none}"
    );
}

#[test]
fn preprocessor_languages_need_a_bundler() {
    let source = "<style lang=\"scss\">$c: red; p { color: $c }</style>\n<zb-x><p>x</p></zb-x>";
    for error in [
        compile(source, "{}").unwrap_err(),
        compile_js(source, "@zubra/runtime", "x.zb").unwrap_err(),
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
        stylesheet: "/x.zb?zubra=style&lang.scss",
        inline: "/x.zb?zubra=style&inline&lang.scss",
    };
    assert!(compile_js_for_bundler(source, "x.zb", "@zubra/runtime", imports, &loader).is_ok());
}

#[test]
fn server_rendered_slot_html_is_marked_slotted_too() {
    use zubra::{compile_html_from, SlotSource};
    let loader = |_: &str, _: &str| -> Result<(String, String), String> { Err("none".into()) };
    let source =
        "<style>p { color: red }</style>\n<zb-card><p>Own</p><zb-slot></zb-slot></zb-card>";
    let html = compile_html_from(
        source,
        "card.zb",
        "{}",
        r#"{"default":"<p class=x>{theirs}</p>"}"#,
        SlotSource::Html,
        &loader,
    )
    .unwrap();
    assert!(
        html.contains(r#"<p class="x" data-zb-slotted="zb-card">{theirs}</p>"#),
        "{html}"
    );
}
