# The `.zb` format as a declarative custom elements explainer

*Zubra 5.0.3, November 2026. Input for the declarative custom elements discussions in the Web Components Community Group ([w3c/webcomponents-cg#32](https://github.com/w3c/webcomponents-cg/issues/32)). There is no settled proposal. This describes a format that is in use, and why each choice was made, as evidence for one.*

## The shape

```html
<!-- A two-star rating. -->
<script>
  import { emit, props } from '@zubra/runtime'
  const p = props()
  function rate(stars) {
    p.value = stars
    emit('valuechange', stars)
  }
</script>
<style>
  button { font: inherit }
</style>
<zb-rating value={0}>
  <button type="button" onclick={() => rate(1)}>1</button>
  <button type="button" onclick={() => rate(2)}>2</button>
  <output>{value}</output>
</zb-rating>
```

1. **The host tag declares the element.** Its name is the custom element, and its attributes are the props: `value={0}` is a prop with a default, `label="Hi"` a string default, a bare `name` a required prop. `shadow` opts into shadow DOM and `form-associated` makes it a form control. What a declarative custom element needs (name, observed attributes, defaults, shadow mode, form association) sits where an HTML author would look.
2. **Light DOM is the default.** Styles scope with native `@scope (zb-rating) to ([data-zb-slotted="zb-rating"])`, which stops at content callers put in slots, so light-DOM components get most of shadow DOM's style encapsulation without its costs. `<zb-slot>` projects in light DOM, and in shadow components it compiles to a native `<slot>`.
3. **`{expr}` bindings, evaluated statically when possible.** A deterministic subset (literals, operators, member access, template literals, arrow functions and pure built-ins such as `.map` and `.toFixed`) renders on the server. Anything else is JavaScript that runs in the browser. Partial server rendering leaves those parts as `<?zb [??>` regions.
4. **Directives as elements.** `<zb-if>`, `<zb-each key>`, `<zb-slot>` and `<zb-await>` are template syntax a parser already understands, unlike `{#if}` blocks.
5. **Events are inferred from `emit('name', detail)`** and named like the platform's events: lowercase with no separators (`valuechange`), `beforeX` cancelable. Two-way binding follows from naming: `value` plus `valuechange` is a model pair that each framework adapter maps to its own idiom.
6. **One script, run once per element.** There's no re-rendering and no hook rules. Reactivity is the TC39 Signals API.

## What implementing it taught us

- **Server rendering decides the design.** Every choice above lets the HTML be produced without running component code, and hydrated without re-rendering. A declarative custom element proposal that only covers client-side definition misses the main benefit.
- **Interop is in properties and events.** Objects go in as properties, never attributes, and events are plain DOM events. With that, React 19, Vue, Svelte, Solid, Lit, Angular and plain HTML use the element with no glue (Zubra tests each in CI). A declarative format should define its properties-versus-attributes rule.
- **Light-DOM slots are a real need.** Many authors want page CSS to apply. Making light-DOM projection live under frameworks that manage the host's children took the most work in the runtime. A platform-level light-DOM slot would remove it.
- **JSX can lower into it.** Zubra's JSX front end (`.zb.jsx`) is a source-to-source lowering into this format, which suggests the HTML form is expressive enough to be the common target.

## Reproducing

The format reference is the main README of [zubra](https://github.com/journey-to-code-org/zubra). The compiler's test suites (`cargo test`) and the browser suites (`runtime/`, `plugin/`) exercise every feature above.
