//! `mnx convert`: React function components to mnx JSX components.

use mnx_compiler::{compile_js, convert};

const TODO_ITEM: &str = include_str!("fixtures/convert/TodoItem.jsx");

#[test]
fn hooks_become_what_they_stand_for() {
    let conversion = convert(TODO_ITEM, "TodoItem.jsx", None).unwrap();
    let out = &conversion.output;
    assert_eq!(conversion.tag, "todo-item");
    assert_eq!(conversion.file_name, "todo-item.mnx.jsx");
    assert!(
        conversion.unsupported.is_empty(),
        "{:?}",
        conversion.unsupported
    );
    assert!(
        conversion.compile_error.is_none(),
        "{:?}",
        conversion.compile_error
    );
    for expected in [
        "import { effect, onMount } from '@mnx/runtime';\n",
        "  let editing = false;\n",
        "  let draft = text;\n", // a lazy initializer runs once anyway
        "  let input = null;\n",
        "  const label = (done ? `${text} (done)` : text);\n",
        "  onMount(() => effect(() => {\n    if (editing) input.focus();\n  }));\n",
        "  onMount(() => {\n    console.log('mounted');",
        "  const save = () => {\n    editing = false;\n    saves = ((n) => n + 1)(saves);\n",
        "onInput={(e) => (draft = e.target.value)}",
        "<input type=\"checkbox\" checked={done} onChange={() => onToggle(!done)} />",
        "onDblClick={() => (editing = true)}",
    ] {
        assert!(out.contains(expected), "{expected:?} in\n{out}");
    }
    assert!(!out.contains("from 'react'"), "{out}");
    assert!(
        !out.contains("useState") && !out.contains(".current"),
        "{out}"
    );
    // A doc comment stays with the function.
    assert!(out.contains("/** One to-do, editable in place. */\nexport default function TodoItem("));
    compile_js(out, "@mnx/runtime", "todo-item.mnx.jsx").unwrap();
}

#[test]
fn a_one_word_name_needs_a_prefix() {
    let source = "import { useState } from 'react';\nexport default function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>{n}</button>;\n}\n";
    let error = convert(source, "Counter.jsx", None).unwrap_err();
    assert!(
        error.message.contains("`Counter` is one word"),
        "{}",
        error.message
    );
    assert!(error.help.unwrap().contains("--prefix app"));
    let conversion = convert(source, "Counter.jsx", Some("app")).unwrap();
    assert_eq!(conversion.tag, "app-counter");
    assert!(
        conversion
            .output
            .contains("export default function AppCounter()"),
        "{}",
        conversion.output
    );
    assert!(
        conversion.output.contains("onClick={() => (n = n + 1)}"),
        "{}",
        conversion.output
    );
    assert!(
        conversion.compile_error.is_none(),
        "{:?}",
        conversion.compile_error
    );
}

#[test]
fn react_namespace_typescript_and_named_exports() {
    let source = r#"import React from 'react';

export function PriceTag({ amount = 0, currency = "USD" }: { amount?: number; currency?: string }) {
  const [open, setOpen] = React.useState<boolean>(false);
  const text = React.useMemo(() => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount), [amount, currency]);
  return <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)}>{text}</button>;
}
"#;
    let conversion = convert(source, "PriceTag.tsx", None).unwrap();
    let out = &conversion.output;
    assert_eq!(conversion.file_name, "price-tag.mnx.tsx");
    assert!(
        out.starts_with("\nexport default function PriceTag(")
            || out.starts_with("export default function PriceTag("),
        "{out}"
    );
    assert!(out.contains("let open = false;"), "{out}");
    assert!(out.contains("const text = new Intl.NumberFormat"), "{out}");
    assert!(
        out.contains("onClick={() => (open = ((was) => !was)(open))}"),
        "{out}"
    );
    assert!(
        conversion.unsupported.is_empty(),
        "{:?}",
        conversion.unsupported
    );
}

#[test]
fn what_isnt_converted_is_reported_where_it_is() {
    let source = r#"import { useContext, useReducer, useState } from 'react';
import { Theme } from './theme';

export default function UserMenu(props) {
  const theme = useContext(Theme);
  const [state, dispatch] = useReducer(reduce, {});
  const [open, setOpen] = useState(false);
  return <nav {...props.rest} dangerouslySetInnerHTML={{ __html: props.html }} onClick={() => setOpen(!open)} />;
}
"#;
    let conversion = convert(source, "UserMenu.jsx", None).unwrap();
    let report: Vec<String> = conversion
        .unsupported
        .iter()
        .map(|diagnostic| {
            format!(
                "{}:{} {}",
                diagnostic.span.line, diagnostic.span.column, diagnostic.message
            )
        })
        .collect();
    assert_eq!(
        report,
        [
            "4:34 props as one object (`props`) aren't converted",
            "5:17 `useContext` became `inject()`, but its context comes from elsewhere",
            "8:15 spread attributes aren't converted",
            "8:31 `dangerouslySetInnerHTML` isn't converted",
        ]
    );
    // What it could do, it did; `react` keeps what's still used.
    assert!(conversion.output.contains("let open = false;"));
    assert!(
        conversion
            .output
            .starts_with("import { inject } from '@mnx/runtime';"),
        "{}",
        conversion.output
    );
    assert!(
        conversion.output.contains(
            "let state = {};\n  const dispatch = (action) => (state = reduce(state, action));"
        ),
        "{}",
        conversion.output
    );
    assert!(
        conversion.compile_error.is_none(),
        "not compiled while things are left"
    );
}

#[test]
fn no_component_is_an_error() {
    let error = convert("export const Card = () => <div />;\n", "Card.jsx", None).unwrap_err();
    assert!(
        error.message.contains("no component to convert"),
        "{}",
        error.message
    );
}

#[test]
fn context_reducer_and_passed_on_callbacks_are_converted() {
    let source = r#"import React, { useReducer, useContext, createContext } from 'react';
import Dialog from './dialog.mnx';

const Theme = createContext('light');

function reducer(state, action) {
  return action.type === 'add' ? { count: state.count + action.by } : state;
}

/** Counts. */
export default function ThemedCounter({ step = 1, onClose, onCountChange }) {
  const theme = useContext(Theme);
  const [state, dispatch] = useReducer(reducer, { count: 0 }, (initial) => initial);
  function add() {
    dispatch({ type: 'add', by: step });
    onCountChange(state.count);
  }
  return (
    <div className={theme}>
      <button onClick={add}>+{step}</button>
      <Dialog onClose={onClose} onOpen={onClose} />
    </div>
  );
}
"#;
    let conversion = convert(source, "ThemedCounter.jsx", None).unwrap();
    assert!(
        conversion.unsupported.is_empty(),
        "{:?}",
        conversion.unsupported
    );
    let output = &conversion.output;
    assert!(
        output.starts_with("import { createContext, inject } from '@mnx/runtime';"),
        "{output}"
    );
    assert!(
        output.contains("const Theme = createContext('light');"),
        "{output}"
    );
    assert!(output.contains("const theme = inject(Theme);"), "{output}");
    assert!(
        output.contains("let state = ((initial) => initial)({ count: 0 });\n  const dispatch = (action) => (state = reducer(state, action));"),
        "{output}"
    );
    assert!(
        output.contains(
            "<Dialog onClose={(event) => onClose(event)} onOpen={(event) => onClose(event)} />"
        ),
        "{output}"
    );
    // The compile check needs the child's file; that is the only thing reported.
    assert!(
        conversion
            .compile_error
            .as_ref()
            .is_some_and(|error| error.message.contains("./dialog.mnx")),
        "{:?}",
        conversion.compile_error
    );
}

#[test]
fn exported_context_and_providers_are_reported() {
    let source = r#"import { createContext } from 'react';
export const Theme = createContext('light');
export default function ThemeRoot({ children }) {
  return <Theme.Provider value="dark">{children}</Theme.Provider>;
}
"#;
    let conversion = convert(source, "ThemeRoot.jsx", None).unwrap();
    let messages: Vec<&str> = conversion
        .unsupported
        .iter()
        .map(|d| d.message.as_str())
        .collect();
    assert_eq!(
        messages,
        [
            "an exported context can't stay in a component file",
            "`<Context.Provider>` isn't converted"
        ]
    );
}

#[test]
fn as_mnx_writes_a_readable_html_first_file() {
    let source = r#"import { useState, useEffect } from 'react';

/** A toggle button. */
export default function AppToggle({ label = 'On', onToggle }) {
  const [on, setOn] = useState(false);
  const text = on ? `${label}: yes` : `${label}: no`;
  useEffect(() => { document.title = text; }, [text]);
  return (
    <div className="toggle">
      <button aria-pressed={on} onClick={() => { setOn(!on); onToggle(!on); }}>
        {text}
      </button>
      {on && <em>lit</em>}
    </div>
  );
}
"#;
    let mut conversion = convert(source, "Toggle.jsx", None).unwrap();
    assert!(conversion.unsupported.is_empty() && conversion.compile_error.is_none());
    assert!(mnx_compiler::convert_as_mnx(&mut conversion).is_none());
    assert_eq!(conversion.file_name, "app-toggle.mnx");
    assert_eq!(
        conversion.output,
        "<!--\nA toggle button.\n-->\n<script>\nimport { emit } from '@mnx/runtime';\nimport { effect, onMount } from '@mnx/runtime';\nlet on = false;\nconst text = on ? `${label}: yes` : `${label}: no`;\nonMount(() => effect(() => { document.title = text; }));\n</script>\n<app-toggle label={'On'}>\n  <div class=\"toggle\">\n    <button aria-pressed={on} onclick={() => { on = !on; emit(\"toggle\", !on); }}>\n      {text}\n    </button>\n    <mnx-if test={on}><em>lit</em></mnx-if>\n  </div>\n</app-toggle>\n"
    );
    // And it compiles as an .mnx file.
    mnx_compiler::compile_js(&conversion.output, "@mnx/runtime", "app-toggle.mnx").unwrap();
}
