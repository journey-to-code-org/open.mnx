//! 3.0: a signal `const` in a script means its value, as in the template. `.get()`/`.set()`
//! written out stay, `signal(name)` is the signal itself, and `mnx migrate --to 3` prepares 2.x
//! code (it wraps the bare uses that passed the signal in `signal(…)`).

use mnx_compiler::{compile_js, prepare_for_3, uses_for_3, warnings};

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
fn a_signal_const_reads_as_its_value_in_the_script() {
    let js = compile_js(
        r#"<script>
  import { state, signal, watch } from '@mnx/runtime'
  const count = state(1)
  const total = count + 1
  function log() { console.log(count, { count }) }
  count.set(2)
  watch(signal(count), log)
</script>
<mnx-n><p>{count} {total}</p></mnx-n>"#,
        "@mnx/runtime",
        "n.mnx",
    )
    .unwrap();
    assert!(
        js.contains("const total = __mnxComputed(() => (count.get() + 1))"),
        "derived from the value: {js}"
    );
    assert!(
        js.contains("console.log(count.get(), { count: count.get() })"),
        "{js}"
    );
    assert!(
        js.contains("  count.set(2)\n"),
        "`.set()` written out stays: {js}"
    );
    assert!(
        js.contains("watch(signal(count), log)"),
        "`signal(count)` is the signal: {js}"
    );
    // Nothing warns about it: in 3.0 code, a bare name is its value on purpose.
    assert!(warnings(SOURCE).is_empty());
}

#[test]
fn migrate_to_3_lists_and_wraps_2x_uses_once_and_imports_signal() {
    let found: Vec<String> = uses_for_3(SOURCE)
        .iter()
        .map(|found| {
            format!(
                "{}:{} {}",
                found.span.line, found.span.column, found.message
            )
        })
        .collect();
    assert_eq!(
        found,
        [
            "6:13 in 2.x, `count` here is the signal; since 3.0 it's its value (as in the template)",
            "7:9 in 2.x, `doubled` here is the signal; since 3.0 it's its value (as in the template)",
        ]
    );
    assert!(uses_for_3(SOURCE)[0]
        .help
        .as_deref()
        .unwrap()
        .contains("`signal(count)`"));
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
    // Nothing left to wrap, and it compiles to what 2.x meant: the signals themselves.
    assert!(uses_for_3(&output).is_empty());
    assert_eq!(prepare_for_3(&output), (output.clone(), 0));
    let js = compile_js(&output, "@mnx/runtime", "n.mnx").unwrap();
    assert!(
        js.contains("formValue(signal(count))") && js.contains("watch(signal(doubled)"),
        "{js}"
    );
}

#[test]
fn no_signals_no_changes() {
    let source = "<script>\n  let count = 0\n</script>\n<mnx-n><p>{count}</p></mnx-n>";
    assert!(uses_for_3(source).is_empty());
    assert_eq!(prepare_for_3(source), (source.to_owned(), 0));
}
