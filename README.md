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
- **Directives**: `<mnx-if test={…}>` with an optional final `<mnx-else>`; `<mnx-each items={list} as="item" index="i" key={item.id}>` over any array (`key` is optional; keys must be strings or numbers and unique, checked at build time); `<mnx-slot name="…">` with fallback content. In the HTML output, directives are expanded at build time.
- **Safety**: dynamic values are escaped. URL attributes (`href`, `src`, …) must be relative or use `http`, `https`, `mailto` or `tel`; literal URLs are checked everywhere, computed URLs on their final value. Boolean attributes take `{true}`/`{false}`. Inline `on…` handlers, `style` attributes, and `<script>`/`<style>` inside templates are rejected; dynamic `srcset` and `srcdoc` are not supported.
- **Host attributes**: props that differ from their defaults are written onto the host (`JSON` for arrays and objects), so the v0.4 runtime can hydrate from the markup.
- **Errors** point at the source line, with a caret and a suggestion where there is one.

v0.2 syntax (the `component:`/`prop`/`---` header, `{{ name }}`, `mnix-*` directives) is rejected with a migration hint.

## v0.4 (in progress): JavaScript output

`mnix compile header.mnx --emit js` writes a module that defines the custom element on `@mnx/runtime`:

```js
export default define(tag, {
  props: { "title": { attribute: "title", default: "Mikey Nichols", required: false }, … },
  template: "\n  <header>\n    <nav>\n      <h1></h1>…",
  setup($p) {
    /* the component's <script>, run once per element */
    return [
      { path: [0, 0, 0], text: () => $t($p.title) },
      …
    ];
  },
});
```

- **Props** are properties backed by signals; attributes are parsed by the default's type (JSON for arrays and objects). A property set before the element is defined is kept.
- **Hydration**: if the element already contains the server's markup, the runtime finds each part by its path and binds to the existing DOM. Nothing is re-rendered, and a part writes only when its value differs. Markup that doesn't match the template is replaced, with a warning.
- **Paths count elements and comments only**, because browsers merge and drop text nodes. Dynamic text that is an element's only child is bound through the element; dynamic text beside other nodes follows an empty `<!---->` anchor, which both backends emit.
- **Script**: imports move to the top of the module; the rest runs once per element. `const count = state(0)` plus `{count}` in the template is reactive, and `onclick={increment}` calls a script function (handlers are read when the event fires, and are left out of static HTML).
- **Hooks**: `state`, `computed`, `effect`, `watch`, `onMount` (may return a cleanup), `onUnmount`, `id()` (unique per element and call, based on the host's own `id` when it has one), and context: `createContext(default)`, `provide(context, value)`, `inject(context)`.
- **Context** follows the Web Components Community Group Context Protocol: `inject` dispatches a bubbling `context-request` event that the nearest provider answers (and keeps answering as the value changes); providers announce themselves with `context-provider`, so a consumer defined before its provider still connects. A consumer that is moved asks again, and one that is removed unsubscribes. Because it's plain DOM events, mnx components share context with other implementations such as Lit's `@lit/context`: pass the other library's key to `inject`.
- **Detached elements pause**: long-lived signals stop holding them; on return only parts whose inputs changed re-run.
- **URL attributes** get the same safety check at runtime as at build time.
- `shadow` on the host renders into a shadow root (a declarative one in the HTML output).
- **`mnx-if` and `mnx-each` are regions.** Both backends wrap them in `<!--[-->` … `<!--]-->`, and each list row in its own pair, so the runtime can find them in server markup. A region counts as one position in its parent's paths, so a list's length never shifts what comes after it. Each branch and row has its own template and parts. `mnx-if` re-renders only when the chosen branch changes. `mnx-each` updates rows in place by position: each row holds its item and index as signals, so changing one item updates only that row, and rows are added or removed at the end. Server-rendered branches and rows are hydrated without being replaced; a server list whose length doesn't match its items is re-rendered with a warning.

- **Keyed lists**: with `key={…}`, rows follow their key. Reordering moves the existing rows, with their DOM state (a half-typed input, focus), using `moveBefore()` where the browser has it; inserting or removing in the middle touches only those rows. Duplicate keys at runtime are reported and the duplicate row is left unkeyed.

- **Slots**: in light DOM (the default), the element's own children are moved into its `mnx-slot` regions at startup, by their `slot` attribute (everything else goes to the default slot); an empty slot shows its fallback, which stays live. Slotted content inside an `mnx-if` comes back when the branch does. Content for a slot that doesn't exist is reported. In the HTML output a slot holding supplied content opens with `<!--[!-->` and is left as-is on hydration; a fallback is hydrated and bound. In shadow components `mnx-slot` compiles to a native `<slot>`, and supplied content goes in the host's light DOM with `slot="…"`, as declarative shadow DOM expects. A slot can't be inside `mnx-each`.

Not yet in the JavaScript output: prop defaults computed at runtime, and slot content added to the element after it starts (it is projected once).

## Describing components to tools

- `--emit manifest` writes a [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest) (`custom-elements.json`, schema 2.1.0): the tag, each prop as an attribute and a field with its type and default, slots (the default slot is `""`), and a description taken from an HTML comment above the host tag (or above the `<script>`). Editors, Storybook and documentation tools read this format. `--module-path` sets the module path it records (default: the source name with `.js`).
- `--emit dts` writes TypeScript declarations for the JavaScript output: the element class with typed properties, a `…Props` interface (props with defaults are optional), the `tag` constant, and an `HTMLElementTagNameMap` entry so `document.querySelector("mnx-header")` is typed.
- Types are inferred from defaults: `{ sample: "…" }` becomes `{ sample: string }`, `["a"]` becomes `string[]`, and a required prop with no default is `unknown`.

Both are checked by `npm run test:tools` in `runtime/`: the manifest against the official JSON schema, and the declarations with the TypeScript compiler on code that should type-check and code that should not.

## Commands

Install Rust 1.97 or newer (required by the oxc JavaScript parser). The runtime needs Node 20 or newer.

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo run --locked -- compile examples/header.mnx
cargo run --locked -- compile examples/header.mnx --emit js
cargo run --locked -- compile examples/greeting.mnx --props examples/greeting.props.json
cargo run --locked -- compile examples/feature-list.mnx --props examples/feature-list.props.json --slots examples/feature-list.slots.json
(cd runtime && npm install && npm test)
(cd runtime && npm run test:browser)   # needs Playwright with Chromium
(cd runtime && npm run test:tools)     # manifest schema + TypeScript checks
```

`--props` is optional: defaults come from the component itself. `--emit js` writes the element module instead of HTML, `--emit dts` its TypeScript declarations, and `--emit manifest` its Custom Elements Manifest; `--runtime <module>` changes the import it uses (default `@mnx/runtime`). The compiler writes HTML to stdout by default. `--output <file>` writes to a file using atomic promotion. For example, append `--output target/greeting.html` to the final command to save the generated fragment.

## Release direction

- `0.1.0`: static parser, typed props, validated IR, escaping, diagnostics, CLI, tests.
- `0.2.0`: compile-time conditions, loops, and default/named slots.
- `0.3.0`: single-file components with `<script>`, host-tag props and `{expr}`; the Signals-based runtime core (in progress).
- `0.4.0`: JavaScript output: a light-DOM custom element on the runtime, hydrating server markup by template parts; manifest and type generation.
- `0.5.0`: state, events (inferred from callback props and `emit`), JSX components, React and Vue adapters, bundler plugin.
- `0.6.0`: Angular, Svelte and Solid; SSR inside meta-frameworks; wasm build; scoped styles.

This repository owns the compiler (parser, resolver, IR, renderer, CLI) and the runtime.
