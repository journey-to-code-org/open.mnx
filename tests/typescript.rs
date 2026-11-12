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
    // A construct TypeScript itself refuses in an ES module, on line 4.
    let source = "<script lang=\"ts\">\n  const a: number = 1\n\n  import x = require('x')\n</script>\n<zb-x><p>x</p></zb-x>";
    let error = compile(source, "{}").unwrap_err();
    assert!(error.message.contains("require"), "{}", error.message);
    assert_eq!((error.span.line, error.span.column), (4, 3));

    // A compiler check after stripping (an event name), still at the right place, after an enum
    // whose lowering is longer than its source.
    let source = "<script lang=\"ts\">\n  import { emit } from '@zubra/runtime'\n  enum E { A, B }\n  emit<number>('valueChange', E.A)\n</script>\n<zb-x><p>x</p></zb-x>";
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

// ---- enums ----------------------------------------------------------------------------------

fn element(source: &str) -> String {
    zubra::compile_element_with(source, "x.zb", Some(".js"), &|_, _| {
        Err("no components".to_owned())
    })
    .unwrap()
}

#[test]
fn an_enum_is_lowered_to_an_object_in_place_with_its_lines() {
    let source = "<script lang=\"ts\">\n  enum Size {\n    Small,\n    Large = 4,\n  }\n  const big = Size.Large\n</script>\n<zb-x><p>{big} {Size[4]}</p></zb-x>";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(
        js.contains("  const Size = {\n    Small: 0, \"0\": \"Small\",\n    Large: 4, \"4\": \"Large\",\n  };\n  const big = Size.Large"),
        "{js}"
    );
    // A numeric enum's reverse mapping works at build time too (an object indexed by a number).
    assert_eq!(
        compile(source, "{}").unwrap(),
        "<zb-x><p>4 Large</p></zb-x>"
    );
}

#[test]
fn an_exported_enum_is_exported_by_the_module_and_typed_for_consumers() {
    let source = r#"<script lang="ts">
  export enum Size {
    Small = "small",
    Large = "large",
  }
  declare const size: Size
</script>
<zb-x size={Size.Small}><p>{size === Size.Large}</p></zb-x>"#;
    let module = "export const Size = {\n  Small: \"small\",\n  Large: \"large\",\n};\n";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(js.contains(module), "{js}");
    let element = element(source);
    assert!(element.contains(module), "{element}");
    for typings in [
        compile_declarations(source, "x.zb").unwrap(),
        zubra::compile_declarations_for(source, "x.zb", zubra::Framework::React).unwrap(),
    ] {
        assert!(
            typings.contains(
                "export declare enum Size {\n  Small = \"small\",\n  Large = \"large\",\n}"
            ),
            "{typings}"
        );
        assert!(typings.contains("size?: Size;"), "{typings}");
    }
}

#[test]
fn a_prop_whose_default_is_an_enum_member_is_typed_with_the_enum() {
    let source = "<script lang=\"ts\">\n  export enum Size { Small, Large }\n</script>\n<zb-x size={Size.Large}><p>{size}</p></zb-x>";
    let dts = compile_declarations(source, "x.zb").unwrap();
    assert!(dts.contains("  size: Size;"), "{dts}");
}

#[test]
fn a_prop_typed_with_an_unexported_enum_is_an_error_for_strings_and_a_warning_for_numbers() {
    let strings = "<script lang=\"ts\">\n  enum Tone { Warm = \"warm\" }\n  declare const tone: Tone\n</script>\n<zb-x tone={Tone.Warm}><p>{tone}</p></zb-x>";
    let error = compile_js(strings, "@zubra/runtime", "x.zb").unwrap_err();
    assert!(
        error.message.contains("doesn't export"),
        "{}",
        error.message
    );
    assert_eq!(error.help.as_deref(), Some("write `export enum Tone`"));

    let numbers = "<script lang=\"ts\">\n  enum Size { Small, Large }\n  declare const size: Size\n</script>\n<zb-x size={Size.Large}><p>{size}</p></zb-x>";
    assert!(compile_js(numbers, "@zubra/runtime", "x.zb").is_ok());
    let warnings = zubra::warnings(numbers);
    assert!(
        warnings
            .iter()
            .any(|warning| warning.message.contains("consumers can pass numbers")),
        "{warnings:?}"
    );
}

#[test]
fn an_enum_prop_s_attribute_takes_a_member_s_value_or_its_name() {
    let source = "<script lang=\"ts\">\n  export enum Size { Small, Medium = 4, Large }\n  declare const size: Size\n</script>\n<zb-x size={Size.Medium}><p>{size}</p></zb-x>";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(
        js.contains(r#""size": { attribute: "size", default: 4, required: false, enum: { Small: 0, Medium: 4, Large: 5 } },"#),
        "{js}"
    );
    let element = element(source);
    assert!(
        element.contains(r#"this.size = raw === null ? 4 : fromEnum(raw, { Small: 0, Medium: 4, Large: 5 }, 4, "size");"#),
        "{element}"
    );
    assert!(
        element.contains("function fromEnum(raw, members, fallback, attribute) {"),
        "{element}"
    );
    // Server rendering takes the same forms.
    for given in [r#"{"size": "Large"}"#, r#"{"size": "5"}"#, r#"{"size": 5}"#] {
        assert_eq!(
            compile(source, given).unwrap(),
            "<zb-x size=\"5\"><p>5</p></zb-x>",
            "{given}"
        );
    }
}

#[test]
fn the_manifest_and_html_data_know_an_enum_prop_s_members() {
    let source = "<script lang=\"ts\">\n  export enum Size { Small, Large }\n  declare const size: Size\n</script>\n<zb-x size={Size.Small}><p>{size}</p></zb-x>";
    let manifest: serde_json::Value =
        serde_json::from_str(&compile_manifest(source, "x.js").unwrap()).unwrap();
    let module = &manifest["modules"][0];
    assert_eq!(
        module["declarations"][1],
        serde_json::json!({ "kind": "variable", "name": "Size", "description": "The enum `Size`.", "type": { "text": "{ Small: 0, Large: 1 }" } })
    );
    assert_eq!(
        module["exports"][2],
        serde_json::json!({ "kind": "js", "name": "Size", "declaration": { "name": "Size", "module": "x.js" } })
    );
    assert_eq!(
        module["declarations"][0]["attributes"][0]["type"],
        serde_json::json!({ "text": "Size", "references": [{ "name": "Size", "module": "x.js" }] })
    );
    let data: serde_json::Value =
        serde_json::from_str(&zubra::compile_html_data(source).unwrap()).unwrap();
    assert_eq!(
        data["tags"][0]["attributes"][0]["values"],
        serde_json::json!([
            { "name": "Small", "description": "`Size.Small` (`0`)" },
            { "name": "Large", "description": "`Size.Large` (`1`)" },
        ])
    );
}

#[test]
fn enum_mistakes_are_errors_that_say_what_to_write() {
    for (script, message) in [
        (
            "enum E { A = \"a\", B }",
            "enum member `B` needs an initializer",
        ),
        (
            "export enum E { A = Math.random() }",
            "isn't a constant, and an exported enum's members must be",
        ),
        (
            "export enum E { A }\n  enum E { B = 1 }",
            "`E` is exported, so it's declared once",
        ),
        (
            "enum E { A }\n  enum E { B }",
            "this declaration adds to an earlier `enum E`",
        ),
    ] {
        let source = format!("<script lang=\"ts\">\n  {script}\n</script>\n<zb-x><p>x</p></zb-x>");
        let error = compile_js(&source, "@zubra/runtime", "x.zb").unwrap_err();
        assert!(
            error.message.contains(message),
            "{script}: {}",
            error.message
        );
    }
}

// Enums imported from TypeScript modules: their values are read from the module.

fn loader(
    files: &'static [(&'static str, &'static str)],
) -> impl Fn(&str, &str) -> Result<(String, String), String> {
    move |specifier: &str, _from: &str| {
        let path = specifier.trim_start_matches("./").to_owned();
        files
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(name, source)| ((*name).to_owned(), (*source).to_owned()))
            .ok_or_else(|| format!("{path}: not found"))
    }
}

#[test]
fn an_imported_const_enum_is_inlined_since_typescript_erases_it() {
    let files: &[(&str, &str)] = &[
        ("index.ts", "export * from './sizes'\n"),
        ("sizes.ts", "export const enum Size { Small = 1, Large = Small * 4 }\nexport enum Tone { Warm = \"warm\", Cool = \"cool\" }\n"),
    ];
    let source = r#"<script lang="ts">
  import { Size, Tone } from './index.js'
  declare const size: Size
  declare const tone: Tone
  const total = Size.Large + 1
</script>
<zb-x size={Size.Large} tone={Tone.Cool}><p>{size} {tone} {Size.Small} {total}</p></zb-x>"#;
    let loader = loader(files);
    let js =
        zubra::compile_js_with(source, "x.zb", "@zubra/runtime", Some(".js"), &loader).unwrap();
    assert!(js.contains("import { Tone } from './index.js';"), "{js}");
    assert!(!js.contains("import { Size"), "{js}");
    assert!(js.contains("const Size = { Small: 1, Large: 4 };"), "{js}");
    assert!(js.contains("enum: { Small: 1, Large: 4 }"), "{js}");
    assert!(js.contains(r#""tone": { attribute: "tone", default: "cool", required: false, enum: { Warm: "warm", Cool: "cool" } },"#), "{js}");
    let html = zubra::compile_html_with(source, "x.zb", "{}", "{}", &loader).unwrap();
    // The inlined enum is declared before the script's bindings, which can use it.
    assert_eq!(html, "<zb-x><p>4 cool 1 5</p></zb-x>");
}

#[test]
fn an_imported_const_enum_that_can_t_be_worked_out_is_an_error_not_a_broken_import() {
    let files: &[(&str, &str)] = &[("bad.ts", "export const enum Bad { A = Math.floor(1.5) }\n")];
    let source = "<script lang=\"ts\">\n  import { Bad } from './bad'\n  const a = Bad.A\n</script>\n<zb-x><p>{a}</p></zb-x>";
    let error = zubra::compile_js_with(
        source,
        "x.zb",
        "@zubra/runtime",
        Some(".js"),
        &loader(files),
    )
    .unwrap_err();
    assert!(
        error.message.contains("`Bad` is a `const enum`"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("would fail in the browser"),
        "{}",
        error.message
    );
    assert_eq!(error.span.line, 2);
}

#[test]
fn types_after_an_enum_still_reach_the_typings() {
    // The lowered enum is longer than its source, so what's recorded by offset moves with it.
    let source = "<script lang=\"ts\">\n  import { emit } from '@zubra/runtime'\n  enum E { A, B }\n  declare const size: 'small' | 'large'\n  function pick() { emit<{ at: number }>('pick', { at: E.B }) }\n</script>\n<zb-x size=\"small\"><p onclick={pick}>x</p></zb-x>";
    let dts = compile_declarations(source, "x.zb").unwrap();
    assert!(dts.contains("pick: CustomEvent<{ at: number }>;"), "{dts}");
    assert!(dts.contains("size: 'small' | 'large';"), "{dts}");
}

#[test]
fn a_tsx_component_can_declare_and_export_enums_too() {
    let source = "export enum Size { Small = \"small\", Large = \"large\" }\nenum Inner { A }\nexport default function ZbSized({ size = Size.Small }: { size?: Size }) {\n  return <p>{size === Size.Large ? \"big\" : Inner.A}</p>\n}\n";
    let js = compile_js(source, "@zubra/runtime", "sized.zb.tsx").unwrap();
    assert!(
        js.contains("export const Size = { Small: \"small\", Large: \"large\" };"),
        "{js}"
    );
    assert!(
        js.contains("enum: { Small: \"small\", Large: \"large\" }"),
        "{js}"
    );
    assert!(js.contains("const Inner = { A: 0, \"0\": \"A\" };"), "{js}");
}

// ---- namespaces, parameter properties and the rest of the language ---------------------------

#[test]
fn a_namespace_is_lowered_in_place_and_the_template_can_read_it() {
    let source = "<script lang=\"ts\">\n  namespace Units {\n    export const base = 4\n    export function px(n: number): string { return n * base + 'px' }\n  }\n  const width = Units.px(2)\n</script>\n<zb-x><p>{width}</p></zb-x>";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(
        js.contains("  const Units = {}; (function (Units) {\n    Units.base = 4\n           function px(n        )         { return n * Units.base + 'px' } Units.px = px;\n  })(Units);\n  const width = Units.px(2)"),
        "{js}"
    );
}

#[test]
fn parameter_properties_become_fields_assigned_in_the_constructor() {
    let source = "<script lang=\"ts\">\n  class Point extends Object {\n    constructor(public x: number, private readonly y = 2) {\n      super()\n    }\n  }\n  const point = new Point(1)\n</script>\n<zb-x><p>{point.x}</p></zb-x>";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(js.contains("class Point extends Object { x; y;"), "{js}");
    assert!(
        js.contains("      super(); this.x = x; this.y = y;\n"),
        "{js}"
    );
}

#[test]
fn a_this_parameter_an_angle_bracket_assertion_and_an_import_alias_are_types_or_values() {
    let source = "<script lang=\"ts\">\n  namespace Config { export const port = 8080; export type Port = number }\n  import port = Config.port\n  import Port = Config.Port\n  function f(this: Window, a: number) { return a }\n  const n = <Port>f.call(window, port)\n</script>\n<zb-x><p>{n}</p></zb-x>";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(js.contains("const  port = Config.port"), "{js}");
    assert!(!js.contains("Config.Port"), "{js}");
    assert!(
        js.contains("function f(              a        ) { return a }"),
        "{js}"
    );
    assert!(js.contains("const n =       f.call(window, port)"), "{js}");
}

#[test]
fn what_typescript_itself_refuses_in_an_es_module_is_refused_with_its_error_code() {
    for (script, message) in [
        ("import fs = require('fs')", "TS1202"),
        ("const x = 1\n  export = x", "TS1203"),
        (
            "export namespace N { export const a = 1 }",
            "can't export a namespace",
        ),
    ] {
        let source = format!("<script lang=\"ts\">\n  {script}\n</script>\n<zb-x><p>x</p></zb-x>");
        let error = compile_js(&source, "@zubra/runtime", "x.zb").unwrap_err();
        assert!(
            error.message.contains(message),
            "{script}: {}",
            error.message
        );
    }
}

// ---- tsconfig.json ----------------------------------------------------------------------------

/// A project folder: `(relative path, contents)`.
fn project(name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("zubra-tsconfig-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, contents) in files {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    root
}

#[test]
fn the_nearest_tsconfig_with_what_it_extends_decides_how_class_fields_are_written() {
    let component = "<script lang=\"ts\">\n  class Counter { count = 1; constructor(public step: number) {} }\n  const counter = new Counter(2)\n</script>\n<zb-x><p>{counter.count}</p></zb-x>";
    let root = project("fields", &[
        ("tsconfig.base.json", "{\n  // ES2020: fields are assignments\n  \"compilerOptions\": { \"target\": \"ES2020\", },\n}"),
        ("tsconfig.json", "{ \"extends\": \"./tsconfig.base\" }"),
        ("src/x.zb", component),
        ("modern/tsconfig.json", "{ \"compilerOptions\": { \"target\": \"ES2022\" } }"),
        ("modern/x.zb", component),
    ]);
    let older =
        zubra::compile_js_file(root.join("src/x.zb").to_str().unwrap(), "@zubra/runtime").unwrap();
    assert!(
        older.contains("class Counter {  constructor(       step        ) { this.step = step; this.count = 1;} }"),
        "{older}"
    );
    let modern =
        zubra::compile_js_file(root.join("modern/x.zb").to_str().unwrap(), "@zubra/runtime")
            .unwrap();
    assert!(
        modern.contains("class Counter { step; count = 1; constructor(       step        ) { this.step = step;} }"),
        "{modern}"
    );
}

#[test]
fn verbatim_module_syntax_keeps_imports_and_wants_type_on_types() {
    let root = project("verbatim", &[
        ("tsconfig.json", "{ \"compilerOptions\": { \"verbatimModuleSyntax\": true } }"),
        ("types.ts", "export interface Option { id: string }\n"),
        ("x.zb", "<script lang=\"ts\">\n  import { Option } from './types'\n  const itemsDefault: Option[] = []\n</script>\n<zb-x items={itemsDefault}><p>x</p></zb-x>"),
    ]);
    let error =
        zubra::compile_js_file(root.join("x.zb").to_str().unwrap(), "@zubra/runtime").unwrap_err();
    assert!(error.message.contains("TS1484"), "{}", error.message);
    assert_eq!(
        error.help.as_deref(),
        Some("write `import type { Option }`, or `import { type Option }`")
    );
    assert_eq!(error.span.line, 2);
}

#[test]
fn paths_reach_a_const_enum_in_another_folder() {
    let root = project("paths", &[
        ("tsconfig.json", "{ \"compilerOptions\": { \"baseUrl\": \"./src\", \"paths\": { \"@shared/*\": [\"shared/*\"] } } }"),
        ("src/shared/sizes.ts", "export const enum Size { Small = 1, Large = 2 }\n"),
        ("src/components/x.zb", "<script lang=\"ts\">\n  import { Size } from '@shared/sizes'\n  const big = Size.Large\n</script>\n<zb-x><p>{big}</p></zb-x>"),
    ]);
    let js = zubra::compile_js_file(
        root.join("src/components/x.zb").to_str().unwrap(),
        "@zubra/runtime",
    )
    .unwrap();
    assert!(js.contains("const Size = { Small: 1, Large: 2 };"), "{js}");
    assert!(!js.contains("@shared/sizes'"), "{js}");
}

#[test]
fn a_tsconfig_that_appears_or_changes_is_seen_by_a_long_lived_compiler() {
    // The parse cache (one compiler answering many requests) keys on the source and checks the
    // imports; the tsconfig.json options are part of what it checks too.
    let root = project("cache", &[
        ("types.ts", "export interface Option { id: string }\n"),
        ("x.zb", "<script lang=\"ts\">\n  import { Option } from './types'\n  const itemsDefault: Option[] = []\n</script>\n<zb-x items={itemsDefault}><p>x</p></zb-x>"),
    ]);
    let file = root.join("x.zb");
    assert!(zubra::compile_js_file(file.to_str().unwrap(), "@zubra/runtime").is_ok());
    // A tsconfig.json appears beside it: the same source is compiled again, and now refused.
    std::fs::write(
        root.join("tsconfig.json"),
        "{ \"compilerOptions\": { \"verbatimModuleSyntax\": true } }",
    )
    .unwrap();
    let error = zubra::compile_js_file(file.to_str().unwrap(), "@zubra/runtime").unwrap_err();
    assert!(error.message.contains("TS1484"), "{}", error.message);
    // And when it changes back.
    std::fs::write(root.join("tsconfig.json"), "{ \"compilerOptions\": {} }").unwrap();
    assert!(zubra::compile_js_file(file.to_str().unwrap(), "@zubra/runtime").is_ok());
}

// ---- decorators -------------------------------------------------------------------------------

#[test]
fn legacy_decorators_are_written_as_typescript_writes_them_keeping_lines() {
    let root = project("decorators", &[
        ("tsconfig.json", "{ \"compilerOptions\": { \"experimentalDecorators\": true } }"),
        ("x.zb", "<script lang=\"ts\">\n  function bump(target: any, key: string, descriptor: PropertyDescriptor) { const run = descriptor.value; descriptor.value = () => run() + 1 }\n  class Counter {\n    @bump\n    next() { return 1 }\n  }\n  const value = new Counter().next()\n</script>\n<zb-x><p>{value}</p></zb-x>"),
    ]);
    let js = zubra::compile_js_file(root.join("x.zb").to_str().unwrap(), "@zubra/runtime").unwrap();
    assert!(
        js.contains("const __zubraDecorate = function (decorators, target, key, desc) {"),
        "{js}"
    );
    assert!(
        js.contains("  class Counter {\n    \n    next() { return 1 }\n  } __zubraDecorate([bump], Counter.prototype, \"next\", null);\n  const value = new Counter().next()"),
        "{js}"
    );
}

#[test]
fn standard_decorators_are_lowered_as_typescript_lowers_them_keeping_lines() {
    let source = "<script lang=\"ts\">\n  function bump(run: any, context: ClassMethodDecoratorContext) { return () => run() + 1 }\n  class Counter {\n    @bump\n    next() { return 1 }\n  }\n  const value = new Counter().next()\n</script>\n<zb-x><p>{value}</p></zb-x>";
    let js = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(
        js.contains("const __zubraEsDecorate = function (ctor, descriptorIn"),
        "{js}"
    );
    assert!(js.contains("  const Counter = (() => { let _zb_instanceExtra = []; let _zb_d0; return class Counter { static { "), "{js}");
    assert!(
        js.contains("__zubraEsDecorate(this, null, _zb_d0, { kind: \"method\", name: \"next\""),
        "{js}"
    );
    assert!(
        js.contains(
            "\n    \n    next() { return 1 }\n  }; })();\n  const value = new Counter().next()"
        ),
        "{js}"
    );
}

fn module(source: &str) -> String {
    zubra::typescript_to_js(source, None).unwrap()
}

#[test]
fn a_decorated_class_keeps_its_export() {
    let named = module("declare const d: any;\nexport @d class A {}\n");
    assert!(
        named.contains("export  const A = (() => { let _zb_classDecorators = [d]"),
        "{named}"
    );
    assert!(named.contains("var A = class   {"), "{named}");
    assert!(
        named.ends_with("; return A = _zb_classThis; })();\n"),
        "{named}"
    );
    let default = module("declare const d: any;\nexport default @d class B {}\n");
    assert!(default.contains("const B = (() => {"), "{default}");
    assert!(!default.contains("export default"), "{default}");
    assert!(
        default.contains("})(); export { B as default };"),
        "{default}"
    );
    let anonymous = module("declare const d: any;\nexport default @d class {}\n");
    assert!(
        anonymous.contains("export default  (() => {"),
        "{anonymous}"
    );
    assert!(
        anonymous.contains("__zubraSetFunctionName(this, \"default\");"),
        "{anonymous}"
    );
    assert!(anonymous.contains("return (class {"), "{anonymous}");
    assert!(
        anonymous.ends_with("), _zb_classThis; })();\n"),
        "{anonymous}"
    );
}

#[test]
fn accessor_fields_are_lowered_without_decorators_too() {
    let js = module("class A {\n  accessor x = 1;\n  static accessor y: number;\n  abstract accessor z: number;\n}\n");
    assert!(js.contains("  #x_accessor_storage = 1; get x() { return this.#x_accessor_storage; } set x(value) { this.#x_accessor_storage = value; }\n"), "{js}");
    assert!(js.contains("  static #y_accessor_storage        ; static get y() { return A.#y_accessor_storage; } static set y(value) { A.#y_accessor_storage = value; }\n"), "{js}");
    assert!(!js.contains('z'), "{js}");
    // With legacy decorators as well.
    let mut options = serde_json::Map::new();
    options.insert(
        "experimentalDecorators".to_owned(),
        serde_json::Value::Bool(true),
    );
    let legacy = zubra::typescript_to_js("class B { accessor x = 1 }", Some(&options)).unwrap();
    assert!(legacy.contains("#x_accessor_storage = 1"), "{legacy}");
}

#[test]
fn parameter_decorators_need_the_legacy_ones() {
    let source = "<script lang=\"ts\">\n  function inject(target: any) {}\n  class A { run(@inject value: number) {} }\n</script>\n<zb-x><p>x</p></zb-x>";
    let error = compile_js(source, "@zubra/runtime", "x.zb").unwrap_err();
    assert!(
        error
            .message
            .contains("a parameter decorator is one of TypeScript's legacy decorators"),
        "{}",
        error.message
    );
    assert!(error
        .help
        .as_deref()
        .unwrap_or_default()
        .contains("experimentalDecorators"));
    assert_eq!(error.span.line, 3);
}

#[test]
fn what_standard_decorators_cant_lower_is_an_error() {
    for (source, message) in [
        (
            "class A { accessor [k] = 1 }",
            "an `accessor` with a computed name",
        ),
        (
            "class A { @d declare x: number }",
            "decorators aren't valid here",
        ),
        (
            "class A { @d constructor() {} }",
            "decorators aren't valid here",
        ),
    ] {
        let error =
            zubra::typescript_to_js(&format!("declare const d: any, k: string;\n{source}"), None)
                .unwrap_err();
        assert!(
            error.message.contains(message),
            "{source}: {}",
            error.message
        );
    }
    let mut options = serde_json::Map::new();
    options.insert(
        "useDefineForClassFields".to_owned(),
        serde_json::Value::Bool(false),
    );
    let error = zubra::typescript_to_js(
        "declare const d: any, k: string;\nclass A { @d [k] = 1 }",
        Some(&options),
    )
    .unwrap_err();
    assert!(
        error.message.contains("needs `useDefineForClassFields`"),
        "{}",
        error.message
    );
}

// ---- type checking: the component as a TypeScript file ----------------------------------------

#[test]
fn the_type_checking_file_maps_every_copied_stretch_back_to_the_component() {
    let source = "<script lang=\"ts\">\n  import { state } from '@zubra/runtime'\n  const total = state(2)\n  let open = false\n</script>\n<zb-x label=\"x\">\n  <p onclick={() => (open = !open)}>{label} {total + 1}</p>\n  <zb-each items={[1, 2]} as=\"n\" index=\"i\"><b>{n * i}</b></zb-each>\n</zb-x>";
    let (code, mappings) =
        zubra::virtual_typescript_with(source, "x.zb", &|_, _| Err("none".to_owned())).unwrap();
    for (generated, original, length) in &mappings {
        let (generated, original, length) =
            (*generated as usize, *original as usize, *length as usize);
        assert_eq!(
            &code[generated..generated + length],
            &source[original..original + length]
        );
    }
    for line in [
        "declare let label: string;",
        "const __zubraScript_total = total;",
        "const total = __zubraValue(__zubraScript_total);",
        "__zubraCheck<(event: __Event<\"click\">) => unknown>((() => (open = !open)));",
        "for (const n of __zubraItems(([1, 2]))) {",
        "const i: number = 0;",
        "(n * i);",
    ] {
        assert!(code.contains(line), "{line}\n{code}");
    }
    // `open` is a `let`: the template may assign it, so it isn't shadowed.
    assert!(!code.contains("const open ="), "{code}");
    // A JavaScript component's file is there for its users' types, and isn't checked itself.
    let plain = source.replace("<script lang=\"ts\">", "<script>");
    let (code, _) =
        zubra::virtual_typescript_with(&plain, "x.zb", &|_, _| Err("none".to_owned())).unwrap();
    assert!(code.starts_with("// @ts-nocheck\n"), "{code}");
}

// ---- interface Props --------------------------------------------------------------------------

#[test]
fn interface_props_types_the_host_s_props_in_one_place() {
    let source = "<script lang=\"ts\">\n  type Size = 'small' | 'large'\n  interface Props {\n    size: Size\n    maxCount?: number\n  }\n  const twice = maxCount * 2\n</script>\n<zb-x size=\"small\" max-count={3}><p>{twice} {size}</p></zb-x>";
    let dts = compile_declarations(source, "x.zb").unwrap();
    assert!(dts.contains("  size: Size;\n"), "{dts}");
    assert!(dts.contains("  maxCount: number;\n"), "{dts}");
    let manifest = compile_manifest(source, "x.js").unwrap();
    assert!(manifest.contains("\"text\": \"Size\""), "{manifest}");
    // The type-checking file declares them with those types.
    let (code, _) =
        zubra::virtual_typescript_with(source, "x.zb", &|_, _| Err("none".to_owned())).unwrap();
    assert!(
        code.contains("declare let size: Size;\ndeclare let maxCount: number;\n"),
        "{code}"
    );
}

#[test]
fn interface_props_and_the_host_must_name_the_same_props() {
    let base = "<script lang=\"ts\">\n  interface Props {\n    size: string\n  }\n</script>\n";
    let error = compile_js(
        &format!("{base}<zb-x size=\"s\" tone=\"warm\"><p>x</p></zb-x>"),
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert_eq!(error.message, "prop `tone` isn't in `interface Props`");
    assert_eq!(error.span.line, 6);
    let error = compile_js(
        &format!(
            "{}<zb-x><p>x</p></zb-x>",
            base.replace("size: string", "size: string\n    maxCount: number")
        ),
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert!(
        error.message.starts_with("`Props` has `size`"),
        "{}",
        error.message
    );
    assert_eq!(
        error.help.as_deref(),
        Some("add `size` to the host tag, or take `size` out of `Props`")
    );
    let error = compile_js(
        &format!(
            "{}<zb-x size=\"s\"><p>x</p></zb-x>",
            base.replace("size: string", "size: string\n    maxCount: number")
        ),
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert_eq!(
        error.help.as_deref(),
        Some("add `max-count` to the host tag, or take `maxCount` out of `Props`")
    );
    assert_eq!(error.span.line, 2);
}
