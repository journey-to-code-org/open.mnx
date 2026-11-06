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
- **Hooks**: `state`, `computed`, `effect`, `watch`, `onMount` (may return a cleanup), `onUnmount`, `id()` (unique per element and call, based on the host's own `id` when it has one), `props()`, `host()`, `emit()` (see Events), and context: `createContext(default)`, `provide(context, value)`, `inject(context)`.
- **Form controls**: `form-associated` on the host makes the element a form control on the platform's `ElementInternals`. `formValue(signal)` sets what the form submits (under the element's `name`), `validity(() => message)` takes part in validation (`''` means valid; the form won't submit otherwise, and `:invalid`/`:valid` match), and `onFormReset`, `onFormRestore` and `onFormDisabled` follow the form's lifecycle — a disabled `<fieldset>` disables the control and leaves it out of the submitted data. The element gets the native control API: `form`, `name`, `labels`, `validity`, `validationMessage`, `willValidate`, `checkValidity()`, `reportValidity()`, and the generated `.d.ts` declares it.
- **Context** follows the Web Components Community Group Context Protocol: `inject` dispatches a bubbling `context-request` event that the nearest provider answers (and keeps answering as the value changes); providers announce themselves with `context-provider`, so a consumer defined before its provider still connects. A consumer that is moved asks again, and one that is removed unsubscribes. Because it's plain DOM events, mnx components share context with other implementations such as Lit's `@lit/context`: pass the other library's key to `inject`.
- **Detached elements pause**: long-lived signals stop holding them; on return only parts whose inputs changed re-run.
- **URL attributes** get the same safety check at runtime as at build time.
- `shadow` on the host renders into a shadow root (a declarative one in the HTML output).
- **`mnx-if` and `mnx-each` are regions.** Both backends wrap them in `<!--[-->` … `<!--]-->`, and each list row in its own pair, so the runtime can find them in server markup. A region counts as one position in its parent's paths, so a list's length never shifts what comes after it. Each branch and row has its own template and parts. `mnx-if` re-renders only when the chosen branch changes. `mnx-each` updates rows in place by position: each row holds its item and index as signals, so changing one item updates only that row, and rows are added or removed at the end. Server-rendered branches and rows are hydrated without being replaced; a server list whose length doesn't match its items is re-rendered with a warning.

- **Keyed lists**: with `key={…}`, rows follow their key. Reordering moves the existing rows, with their DOM state (a half-typed input, focus), using `moveBefore()` where the browser has it; inserting or removing in the middle touches only those rows. Duplicate keys at runtime are reported and the duplicate row is left unkeyed.

- **Slots**: in light DOM (the default), the element's own children are moved into its `mnx-slot` regions at startup, by their `slot` attribute (everything else goes to the default slot); an empty slot shows its fallback, which stays live. Slotted content inside an `mnx-if` comes back when the branch does. Content for a slot that doesn't exist is reported. Slotted content stays live: frameworks that keep managing the element's children through the host (`appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `append`, `replaceChildren`, `textContent`, `innerHTML`, as React, Vue and others do) are routed to the slots, content removed through its real parent leaves its slot, changing an element's `slot` attribute moves it, and an emptied slot shows its fallback again. Reading `childNodes` on the host shows the rendered template, not the slotted content. In the HTML output a slot holding supplied content opens with `<!--[!-->` and is left as-is on hydration; a fallback is hydrated and bound. In shadow components `mnx-slot` compiles to a native `<slot>`, and supplied content goes in the host's light DOM with `slot="…"`, as declarative shadow DOM expects. A slot can't be inside `mnx-each`.

Not yet in the JavaScript output: prop defaults computed at runtime.

## Events

```html
<!--
  A star rating.
  @fires valuechange - The value changed; `detail` is the new value.
-->
<script>
  import { emit, props } from '@mnx/runtime'
  const p = props()
  function rate(stars) {
    if (!emit('beforevaluechange', stars)) return   // a listener called preventDefault()
    p.value = stars
    emit('valuechange', stars)
  }
</script>
<mnx-rating value={0}> … </mnx-rating>
```

- **Nothing is declared by hand.** Each `emit("name", detail)` call in the script declares an event; the compiler binds `emit` to each element, so handlers and timers can call it at any time. The name must be a string literal, and `emit` must be called directly (not passed around), so the compiler sees every event.
- **Names follow the platform**: lowercase letters and digits, like the DOM's own events (`valuechange`, `itemselect`), and native names where the meaning matches (`change`, `toggle`, `close`). `valueChange` or `value-change` is an error that suggests `valuechange`. Every framework can listen to these names declaratively.
- **Events are `CustomEvent`s** dispatched from the host, with the value in `detail`. They bubble; shadow components' events are also `composed`, so they leave the shadow root. `before…` events are cancelable, and `emit` returns `false` when a listener called `preventDefault()`.
- **A component's events are its own**: an inner element's event with the same name (a native `change` from an inner `<input>`, a nested component's `valuechange`) stops at the host, so listeners outside — including on the host itself — see only the component's, as with built-in elements. Capture-phase listeners above the host still see inner events.
- **Parents listen** with `on<name>={handler}`. On an imported component, a listener for a near miss of one of its events (`onvaluchange`) is a compile error with a suggestion.
- **Tools**: the manifest lists each event with its `CustomEvent<…>` type, and the `.d.ts` has an `…EventMap` with typed `addEventListener`/`removeEventListener` overloads. Detail types come from the values passed (`emit('select', { id: 1 })` → `CustomEvent<{ id: number }>`; a variable is `unknown` for now).
- **`@fires name - text`** lines in the description document events (the manifest and `.d.ts` use the text). When there are any, they must match the events the code fires exactly: a documented event that's never emitted, or an emitted one that isn't documented, is an error.
- **`props()`** returns the component's reactive props (reading one tracks it, writing one updates the element), and **`host()`** the element itself, for scripts and custom hooks.

## Components using components

```html
<script>
  import './badge.mnx'
</script>
<mnx-inbox items={[]}>
  <mnx-each items={items} as="item" key={item.name}>
    <mnx-badge label={item.name} info={{ color: item.unread > 0 ? "red" : "gray" }}>
      <em slot="icon">{item.unread}</em>new mail
    </mnx-badge>
  </mnx-each>
</mnx-inbox>
```

- **Importing a `.mnx` file** makes its tag a known child. The compiler loads it (and what it imports) relative to the importing file; cycles, a component imported twice, and a component importing itself are errors. Imports only work when compiling from a file (the CLI, or a bundler plugin that supplies a loader).
- **Props are checked at the call site**: each attribute must be one of the child's props (or a global, `data-`/`aria-` or event attribute), with a "did you mean" for typos; its value must have the type of the child's default; required props must be given. Errors point at the parent's attribute, and errors inside the child name the child's file.
- **HTML output** renders the child inline: its host attributes, its template (a declarative shadow root for shadow children) and the parent's content in the child's slots, as server markup both components can hydrate.
- **JavaScript output** imports the child's module (`./badge.mnx` → `./badge.js`; a bundler plugin keeps the specifier) and passes props as properties, so objects and arrays arrive as values, not JSON. The parent's content stays bound to the parent's state; when hydrating, the runtime finds it inside the child's slot regions.
- **Other libraries' custom elements** get an attribute until the element is defined with a matching property, then the property (React 19's rule), so `config={{ … }}` reaches a Lit or Stencil element as an object.
- **The host is the root**: a template can have any number of top-level nodes (text, elements, regions); there is no single-root rule.

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
