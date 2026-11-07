//! 2.6's preparation for 3.0: signal `const`s passed as themselves in scripts are flagged, and
//! `mnx migrate --to 3` wraps them in `signal(…)`.

use mnx_compiler::{compile_js, prepare_for_3, warnings};

const SOURCE: &str = r#"<script>
  import { state, computed, watch, formValue } from '@mnx/runtime'

  const count = state(0)
  const doubled = computed(() => count.get() * 2)
  formValue(count)
  watch(doubled, (next) => console.log(next))
  function reset() { count.set(0) }
</script>
<mnx-n><button onclick={reset}>{count} {doubled}</button></mnx-n>"#;

#[test]
fn passing_a_signal_itself_warns_and_get_set_do_not() {
    let found: Vec<String> = warnings(SOURCE)
        .iter()
        .map(|warning| {
            format!(
                "{}:{} {}",
                warning.span.line, warning.span.column, warning.message
            )
        })
        .collect();
    assert_eq!(
        found,
        [
            "6:13 in 3.0, `count` in a script means its value (as in the template), not the signal",
            "7:9 in 3.0, `doubled` in a script means its value (as in the template), not the signal",
        ]
    );
    let help = warnings(SOURCE)[0].help.clone().unwrap();
    assert!(
        help.contains("`signal(count)`") && help.contains("mnx migrate --to 3"),
        "{help}"
    );
}

#[test]
fn migrate_to_3_wraps_them_once_and_imports_signal() {
    let (output, wrapped) = prepare_for_3(SOURCE);
    assert_eq!(wrapped, 2);
    assert!(
        output.contains("import { state, computed, watch, formValue, signal } from '@mnx/runtime'"),
        "{output}"
    );
    assert!(
        output.contains("  formValue(signal(count))\n  watch(signal(doubled), (next)"),
        "{output}"
    );
    assert!(output.contains("count.get() * 2") && output.contains("count.set(0)"));
    // Nothing left to warn about or wrap, and it still compiles.
    assert!(warnings(&output).is_empty());
    assert_eq!(prepare_for_3(&output), (output.clone(), 0));
    compile_js(&output, "@mnx/runtime", "n.mnx").unwrap();
}

#[test]
fn no_signals_no_changes() {
    let source = "<script>\n  let count = 0\n</script>\n<mnx-n><p>{count}</p></mnx-n>";
    assert!(warnings(source).is_empty());
    assert_eq!(prepare_for_3(source), (source.to_owned(), 0));
}
