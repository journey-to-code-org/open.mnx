# mnx

mnx is an experimental compiler for Web Components. You write a component as HTML with `{expr}` bindings; the compiler emits semantic HTML today, and a small custom-element module built on platform-shaped primitives (the TC39 Signals API, template parts) from v0.4. The compiler is native build tooling written in Rust; `runtime/` is the browser side.

The long-term aim is for the web platform to absorb what mnx proves, so the runtime shrinks as native features ship. See `runtime/README.md` for the Signals implementation and how it is tested against the proposal's reference polyfill.

## v0.3: single-file components

```html
<script>
  const title = "Mikey Nichols"
  const data = { sample: "sample data", sampleTwo: "additional data" }
</script>
<mnx-header title={title} data={data}>
  <header>
    <nav>
      <h1>{title}</h1>
      <menu>
        <li>{data.sample}</li>
        <li>{data.sampleTwo}</li>
      </menu>
    </nav>
  </header>
</mnx-header>
```

- **The host tag declares the component.** Its name is the custom element; its attributes are the props. `title={title}` declares a prop whose default comes from the script, `label="Hi"` a string default, and a bare `name` a required prop. Kebab-case attributes become camelCase props (`max-value` → `maxValue`). `shadow` opts into shadow DOM (light DOM is the default).
- **`<script>` is real JavaScript** (parsed with oxc). Top-level `const`/`let` initializers written in the expression language are evaluated at build time. Functions, imports and anything else are kept for the runtime; referring to them in static HTML is a compile error that says so.
- **`{expr}`** works in text, in quoted attributes (`class="card {kind}"`, always a string) and as a whole attribute value (`data={value}`, any type). The expression language is a JavaScript subset: literals, arrays and objects, member and index access (with `?.`), `!` `-` `+` `-` `*` `/` `%`, comparisons, `==`/`!=` (strict), `&&` `||` `??` and `? :`, with JavaScript's truthiness. Calls, assignment, `new` and `this` are rejected with a reason.
- **Inside the template, names resolve** to loop variables, then props, then script bindings. Every reference is checked in every branch, including branches this build won't render, and unknown names get a "did you mean" suggestion.
- **Directives**: `<mnx-if test={…}>` with an optional final `<mnx-else>`; `<mnx-each items={list} as="item" index="i">` over any array; `<mnx-slot name="…">` with fallback content. Directives are expanded at build time and never emitted.
- **Safety**: dynamic values are escaped. URL attributes (`href`, `src`, …) must be relative or use `http`, `https`, `mailto` or `tel`; literal URLs are checked everywhere, computed URLs on their final value. Boolean attributes take `{true}`/`{false}`. Inline `on…` handlers, `style` attributes, and `<script>`/`<style>` inside templates are rejected; dynamic `srcset` and `srcdoc` are not supported.
- **Host attributes**: props that differ from their defaults are written onto the host (`JSON` for arrays and objects), so the v0.4 runtime can hydrate from the markup.
- **Errors** point at the source line, with a caret and a suggestion where there is one.

v0.2 syntax (the `component:`/`prop`/`---` header, `{{ name }}`, `mnix-*` directives) is rejected with a migration hint.

## Commands

Install Rust 1.97 or newer (required by the oxc JavaScript parser). The runtime needs Node 20 or newer.

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo run --locked -- compile examples/header.mnx
cargo run --locked -- compile examples/greeting.mnx --props examples/greeting.props.json
cargo run --locked -- compile examples/feature-list.mnx --props examples/feature-list.props.json --slots examples/feature-list.slots.json
(cd runtime && npm install && npm test)
```

`--props` is optional: defaults come from the component itself. The compiler writes HTML to stdout by default. `--output <file>` writes to a file using atomic promotion. For example, append `--output target/greeting.html` to the final command to save the generated fragment.

## Release direction

- `0.1.0`: static parser, typed props, validated IR, escaping, diagnostics, CLI, tests.
- `0.2.0`: compile-time conditions, loops, and default/named slots.
- `0.3.0`: single-file components with `<script>`, host-tag props and `{expr}`; the Signals-based runtime core (in progress).
- `0.4.0`: JavaScript output: a light-DOM custom element on the runtime, hydrating server markup by template parts; manifest and type generation.
- `0.5.0`: state, events (inferred from callback props and `emit`), JSX components, React and Vue adapters, bundler plugin.
- `0.6.0`: Angular, Svelte and Solid; SSR inside meta-frameworks; wasm build; scoped styles.

This repository owns the compiler (parser, resolver, IR, renderer, CLI) and the runtime.
