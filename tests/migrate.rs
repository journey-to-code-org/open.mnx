//! `zubra migrate`: rewriting 1.x files for 2.0.

use zubra::{compile, compile_js, migrate, warnings};

#[test]
fn renames_script_bindings_that_share_a_props_name_and_keeps_the_output() {
    let source = "<script>\n  const title = \"Hi\"\n  const titleDefault = 1\n  const extra = { title }\n  function shout() { return title.toUpperCase() }\n</script>\n<zb-x title={title} count={titleDefault} info={[title]}>\n  <h1>{title}</h1><button onclick={shout}>!</button>\n</zb-x>\n";
    let migration = migrate(source).unwrap();
    assert_eq!(
        migration.output,
        "<script>\n  const titleDefault2 = \"Hi\"\n  const titleDefault = 1\n  const extra = { title: titleDefault2 }\n  function shout() { return titleDefault2.toUpperCase() }\n</script>\n<zb-x title={titleDefault2} count={titleDefault} info={[titleDefault2]}>\n  <h1>{title}</h1><button onclick={shout}>!</button>\n</zb-x>\n"
    );
    assert_eq!(migration.changes.len(), 1);
    // 1.x code is an error in 2.0; the migrated code compiles, with the same output as 1.x gave.
    assert!(compile(source, "{}")
        .unwrap_err()
        .message
        .contains("which is also a prop"));
    assert_eq!(
        compile(&migration.output, "{}").unwrap(),
        "<zb-x>\n  <h1>Hi</h1><button>!</button>\n</zb-x>"
    );
    assert!(compile_js(&migration.output, "@zubra/runtime", "x.zb").is_ok());
    // Nothing left to do.
    assert_eq!(migrate(&migration.output).unwrap().output, migration.output);
}

#[test]
fn reports_lets_that_will_start_updating_the_template() {
    let source = "<script>\n  let count = 0\n  let steady = 1\n  function add() { count++ }\n</script>\n<zb-x><button onclick={add}>{count} {steady}</button></zb-x>\n";
    let migration = migrate(source).unwrap();
    assert_eq!(migration.output, source, "nothing to rewrite");
    assert_eq!(migration.notes.len(), 1);
    assert!(migration.notes[0]
        .message
        .starts_with("`count` is a `let` the script changes and the template reads"));
    assert_eq!(
        (migration.notes[0].span.line, migration.notes[0].span.column),
        (2, 7)
    );
}

#[test]
fn typescript_scripts_migrate_too() {
    let source = "<script lang=\"ts\">\n  const label: string = \"x\"\n</script>\n<zb-x label={label}><p>{label}</p></zb-x>\n";
    let error = compile(source, "{}").unwrap_err();
    assert_eq!(
        (error.span.line, error.span.column),
        (2, 9),
        "at the script's binding"
    );
    let migration = migrate(source).unwrap();
    assert!(migration
        .output
        .contains("const labelDefault: string = \"x\""));
    assert!(migration.output.contains("<zb-x label={labelDefault}>"));
    assert!(warnings(&migration.output).is_empty());
    assert_eq!(
        compile(&migration.output, "{}").unwrap(),
        "<zb-x><p>x</p></zb-x>"
    );
}
