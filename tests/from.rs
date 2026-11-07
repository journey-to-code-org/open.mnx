//! `let x = from(prop)`: state that follows a prop until it's assigned, and starts over when the
//! prop changes (`plan/roadmap-3.0.md`, challenge 3).

use mnx_compiler::{compile, compile_js, convert};

const TIMER: &str = r#"<script>
  import { from } from '@mnx/runtime'
  let left = from(seconds)
  let running = from(seconds, false)
</script>
<x-timer seconds={5}>
  <p>{left} {running}</p>
  <button onclick={() => left--}>-</button>
</x-timer>"#;

#[test]
fn the_compiler_passes_the_prop_as_a_function() {
    let js = compile_js(TIMER, "@mnx/runtime", "x.mnx").unwrap();
    assert!(js.contains("const left = from(() => ($p.seconds))"), "{js}");
    assert!(
        js.contains("const running = from(() => ($p.seconds), () => (false))"),
        "{js}"
    );
    // It's state: read with .get(), assigned with .set().
    assert!(js.contains("__mnxUpdate(left, -1, false)"), "{js}");
    assert!(!js.contains("__mnxState(from"), "{js}");
}

#[test]
fn the_server_renders_where_it_starts() {
    assert_eq!(
        compile(TIMER, "{}").unwrap(),
        "<x-timer>\n  <p>5 false</p>\n  <button>-</button>\n</x-timer>"
    );
    assert_eq!(
        compile(TIMER, r#"{"seconds":9}"#).unwrap(),
        "<x-timer seconds=\"9\">\n  <p>9 false</p>\n  <button>-</button>\n</x-timer>"
    );
}

#[test]
fn it_takes_a_let_and_the_runtime_import() {
    let error = compile_js(
        "<script>\n  import { from } from '@mnx/runtime'\n  const left = from(seconds)\n</script>\n<x-t seconds={1}>{left}</x-t>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap_err();
    assert!(
        error.message.contains("declare it with `let`"),
        "{}",
        error.message
    );
    assert_eq!(
        error.help.as_deref(),
        Some("a `const` that reads the prop already follows it: `const left = seconds`")
    );
    // Renamed on import, it still works; another `from` is just a call.
    let js = compile_js(
        "<script>\n  import { from as linked } from '@mnx/runtime'\n  let left = linked(seconds)\n</script>\n<x-t seconds={1}>{left}</x-t>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap();
    assert!(
        js.contains("const left = linked(() => ($p.seconds))"),
        "{js}"
    );
    let js = compile_js(
        "<script>\n  import { from } from './rows.js'\n  let left = from(seconds)\n</script>\n<x-t seconds={1}>{left}</x-t>",
        "@mnx/runtime",
        "x.mnx",
    )
    .unwrap();
    assert!(
        js.contains("const left = __mnxState(from($p.seconds))"),
        "{js}"
    );
}

#[test]
fn jsx_components_use_it_too() {
    let js = compile_js(
        "import { from } from '@mnx/runtime'\nexport default function XT({ seconds = 5 }) {\n  let left = from(seconds)\n  return <button onClick={() => left--}>{left}</button>\n}\n",
        "@mnx/runtime",
        "x.mnx.jsx",
    )
    .unwrap();
    assert!(js.contains("const left = from(() => ($p.seconds))"), "{js}");
    assert!(js.contains("__mnxUpdate(left, -1, false)"), "{js}");
}

#[test]
fn convert_turns_a_reset_effect_into_from() {
    let source = "import { useState, useEffect } from 'react'\nexport default function FocusTimer({ seconds = 1500 }) {\n  const [left, setLeft] = useState(seconds)\n  const [running, setRunning] = useState(false)\n  useEffect(() => {\n    setLeft(seconds)\n    setRunning(false)\n  }, [seconds])\n  return <button onClick={() => setLeft(left - 1)}>{left} {String(running)}</button>\n}\n";
    let conversion = convert(source, "FocusTimer.jsx", None).unwrap();
    let out = &conversion.output;
    assert!(
        conversion.compile_error.is_none(),
        "{:?}",
        conversion.compile_error
    );
    assert!(
        out.contains("import { from } from '@mnx/runtime';\n"),
        "{out}"
    );
    assert!(
        out.contains("  let left = from(seconds)\n  let running = from(seconds, false)\n  return"),
        "{out}"
    );
    assert!(
        !out.contains("useEffect") && !out.contains("effect("),
        "{out}"
    );
    // A reset to something other than the starting value stays an effect.
    let other = source.replace("setRunning(false)", "setRunning(true)");
    let out = convert(&other, "FocusTimer.jsx", None).unwrap().output;
    assert!(out.contains("onMount(() => effect("), "{out}");
    assert!(!out.contains("from("), "{out}");
}
