//! `animate` on <zb-if>, <zb-switch> and <zb-each>, and `zb-animate` beside `zb-if`: the parts
//! say so, the plain element passes its `leave` and `glide` helpers, and misuse is explained.
//! What they do in a browser is in runtime/test/browser/motion.test.js.

use zubra::{compile, compile_js};

fn js(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "x.zb").unwrap()
}
fn error(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "x.zb")
        .unwrap_err()
        .message
}
fn element(source: &str) -> String {
    let dir = std::env::temp_dir().join(format!(
        "zubra-motion-{}-{}",
        std::process::id(),
        source.len()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("x.zb");
    std::fs::write(&path, source).unwrap();
    zubra::compile_element_file(path.to_str().unwrap()).unwrap()
}

#[test]
fn animate_marks_the_parts_of_a_whole_chain() {
    let chain = js("<zb-x a={1}><zb-if test={a > 1} animate><p>one</p><zb-else-if test={a}><p>two</p></zb-else-if><zb-else><p>three</p></zb-else></zb-if></zb-x>");
    assert_eq!(
        chain.matches("animate: true").count(),
        2,
        "the zb-if and its else-if: {chain}"
    );
    let attribute = js("<zb-x a={1}><p zb-if={a > 1} zb-animate>one</p><p zb-else-if={a}>two</p><p zb-else>three</p></zb-x>");
    assert_eq!(attribute.matches("animate: true").count(), 2, "{attribute}");
    let switch = js("<zb-x t={\"a\"}><zb-switch value={t} animate><zb-case is=\"a\">A</zb-case><zb-case is=\"b\">B</zb-case></zb-switch></zb-x>");
    assert_eq!(switch.matches("animate: true").count(), 2, "{switch}");
    let list = js("<zb-x items={[]}><ul><zb-each items={items} as=\"item\" key={item.id} animate><li>{item.id}</li></zb-each></ul></zb-x>");
    assert!(
        list.contains("text: () => $t($r(item).id) }] }, animate: true"),
        "{list}"
    );
    // Without it, nothing changes.
    assert!(!js("<zb-x a={1}><p zb-if={a}>one</p></zb-x>").contains("animate"));
    // The server renders the branch as ever.
    assert_eq!(
        compile(
            "<zb-x a={true}><zb-if test={a} animate><p>one</p></zb-if></zb-x>",
            "{}"
        )
        .unwrap(),
        "<zb-x><?zb [?><p>one</p><?zb ]?></zb-x>"
    );
}

#[test]
fn the_plain_element_passes_its_motion_helpers() {
    let out = element("<zb-x a={true} items={[]}><p zb-if={a} zb-animate>one</p><ul><zb-each items={items} as=\"item\" key={item.id} animate><li>{item.id}</li></zb-each></ul></zb-x>");
    assert!(out.contains("// <zb-if test={a} animate>"), "{out}");
    assert!(out.contains("null, leave)"), "{out}");
    assert!(
        out.contains("// <zb-each items={items} as=\"item\" key={item.id} animate>"),
        "{out}"
    );
    assert!(out.contains("}, leave, glide)"), "{out}");
    assert!(
        out.contains("function leave(nodes, float)")
            && out.contains("function glide(elements, change)"),
        "{out}"
    );
    // Only components that animate carry them.
    let still = element("<zb-x a={true}><p zb-if={a}>one</p></zb-x>");
    assert!(
        !still.contains("function leave") && !still.contains("function glide"),
        "{still}"
    );
}

#[test]
fn misuse_is_explained() {
    assert!(error(
        "<zb-x items={[]}><zb-each items={items} as=\"item\" animate><i></i></zb-each></zb-x>"
    )
    .contains("give the zb-each a key"));
    assert!(
        error("<zb-x a={1}><zb-if test={a} animate=\"yes\"><i></i></zb-if></zb-x>")
            .contains("`animate` takes no value")
    );
    assert!(error("<zb-x a={1}><p zb-animate>x</p></zb-x>").contains("goes beside `zb-if`"));
    assert!(
        error("<zb-x a={1}><p zb-if={a}>x</p><p zb-else zb-animate>y</p></zb-x>")
            .contains("goes on the element with `zb-if`")
    );
    assert!(
        error("<zb-x a={1}><p zb-if={a} zb-animate={a}>x</p></zb-x>")
            .contains("`zb-animate` takes no value")
    );
}
