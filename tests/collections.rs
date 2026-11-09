//! `'use collection tasks'`: a component's state is a document in a local store (`@zubra/sync`).

use zubra::{compile, compile_js};

const TASK: &str = r#"<script>
  'use collection tasks';
  import { ephemeral } from '@zubra/sync';

  let completed = false;
  let title = 'Untitled';
  let editing = ephemeral(false);
  const label = completed ? 'done' : 'todo';
</script>
<task-item doc="">
  <input type="checkbox" checked={completed} /> {title} <small>{label}</small>
  <span zb-if={editing}>editing</span>
</task-item>"#;

#[test]
fn the_state_is_bound_to_a_document_keyed_by_the_doc_prop() {
    let js = compile_js(TASK, "@zubra/runtime", "task-item.zb").unwrap();
    assert!(
        js.contains(r#"import { collection as $collection } from "@zubra/sync";"#),
        "{js}"
    );
    // Durable state only: not the ephemeral `editing`, not the derived `label`.
    assert!(
        js.contains(r#"$collection("tasks", ["doc"], $p, { completed, title });"#),
        "{js}"
    );
}

#[test]
fn the_server_renders_the_defaults_and_an_ephemeral_value() {
    let html = compile(TASK, r#"{"doc":"t1"}"#).unwrap();
    assert!(html.contains("Untitled"), "{html}");
    assert!(html.contains("<small>todo</small>"), "{html}");
    assert!(!html.contains("editing"), "{html}");
}

#[test]
fn by_names_the_key_props() {
    let source = "<script>'use collection rows by list, item'; let done = false</script>\n<x-row list=\"\" item=\"\"><b>{done}</b></x-row>";
    let js = compile_js(source, "@zubra/runtime", "x-row.zb").unwrap();
    assert!(
        js.contains(r#"$collection("rows", ["list","item"], $p, { done });"#),
        "{js}"
    );
}

#[test]
fn a_component_without_the_directive_doesnt_import_sync() {
    let js = compile_js(
        "<script>let n = 0</script>\n<x-y>{n}</x-y>",
        "@zubra/runtime",
        "x-y.zb",
    )
    .unwrap();
    assert!(!js.contains("@zubra/sync"), "{js}");
}

#[test]
fn mistakes_are_named() {
    let missing = compile(
        "<script>'use collection tasks'; let x = 1</script>\n<x-y></x-y>",
        "{}",
    )
    .unwrap_err();
    assert!(
        missing.message.contains("by the prop `doc`"),
        "{}",
        missing.message
    );
    let unknown = compile("<script>'use client'</script>\n<x-y></x-y>", "{}").unwrap_err();
    assert!(
        unknown.message.contains("unknown directive 'use client'"),
        "{}",
        unknown.message
    );
    let misplaced = compile("<script>'use server'</script>\n<x-y></x-y>", "{}").unwrap_err();
    assert!(
        misplaced
            .help
            .as_deref()
            .unwrap_or_default()
            .contains("exported function"),
        "{:?}",
        misplaced.help
    );
    let unnamed = compile(
        "<script>'use collection'</script>\n<x-y doc=\"\"></x-y>",
        "{}",
    )
    .unwrap_err();
    assert!(
        unnamed.message.contains("name the collection"),
        "{}",
        unnamed.message
    );
    let twice = compile(
        "<script>'use collection a'; 'use collection b'</script>\n<x-y doc=\"\"></x-y>",
        "{}",
    )
    .unwrap_err();
    assert!(
        twice.message.contains("one collection"),
        "{}",
        twice.message
    );
}

const BOARD: &str = r#"<script>
  'use collection boards';
  import { presence, peers } from '@zubra/sync';
  let strokes = [];
  let cursor = presence({ x: 3, y: 4 });
  let others = peers();
</script>
<board-view doc="">{strokes.length} {cursor.x} {others.length}</board-view>"#;

#[test]
fn presence_and_peers_are_passed_apart_from_the_stored_fields() {
    let js = compile_js(BOARD, "@zubra/runtime", "board-view.zb").unwrap();
    assert!(
        js.contains(r#"$collection("boards", ["doc"], $p, { strokes }, { cursor }, others);"#),
        "{js}"
    );
    // On the server: presence starts at its value, and nobody else is there.
    let html = compile(BOARD, r#"{"doc":"b1"}"#).unwrap();
    assert!(html.contains("0 3 0"), "{html}");
}

#[test]
fn peers_is_once_per_component() {
    let error = compile(
        "<script>'use collection b'; import { peers } from '@zubra/sync'; let a = peers(); let b = peers();</script>\n<x-y doc=\"\"></x-y>",
        "{}",
    )
    .unwrap_err();
    assert!(
        error.message.contains("once per component"),
        "{}",
        error.message
    );
}
