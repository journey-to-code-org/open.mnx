//! `<script lang="ts">` components, through every output.

use zubra::{compile, compile_declarations, compile_js, compile_manifest};

const PICKER: &str = r#"<!-- A typed picker. -->
<script lang="ts">
  import { emit, state, type Signal } from '@zubra/runtime'

  type Option = { id: number; label: string }
  interface Picked { option: Option; index: number }

  const optionsDefault: Option[] = [{ id: 1, label: "One" }, { id: 2, label: "Two" }]
  const headingDefault: string = "Pick one"
  const open: Signal.State<boolean> = state(false)

  function pick(option: Option, index: number): void {
    emit<Picked>('pick', { option, index })
  }
  const toggle = (): void => open.set(!open.get())
</script>
<zb-picker options={optionsDefault} heading={headingDefault}>
  <h2>{heading}</h2>
  <ul><zb-each items={options} as="option"><li>{option.label}</li></zb-each></ul>
</zb-picker>"#;

#[test]
fn build_time_values_still_render() {
    let html = compile(PICKER, "{}").unwrap();
    assert!(html.contains("<h2>Pick one</h2>"), "{html}");
    assert!(
        html.contains("<li>One</li>") && html.contains("<li>Two</li>"),
        "{html}"
    );
}

#[test]
fn the_javascript_has_no_types_and_keeps_its_lines() {
    let js = compile_js(PICKER, "@zubra/runtime", "picker.zb").unwrap();
    for typed in [
        ": Option",
        "type Option",
        "interface Picked",
        "emit<",
        ": void",
        "Signal.State<",
        "type Signal",
    ] {
        assert!(!js.contains(typed), "{typed} left in\n{js}");
    }
    assert!(js.contains("import { emit, state,"), "{js}");
    assert!(
        js.contains("function pick(option        , index        )       {"),
        "{js}"
    );
    assert!(
        js.contains("emit        ('pick', { option, index })"),
        "{js}"
    );
}

#[test]
fn declared_types_reach_the_typings_and_manifest() {
    let dts = compile_declarations(PICKER, "picker.zb").unwrap();
    assert!(dts.contains("  options: Option[];"), "{dts}");
    assert!(dts.contains("  heading: string;"), "{dts}");
    assert!(dts.contains("  pick: CustomEvent<Picked>;"), "{dts}");
    let manifest: serde_json::Value =
        serde_json::from_str(&compile_manifest(PICKER, "picker.js").unwrap()).unwrap();
    let element = &manifest["modules"][0]["declarations"][0];
    assert_eq!(element["attributes"][0]["type"]["text"], "Option[]");
    assert_eq!(element["events"][0]["type"]["text"], "CustomEvent<Picked>");
}

#[test]
fn type_only_exports_are_erasable() {
    // `export interface`, `export type` and `export type { … }` declare no value, so the
    // no-exports rule doesn't apply: they're removed, and reach the typings exported once.
    let source = "<script lang=\"ts\">\n  import type { Option } from './types'\n  export interface Picked { id: string }\n  export type Size = 'small' | 'large';\n  export type { Option }\n  declare const size: Size\n  const n: number = 1\n</script>\n<zb-x size=\"small\"><p>{n}</p></zb-x>";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(!js.contains("Picked") && !js.contains("Size ="), "{js}");
    let dts = compile_declarations(source, "x.zb").unwrap();
    assert_eq!(
        dts.matches("export interface Picked { id: string }")
            .count(),
        1,
        "{dts}"
    );
    assert_eq!(
        dts.matches("export type Size = 'small' | 'large'").count(),
        1,
        "{dts}"
    );
    assert_eq!(dts.matches("export type { Option }").count(), 1, "{dts}");
    assert!(dts.contains("  size: Size;"), "{dts}");
    // A value export is still refused.
    let error = compile_js(
        "<script lang=\"ts\">\n  export const x: number = 1\n</script>\n<zb-x><p>x</p></zb-x>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert!(error.message.contains("can't export"), "{}", error.message);
}

#[test]
fn errors_point_into_the_typescript_source() {
    // A non-erasable construct, on line 4.
    let source = "<script lang=\"ts\">\n  const a: number = 1\n\n  enum Color { Red }\n</script>\n<zb-x><p>x</p></zb-x>";
    let error = compile(source, "{}").unwrap_err();
    assert!(error.message.contains("`enum`"), "{}", error.message);
    assert_eq!((error.span.line, error.span.column), (4, 3));

    // A compiler check after stripping (an event name), still at the right place.
    let source = "<script lang=\"ts\">\n  import { emit } from '@zubra/runtime'\n  const n: number = 1\n  emit<number>('valueChange', n)\n</script>\n<zb-x><p>x</p></zb-x>";
    let error = compile_js(source, "@zubra/runtime", "x.zb").unwrap_err();
    assert!(
        error
            .help
            .as_deref()
            .unwrap_or_default()
            .starts_with("use `valuechange`"),
        "{:?}",
        error.help
    );
    assert_eq!((error.span.line, error.span.column), (4, 3));

    let source = "<script lang=\"ts\">\n  const a: = 1\n</script>\n<zb-x><p>x</p></zb-x>";
    let error = compile(source, "{}").unwrap_err();
    assert!(
        error.message.starts_with("invalid <script lang=\"ts\">"),
        "{}",
        error.message
    );
    assert_eq!(error.span.line, 2);
}

#[test]
fn only_lang_ts_is_accepted() {
    let error = compile(
        "<script lang=\"coffee\">\n</script>\n<zb-x><p>x</p></zb-x>",
        "{}",
    )
    .unwrap_err();
    assert!(
        error.message.contains("except lang=\"ts\""),
        "{}",
        error.message
    );
    // Without lang="ts", types are a syntax error, as in any JavaScript module.
    let error = compile(
        "<script>\n  const a: number = 1\n</script>\n<zb-x><p>x</p></zb-x>",
        "{}",
    )
    .unwrap_err();
    assert!(
        error.message.starts_with("invalid <script>"),
        "{}",
        error.message
    );
}

// Import elision: TypeScript drops an import whose names the module uses only as types, even
// without `import type`. Kept, `import { Option } from './types'` (an interface) makes the browser
// refuse the module: './types' has no runtime export named `Option`.

fn imports(js: &str) -> Vec<&str> {
    js.lines()
        .filter(|line| line.starts_with("import "))
        .collect()
}

#[test]
fn an_import_used_only_as_a_type_is_dropped_like_typescript_drops_it() {
    let source = r#"<script lang="ts">
  import { Option } from './types'
  const itemsDefault: Option[] = []
</script>
<zb-pick items={itemsDefault}><p>{items.length}</p></zb-pick>"#;
    for js in [
        compile_js(source, "@zubra/runtime", "pick.zb").unwrap(),
        zubra::compile_element_with(source, "pick.zb", Some(".js"), &|_, _| {
            Err("no components".to_owned())
        })
        .unwrap(),
    ] {
        assert!(!js.contains("./types"), "{js}");
    }
    // The typings still need it, as a type.
    let dts = compile_declarations(source, "pick.zb").unwrap();
    assert!(
        dts.contains("import type { Option } from './types';"),
        "{dts}"
    );
}

#[test]
fn only_the_type_only_names_go_and_the_rest_of_the_import_is_rewritten() {
    let source = r#"<script lang="ts">
  import Def, { Option, format, type Other, Size as S } from './types' with { type: 'module' }
  import * as T from './ns'
  let thing: T.Thing | null = null
  let d: typeof Def | null = null
  let o: Other | Option | null = null
  const label = format(S.Large)
</script>
<zb-mixed><p>{label}</p></zb-mixed>"#;
    let js = compile_js(source, "@zubra/runtime", "mixed.zb").unwrap();
    let lines = imports(&js);
    assert!(
        lines.contains(&"import { format, Size as S } from './types' with { type: 'module' };"),
        "{js}"
    );
    assert!(!js.contains("./ns"), "{js}");
}

#[test]
fn a_type_only_name_the_template_reads_is_kept() {
    let source = r#"<script lang="ts">
  import { Size } from './size'
  let chosen: Size | null = null
</script>
<zb-size big={Size.Large}><p>{chosen === Size.Small}</p></zb-size>"#;
    let js = compile_js(source, "@zubra/runtime", "size.zb").unwrap();
    assert!(
        imports(&js).contains(&"import { Size } from './size';"),
        "{js}"
    );
}

#[test]
fn an_import_the_script_never_mentions_is_kept_for_the_template_or_its_side_effects() {
    let source = r#"<script lang="ts">
  import { register } from './setup'
  import './polyfill'
</script>
<zb-plain><p>x</p></zb-plain>"#;
    let js = compile_js(source, "@zubra/runtime", "plain.zb").unwrap();
    assert!(js.contains("import { register } from './setup';"), "{js}");
    assert!(js.contains("import './polyfill';"), "{js}");
}

#[test]
fn a_tsx_component_s_type_only_import_is_dropped_too() {
    let source = "import { Option } from './types'\nexport default function ZbPick({ items }: { items: Option[] }) {\n  const first: Option | undefined = items[0]\n  return <p>{first ? first.id : ''}</p>\n}\n";
    let js = compile_js(source, "@zubra/runtime", "pick.zb.tsx").unwrap();
    assert!(!js.contains("./types"), "{js}");
}
