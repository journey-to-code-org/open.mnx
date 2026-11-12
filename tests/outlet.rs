//! `<zb-outlet>` (experimental): a template with one imports `@zubra/runtime/outlet`, so the
//! element is defined before the template sets its `item` as a property. What it does in a
//! browser is in runtime/test/browser/outlet.test.js.

use zubra::compile_js;

fn js(source: &str, runtime: &str) -> String {
    compile_js(source, runtime, "x.zb").unwrap()
}

#[test]
fn a_template_with_an_outlet_imports_the_outlet_module() {
    let list = js(
        "<zb-x items={[]}><ul><zb-each items={items} as=\"item\" key={item.id}><li><zb-outlet name=\"row\" item={item}></zb-outlet></li></zb-each></ul></zb-x>",
        "@zubra/runtime",
    );
    assert!(list.contains("import \"@zubra/runtime/outlet\";"), "{list}");
    assert!(
        list.contains("attribute: \"item\", prop: \"item\""),
        "the item is set as a property: {list}"
    );
    let file = js(
        "<zb-x><zb-outlet name=\"a\"></zb-outlet></zb-x>",
        "/vendor/zubra/index.js",
    );
    assert!(
        file.contains("import \"/vendor/zubra/outlet.js\";"),
        "{file}"
    );
    assert!(!js("<zb-x><p>plain</p></zb-x>", "@zubra/runtime").contains("runtime/outlet"));
}

#[test]
fn emit_element_refuses_an_outlet() {
    let dir = std::env::temp_dir().join(format!("zubra-outlet-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("x.zb");
    std::fs::write(&path, "<zb-x><zb-outlet name=\"a\"></zb-outlet></zb-x>").unwrap();
    let error = zubra::compile_element_file(path.to_str().unwrap()).unwrap_err();
    assert!(
        error.message.contains("doesn't support <zb-outlet>"),
        "{}",
        error.message
    );
}
