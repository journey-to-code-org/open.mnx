//! `roots` in a component's JavaScript: the elements server markup starts with, for a template
//! that is only regions, so the runtime can tell it from the page's own content.

use zubra::compile_js;

fn roots(source: &str) -> Option<String> {
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    js.lines().find(|line| line.starts_with("  roots: ")).map(str::to_owned)
}

#[test]
fn a_template_of_only_regions_names_the_elements_its_blocks_start_with() {
    let source = "<zb-either href=\"\">\n  <a zb-if={href} href={href}><zb-slot></zb-slot></a>\n  <button zb-else type=\"button\"><zb-slot></zb-slot></button>\n</zb-either>";
    assert_eq!(roots(source).as_deref(), Some("  roots: [\"a\", \"button\"],"));
    // Through an else-if, a list's rows, and a region inside a block.
    let source = "<zb-x items={[]} a={false} b={false}>\n  <zb-each items={items} as=\"item\"><li>{item}</li></zb-each>\n</zb-x>";
    assert_eq!(roots(source).as_deref(), Some("  roots: [\"li\"],"));
    let source = "<zb-x a={false} b={false}>\n  <zb-if test={a}><p>one</p><zb-else-if test={b}><em>two</em><zb-if test={a}><b>x</b></zb-if></zb-else-if></zb-if>\n</zb-x>";
    assert_eq!(roots(source).as_deref(), Some("  roots: [\"b\", \"em\", \"p\"],"));
}

#[test]
fn nothing_is_named_when_the_runtime_has_more_to_go_on_or_the_markup_can_not_be_named() {
    // Elements of its own: the runtime checks those.
    assert_eq!(roots("<zb-x a={false}>\n  <h2>Hi</h2>\n  <p zb-if={a}>x</p>\n</zb-x>"), None);
    // Text of its own, a text-only block, a slot at the top of a block, a zb-await.
    assert_eq!(roots("<zb-x a={false}>\n  Hello\n  <p zb-if={a}>x</p>\n</zb-x>"), None);
    assert_eq!(roots("<zb-x a={false}>\n  <zb-if test={a}>just text</zb-if>\n</zb-x>"), None);
    assert_eq!(roots("<zb-x a={false}>\n  <zb-if test={a}><zb-slot></zb-slot></zb-if>\n</zb-x>"), None);
    assert_eq!(roots("<zb-x v={Promise.resolve(1)}>\n  <zb-await value={v}><p>wait</p></zb-await>\n</zb-x>"), None);
    // No regions at all.
    assert_eq!(roots("<zb-x><zb-slot></zb-slot></zb-x>"), None);
}
