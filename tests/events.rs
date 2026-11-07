//! Events inferred from `emit("name", detail)` in a component's script.

use std::collections::HashMap;

use mnx_compiler::{
    compile_declarations, compile_html_with, compile_js, compile_manifest, Diagnostic,
};

fn with_script(script: &str) -> String {
    format!("<script>\n  import {{ emit }} from '@mnx/runtime'\n{script}\n</script>\n<mnx-picker value=\"\">\n  <p>{{value}}</p>\n</mnx-picker>")
}

fn js(source: &str) -> Result<String, Diagnostic> {
    compile_js(source, "@mnx/runtime", "picker.mnx")
}

#[test]
fn every_emit_call_declares_an_event_and_binds_emit_per_element() {
    let output = js(&with_script(
        "  function pick(v) { emit('valuechange', v) }\n  function open() { emit(`open`); emit('valuechange', 1) }",
    ))
    .unwrap();
    assert!(
        output.contains("events: [\"valuechange\", \"open\"],"),
        "{output}"
    );
    assert!(
        output.contains("setup($p, $emit) {\n    const emit = $emit;\n"),
        "{output}"
    );
}

#[test]
fn an_aliased_import_is_bound_under_its_alias() {
    let source = "<script>\n  import { emit as fire } from '@mnx/runtime'\n  const go = () => fire('go')\n</script>\n<mnx-x><p>x</p></mnx-x>";
    let output = js(source).unwrap();
    assert!(output.contains("const fire = $emit;"), "{output}");
    assert!(output.contains("events: [\"go\"]"), "{output}");
}

#[test]
fn emit_from_another_module_is_not_the_runtimes() {
    let source = "<script>\n  import { emit } from './bus.js'\n  emit('ready')\n</script>\n<mnx-x><p>x</p></mnx-x>";
    let output = js(source).unwrap();
    assert!(output.contains("events: [],"), "{output}");
    assert!(!output.contains("$emit;"), "{output}");
}

#[test]
fn detail_types_come_from_the_values_passed() {
    let source = with_script(
        "  emit('a', 'text')\n  emit('b', 1 + 2)\n  emit('c', { id: 1, tags: ['x'], ok: !0, label: `l` })\n  emit('d', 1 > 2 ? 'yes' : 0)\n  emit('d', true)\n  emit('e', thing)\n  emit('e', 'x')\n  emit('f')\n  emit('g', [1, 'a'])",
    );
    let declarations = compile_declarations(&source, "picker.mnx").unwrap();
    for expected in [
        "  a: CustomEvent<string>;",
        "  b: CustomEvent<number>;",
        "  c: CustomEvent<{ id: number; tags: string[]; ok: boolean; label: string }>;",
        "  d: CustomEvent<string | number | boolean>;",
        "  e: CustomEvent<unknown>;",
        "  f: CustomEvent<null>;",
        "  g: CustomEvent<(number | string)[]>;",
    ] {
        assert!(
            declarations.contains(expected),
            "missing {expected:?} in\n{declarations}"
        );
    }
    assert!(
        declarations.contains("export interface MnxPickerEventMap extends HTMLElementEventMap {")
    );
    assert!(declarations.contains(
        "  addEventListener<K extends keyof MnxPickerEventMap>(type: K, listener: (this: MnxPicker, event: MnxPickerEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;"
    ));
    assert!(declarations.contains("  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;"));
}

#[test]
fn a_component_without_events_declares_no_event_map() {
    let declarations = compile_declarations("<mnx-x><p>x</p></mnx-x>", "x.mnx").unwrap();
    assert!(!declarations.contains("EventMap"), "{declarations}");
    assert!(!declarations.contains("addEventListener"), "{declarations}");
}

#[test]
fn event_names_follow_the_platform_convention() {
    let error = js(&with_script("  emit('valueChange', 1)")).unwrap_err();
    assert!(error.message.contains("lowercase"), "{}", error.message);
    assert_eq!(error.help.as_deref(), Some("use `valuechange`"));
    assert_eq!(error.span.line, 3);
    assert_eq!(
        js(&with_script("  emit('item-select')"))
            .unwrap_err()
            .help
            .as_deref(),
        Some("use `itemselect`")
    );
    assert!(js(&with_script("  emit('1x')")).unwrap_err().help.is_none());
}

#[test]
fn the_compiler_must_see_every_event() {
    let error = js(&with_script("  const name = 'x'\n  emit(name)")).unwrap_err();
    assert!(
        error.message.contains("string literal"),
        "{}",
        error.message
    );
    assert_eq!(error.span.line, 4);
    let error = js(&with_script("  const fire = emit")).unwrap_err();
    assert!(error.message.contains("directly"), "{}", error.message);
    assert!(js(&with_script("  emit(`a${1}`)"))
        .unwrap_err()
        .message
        .contains("string literal"));
    assert!(js(&with_script("  emit('a', 1, 2)"))
        .unwrap_err()
        .message
        .contains("one detail"));
}

const DOCUMENTED: &str = "<!--\n  A picker.\n  @fires valuechange - The value changed.\n-->\n<script>\n  import { emit } from '@mnx/runtime'\n  const pick = (v) => emit('valuechange', v)\n</script>\n<mnx-picker><p>x</p></mnx-picker>";

#[test]
fn fires_tags_describe_events_in_the_manifest() {
    let manifest: serde_json::Value =
        serde_json::from_str(&compile_manifest(DOCUMENTED, "picker.js").unwrap()).unwrap();
    let declaration = &manifest["modules"][0]["declarations"][0];
    assert_eq!(declaration["description"], "A picker.");
    assert_eq!(
        declaration["events"],
        serde_json::json!([{ "name": "valuechange", "type": { "text": "CustomEvent<unknown>" }, "description": "The value changed." }])
    );
    let declarations = compile_declarations(DOCUMENTED, "picker.mnx").unwrap();
    assert!(
        declarations.contains("/**\n * A picker.\n */\n"),
        "{declarations}"
    );
    assert!(
        declarations.contains("  /** The value changed. */\n  valuechange: CustomEvent<unknown>;"),
        "{declarations}"
    );
}

#[test]
fn fires_tags_must_match_the_events_the_code_fires() {
    let typo = DOCUMENTED.replace("@fires valuechange", "@fires valuchange");
    let error = js(&typo).unwrap_err();
    assert!(
        error.message.contains("never emits `valuchange`"),
        "{}",
        error.message
    );
    assert_eq!(error.help.as_deref(), Some("did you mean `valuechange`?"));

    let undocumented = DOCUMENTED.replace(
        "emit('valuechange', v)",
        "emit('valuechange', v); emit('open')",
    );
    let error = js(&undocumented).unwrap_err();
    assert!(
        error
            .message
            .contains("`open` is emitted but not documented"),
        "{}",
        error.message
    );
    assert_eq!(error.span.line, 7, "at the emit call");

    // Without any @fires, nothing needs documenting.
    let plain = "<!-- Described, but no @fires. -->\n<script>\n  import { emit } from '@mnx/runtime'\n  emit('open')\n</script>\n<mnx-x><p>x</p></mnx-x>";
    assert!(js(plain).is_ok());
}

#[test]
fn a_listener_for_a_near_miss_of_a_childs_event_is_a_typo() {
    let child = "<script>\n  import { emit } from '@mnx/runtime'\n  emit('valuechange', 1)\n  emit('changes')\n</script>\n<mnx-picker><p>x</p></mnx-picker>";
    let files: HashMap<&str, &str> = HashMap::from([("./picker.mnx", child)]);
    let loader = |specifier: &str, _: &str| {
        files
            .get(specifier)
            .map(|source| ("picker.mnx".to_owned(), (*source).to_owned()))
            .ok_or_else(|| "not found".to_owned())
    };
    let parent = |listener: &str| {
        format!("<script>\n  import './picker.mnx'\n  function on() {{}}\n</script>\n<mnx-form><mnx-picker {listener}={{on}}></mnx-picker></mnx-form>")
    };
    let compile = |source: &str| compile_html_with(source, "form.mnx", "{}", "{}", &loader);
    let error = compile(&parent("onvaluchange")).unwrap_err();
    assert!(
        error
            .message
            .contains("<mnx-picker> never fires `valuchange`"),
        "{}",
        error.message
    );
    assert_eq!(error.help.as_deref(), Some("did you mean `valuechange`?"));
    assert_eq!(error.span.line, 5);
    for fine in ["onvaluechange", "onchange", "onclick", "onsomethingelse"] {
        assert!(compile(&parent(fine)).is_ok(), "{fine}");
    }
}

#[test]
fn framework_declarations_type_the_wrappers() {
    use mnx_compiler::{compile_declarations_for, Framework};
    let source = "<script>\n  import { emit } from '@mnx/runtime'\n  emit('beforevaluechange', 1)\n  emit('valuechange', 1)\n  emit('open')\n</script>\n<mnx-picker value={0} label=\"\"><p>x</p></mnx-picker>";
    let react = compile_declarations_for(source, "picker.mnx", Framework::React).unwrap();
    assert!(react.starts_with("// Generated by mnx from picker.mnx. Do not edit.\n\nimport type * as React from \"react\";"), "{react}");
    for expected in [
        "  onBeforeValueChange?: (event: MnxPickerEventMap[\"beforevaluechange\"]) => void;",
        "  onValueChange?: (event: MnxPickerEventMap[\"valuechange\"]) => void;",
        "  onOpen?: (event: MnxPickerEventMap[\"open\"]) => void;",
        "export interface MnxPickerReactProps extends Omit<React.HTMLAttributes<MnxPicker>, \"value\" | \"label\" | \"onBeforeValueChange\" | \"onValueChange\" | \"onOpen\"> {",
        "export default MnxPickerReact;",
    ] {
        assert!(react.contains(expected), "missing {expected:?} in\n{react}");
    }
    let vue = compile_declarations_for(source, "picker.mnx", Framework::Vue).unwrap();
    assert!(
        vue.contains("DefineComponent<{ value?: number; label?: string; modelValue?: number }"),
        "{vue}"
    );
    assert!(vue.contains("\"update:value\": (value: number) => true; \"update:modelValue\": (value: number) => true }>;"), "{vue}");
    let plain = compile_declarations_for(source, "picker.mnx", Framework::None).unwrap();
    assert!(plain.contains("export default MnxPicker;\n"), "{plain}");
}
