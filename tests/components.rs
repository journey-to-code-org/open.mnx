//! 2.3's component ergonomics: two-way props, signal consts read like values, `declare const`
//! prop types, and hasSlot().

use zubra::{compile, compile_declarations, compile_js};

fn js(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "x.zb").unwrap_or_else(|error| panic!("{}", error.message))
}

#[test]
fn a_model_prop_is_marked_and_declares_its_change_event() {
    let source = r#"<script>
  function up() { value = value + 1 }
</script>
<zb-n value:model={2}><button onclick={up}>{value}</button></zb-n>"#;
    let out = js(source);
    assert!(out.contains("model: true"), "{out}");
    let dts = compile_declarations(source, "n.zb").unwrap();
    assert!(dts.contains("valuechange: CustomEvent<number"), "{dts}");
    // Build-time HTML renders the default as usual.
    let html = compile(source, "{}").unwrap();
    assert!(html.contains(">2</button>"), "{html}");
}

#[test]
fn signal_consts_read_like_values_in_the_template() {
    let source = r#"<script>
  import { computed, hasSlot, state as box } from '@zubra/runtime'

  const count = box(1)
  const double = computed(() => count.get() * 2)
  const hasFooter = hasSlot('footer')
  const user = box({ name: "Ada" })
</script>
<zb-s>
  <p>{count} {double} {count.get()}</p>
  <b>{user.name.toUpperCase()}</b>
  <zb-if test={hasFooter}><footer><zb-slot name="footer"></zb-slot></footer></zb-if>
</zb-s>"#;
    let out = js(source);
    assert!(
        out.contains(r#"$t($r(count)) + " " + $t($r(double)) + " " + $t((count.get()))"#),
        "{out}"
    );
    assert!(out.contains("user.get().name.toUpperCase()"), "{out}");
    assert!(!out.contains(".get().get()"), "{out}");
    assert!(out.contains("when: () => $r(hasFooter)"), "{out}");
}

#[test]
fn declare_const_types_a_prop() {
    let source = r#"<script lang="ts">
  type Size = 'small' | 'large'
  declare const size: Size
</script>
<zb-d size="small"><p>{size}</p></zb-d>"#;
    let dts = compile_declarations(source, "d.zb").unwrap();
    assert!(
        dts.contains("size: Size") || dts.contains("'small' | 'large'"),
        "{dts}"
    );
    let out = js(source);
    assert!(!out.contains("declare"), "{out}");
}

#[test]
fn declare_const_must_name_a_prop() {
    let source = r#"<script lang="ts">
  declare const sise: string
</script>
<zb-d size="small"><p>{size}</p></zb-d>"#;
    let error = compile_js(source, "@zubra/runtime", "d.zb").expect_err("an error");
    let text = format!("{} {}", error.message, error.help.unwrap_or_default());
    assert!(text.contains("sise") && text.contains("size"), "{text}");
}
