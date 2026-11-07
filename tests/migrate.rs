//! `mnix migrate` and the 1.x deprecation warnings for what 2.0 changes.

use mnix_compiler::{compile, compile_js, migrate, warnings};

#[test]
fn renames_script_bindings_that_share_a_props_name_and_keeps_the_output() {
    let source = "<script>\n  const title = \"Hi\"\n  const titleDefault = 1\n  const extra = { title }\n  function shout() { return title.toUpperCase() }\n</script>\n<mnx-x title={title} count={titleDefault} info={[title]}>\n  <h1>{title}</h1><button onclick={shout}>!</button>\n</mnx-x>\n";
    let migration = migrate(source).unwrap();
    assert_eq!(
        migration.output,
        "<script>\n  const titleDefault2 = \"Hi\"\n  const titleDefault = 1\n  const extra = { title: titleDefault2 }\n  function shout() { return titleDefault2.toUpperCase() }\n</script>\n<mnx-x title={titleDefault2} count={titleDefault} info={[titleDefault2]}>\n  <h1>{title}</h1><button onclick={shout}>!</button>\n</mnx-x>\n"
    );
    assert_eq!(migration.changes.len(), 1);
    // The same component, before and after.
    assert_eq!(
        compile(source, "{}").unwrap(),
        compile(&migration.output, "{}").unwrap()
    );
    let js = |source: &str| compile_js(source, "@mnx/runtime", "x.mnx").unwrap();
    assert_eq!(
        js(source),
        js(&migration.output)
            .replace("titleDefault2", "title")
            .replace("{ title: title }", "{ title }")
    );
    // Nothing left to do.
    assert_eq!(migrate(&migration.output).unwrap().output, migration.output);
}

#[test]
fn reports_lets_that_will_start_updating_the_template() {
    let source = "<script>\n  let count = 0\n  let steady = 1\n  function add() { count++ }\n</script>\n<mnx-x><button onclick={add}>{count} {steady}</button></mnx-x>\n";
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
fn deprecation_warnings_point_at_the_prop_and_typescript_scripts_work() {
    let source = "<script lang=\"ts\">\n  const label: string = \"x\"\n</script>\n<mnx-x label={label}><p>{label}</p></mnx-x>\n";
    let found = warnings(source);
    assert_eq!(found.len(), 1);
    assert!(found[0]
        .message
        .contains("the script's `label` will clash with the prop `label`"));
    assert_eq!((found[0].span.line, found[0].span.column), (4, 8));
    let migration = migrate(source).unwrap();
    assert!(migration
        .output
        .contains("const labelDefault: string = \"x\""));
    assert!(migration.output.contains("<mnx-x label={labelDefault}>"));
    assert!(warnings(&migration.output).is_empty());
}
