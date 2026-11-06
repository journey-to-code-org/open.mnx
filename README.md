# mnx

mnx is a compiler for Web Components. You write a component as HTML with `{expr}` bindings and a `<script>`. mnx turns it into server-rendered HTML and a small custom element that hydrates that HTML. React, Vue and any other framework can then use the element without integration code.

The runtime is built on what the web platform is standardizing: the TC39 Signals API, template parts in the shape of DOM Parts, the Context Protocol, form-associated custom elements and declarative shadow DOM. The aim is for the platform to absorb what mnx proves, so the runtime shrinks as native features ship. See `runtime/README.md`.

**Status: 1.0.** The `.mnx` format, the CLI and the runtime's public API are stable: no breaking changes before 2.0. See `CHANGELOG.md`, and `docs/migrating-from-0.2.md` for components written for 0.2.

```html
<!-- header.mnx -->
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

```sh
mnix compile header.mnx                # server-rendered HTML
mnix compile header.mnx --emit js      # the custom element
```

```tsx
// In a Vite app with @mnx/unplugin: a React component in .tsx files, a Vue component in .vue files.
import Header from './header.mnx';
<Header title="Journey to Code" data={{ sample: "a", sampleTwo: "b" }} />
```

## Writing a component

- **The host tag declares the component.** Its name is the custom element. Its attributes are the props: `title={title}` declares a prop whose default comes from the script, `label="Hi"` a string default, and a bare `name` a required prop. Kebab-case attributes become camelCase props (`max-value` → `maxValue`). The default's type is the prop's type. `shadow` opts into shadow DOM (light DOM is the default) and `form-associated` makes the element a form control. A comment above the component becomes its description in the generated docs and types.
- **The host is the root**: the template can have any number of top-level nodes.
- **`<script>` is real JavaScript** (parsed with oxc). Top-level `const`/`let` initializers written in the expression language are evaluated at build time for the HTML output. Functions, imports and everything else run in the browser, once per element. Using a runtime-only value in static HTML is a compile error that says so.
- **`{expr}`** works in text, in quoted attributes (`class="card {kind}"`, always a string) and as a whole attribute value (`data={value}`, any type). The expression language is a JavaScript subset: literals, arrays and objects, member and index access (with `?.`), `!` `-` `+` `*` `/` `%`, comparisons, `==`/`!=` (strict), `&&` `||` `??` and `? :`, with JavaScript's truthiness. Calls, assignment, `new` and `this` are rejected with a reason. Signals read in the template (`{count}`) are reactive.
- **Names resolve** to loop variables, then props, then script bindings. Every reference is checked in every branch, including branches a build won't render, and unknown names get a "did you mean" suggestion. Errors point at the source line with a caret.
- **Events from the template**: `onclick={increment}` calls a script function, read when the event fires.
- **Warnings** flag props that shadow built-in element properties (a `hidden` prop also hides the element; `title` also shows a tooltip).

## Directives

- `<mnx-if test={…}>`, with an optional final `<mnx-else>`.
- `<mnx-each items={list} as="item" index="i" key={item.id}>` over any array. `key` is optional; keys must be strings or numbers and unique (checked at build time for known values, and reported at runtime).
- `<mnx-slot name="…">` with fallback content; without `name`, the default slot.

In the HTML output, directives are expanded at build time and wrapped in `<!--[-->` … `<!--]-->` markers (each list row in its own pair), so the element can find them when it hydrates. In the browser:

- `mnx-if` re-renders only when the chosen branch changes.
- `mnx-each` without a key updates rows in place by position. Each row holds its item and index as signals, so changing one item updates only that row. Rows are added and removed at the end.
- With `key`, rows follow their key. Reordering moves the existing rows with their DOM state (a half-typed input, focus), using `moveBefore()` where the browser has it. Inserting or removing in the middle touches only those rows.

## Script, state and hooks

```html
<script>
  import { state, computed, onMount } from '@mnx/runtime'
  const count = state(0)
  const doubled = computed(() => count.get() * 2)
  function increment() { count.set(count.get() + 1) }
  onMount(() => console.log('connected'))
</script>
<mnx-counter label="Clicks">
  <button type="button" onclick={increment}>{label}: {count} ({doubled})</button>
</mnx-counter>
```

Hooks are plain functions called while the script runs (once per element; nothing re-renders, so there are no hook rules beyond that):

| Hook | |
|---|---|
| `state(value)`, `computed(fn)` | Signals (`Signal.State`, `Signal.Computed`) |
| `effect(fn)`, `watch(source, (next, prev) => …)` | Run on change; `effect` may return a cleanup |
| `onMount(fn)`, `onUnmount(fn)` | Connected / disconnected; `onMount` may return a cleanup |
| `props()` | The element's props: reading one tracks it, writing one updates the element |
| `host()` | The element |
| `emit(name, detail)` | Fire an event (see Events) |
| `id()` | An id unique to this element and call, for `id`/`for`/`aria-*` |
| `createContext`, `provide`, `inject` | Context (see below) |
| `formValue`, `validity`, `onFormReset`, `onFormRestore`, `onFormDisabled` | Form controls (see below) |

Custom hooks are plain functions that call these. A detached element pauses: long-lived signals stop holding it, and on return only the parts whose inputs changed re-run.

## Slots

- **Light DOM** (the default): the element's children are placed in its `mnx-slot` regions by their `slot` attribute; everything else goes to the default slot. An empty slot shows its fallback, which stays live. Slotted content in an `mnx-if` branch comes back when the branch does. Content for a slot that doesn't exist is reported.
- **Slotted content stays live.** Frameworks keep managing an element's children through the host (`appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `append`, `replaceChildren`, `textContent`, `innerHTML`, as React and Vue do), and those calls are routed to the slots. Content removed through its real parent leaves its slot, changing an element's `slot` attribute moves it, and an emptied slot shows its fallback again. Reading `childNodes` on the host shows the rendered template.
- **Shadow DOM** (`shadow`): `mnx-slot` compiles to a native `<slot>`, and supplied content is light DOM with `slot="…"`, as declarative shadow DOM expects.
- A slot can't be inside `mnx-each`.

## Events

```html
<!--
  A star rating.
  @fires beforevaluechange - Cancelable: preventDefault() keeps the current value.
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

- **Nothing is declared by hand.** Each `emit("name", detail)` call declares an event. The compiler binds `emit` to each element, so handlers and timers can call it at any time. The name must be a string literal, and `emit` must be called directly (not passed around), so the compiler sees every event.
- **Names follow the platform**: lowercase letters and digits, like the DOM's own events (`valuechange`, `itemselect`), and native names where the meaning matches (`change`, `toggle`, `close`). `valueChange` or `value-change` is an error that suggests `valuechange`. Every framework can listen for these names declaratively.
- **Events are `CustomEvent`s** dispatched from the host, with the value in `detail`. They bubble, and shadow components' events are also `composed`. `before…` events are cancelable, and `emit` returns `false` when a listener called `preventDefault()`.
- **A component's events are its own**: an inner element's event with the same name (a native `change` from an inner `<input>`, a nested component's `valuechange`) stops at the host. Listeners outside, including on the host itself, see only the component's own event, as with built-in elements. Capture-phase listeners above the host still see inner events.
- **Two-way binding comes from naming**: a `<prop>` + `<prop>change` pair (`value` + `valuechange`) is what the Vue adapter's `v-model` and React's controlled pattern bind to.
- **Parents listen** with `on<name>={handler}`. On an imported component, a listener for a near miss of one of its events (`onvaluchange`) is a compile error with a suggestion.
- **`@fires name - text`** lines in the description document events. When there are any, they must match the emitted events exactly.
- Detail types come from the values passed (`emit('select', { id: 1 })` → `CustomEvent<{ id: number }>`; a variable is `unknown`).

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

- **Importing a `.mnx` file** makes its tag a known child, loaded relative to the importing file. Cycles, a component imported twice, and a component importing itself are errors.
- **Props are checked at the call site.** Each attribute must be one of the child's props (or a global, `data-`/`aria-` or event attribute), with a "did you mean" for typos. Its value must have the type of the child's default, and required props must be given. Errors inside the child name the child's file.
- **HTML output** renders the child inline (a declarative shadow root for shadow children), with the parent's content in the child's slots, as markup both components hydrate.
- **JavaScript output** imports the child's module and passes props as properties, so objects and arrays arrive as values. The parent's content stays bound to the parent's state.
- **Other libraries' custom elements** get an attribute until the element is defined with a matching property, then the property (React 19's rule). So `config={{ … }}` reaches a Lit or Stencil element as an object.

## Forms

`form-associated` on the host makes the element a form control on the platform's `ElementInternals`:

- `formValue(signal)` sets what the form submits, under the element's `name`.
- `validity(() => message)` takes part in validation. `''` means valid; otherwise the form won't submit, and `:invalid`/`:valid` match.
- `onFormReset`, `onFormRestore` and `onFormDisabled` follow the form's lifecycle. A disabled `<fieldset>` disables the control and leaves it out of the submitted data.

The element gets the native control API (`form`, `name`, `labels`, `validity`, `validationMessage`, `willValidate`, `checkValidity()`, `reportValidity()`), and its typings declare it.

## Context

`createContext(default)`, `provide(context, value)` and `inject(context)` follow the Web Components Community Group [Context Protocol](https://github.com/webcomponents-cg/community-protocols/blob/main/proposals/context.md). `inject` returns a signal that follows the nearest provider above the element. A consumer defined before its provider still connects; one that's moved asks again; one that's removed unsubscribes. Because the protocol is plain DOM events, mnx components share context with other implementations such as Lit's `@lit/context`.

## Server rendering and hydration

The HTML output is the server rendering: static, deterministic, escaped markup. Props that differ from their defaults are written onto the host (JSON for arrays and objects). When the element starts in the browser, it first checks that the markup has its template's shape. If it does, it binds to the existing DOM: nothing is re-rendered, and a part writes only when its value differs. Markup that doesn't match is replaced, with a warning.

The JavaScript output is a module that calls `define()` on `@mnx/runtime` with the component's props, template, parts and script. Parts are found by paths that count elements and comments only, because browsers merge and drop text nodes. Dynamic text beside other nodes follows an empty `<!---->` anchor, which both outputs emit.

## Using components in an app

`@mnx/unplugin` (in `plugin/`) compiles `.mnx` imports in Vite, Rollup, webpack, esbuild and Rspack. What an import gives depends on the importing file: a React component in `.jsx`/`.tsx` files, a Vue component in `.vue` files, the element class elsewhere. Props, events, two-way binding and children all work without glue code, and typings are written next to each component. See `plugin/README.md`.

The adapters it uses can also be used by hand: `wrap(Element)` from `@mnx/runtime/react` (React 18 and 19) or `@mnx/runtime/vue` (Vue 3). Other frameworks (Angular, Svelte, Solid, Lit) and plain HTML use the element directly: properties in, DOM events out.

## Describing components to tools

- `--emit manifest` writes a [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest) (`custom-elements.json`, schema 2.1.0): the tag, each prop as an attribute and a field with its type and default, events with their `CustomEvent<…>` types, slots (the default slot is `""`) and the description. Editors, Storybook and documentation tools read this format. `--module-path` sets the module path it records.
- `--emit dts` writes TypeScript declarations: the element class with typed properties and typed `addEventListener`, a `…Props` interface, an `…EventMap`, the `tag` constant and an `HTMLElementTagNameMap` entry. `--framework react|vue` types the default export as that framework's wrapper, which is what the plugin writes.
- Types are inferred from defaults: `{ sample: "…" }` becomes `{ sample: string }`, `["a"]` becomes `string[]`, and a required prop with no default is `unknown`.

## Safety

Dynamic values are escaped or written as text. URL attributes must be relative or `http`, `https`, `mailto` or `tel`, checked at build time and again at runtime. Boolean attributes take booleans. String event handlers, inline styles, and `<script>`/`<style>` inside templates are rejected. See `docs/security.md` for the full model.

## The CLI

```sh
mnix compile <component.mnx> [--emit html|js|dts|manifest] [--props <props.json>] [--slots <slots.json>]
                             [--runtime <module>] [--keep-imports] [--framework react|vue]
                             [--module-path <path>] [--output <file>]
```

`--emit html` (the default) writes server-rendered HTML. `--props` and `--slots` supply values (defaults come from the component). `--emit js` writes the element module: `--runtime` changes the runtime import (default `@mnx/runtime`), and `--keep-imports` leaves `./x.mnx` imports for a bundler (otherwise they become `./x.js`). `--emit dts` writes declarations (`--framework` for a wrapper's) and `--emit manifest` the manifest. Output goes to stdout, or to `--output <file>` with an atomic write. Warnings go to stderr.

## Stability

1.0 freezes the authoring format (script, host tag and flags, `{expr}`, directives, slots, keys, imports, `emit`), the CLI's options and outputs' behaviour, and the runtime's documented exports. The generated JavaScript's internal shape (`define()`'s arguments, parts) is not public API, so components should be recompiled with the runtime version they run on.

Not in 1.0, and planned as additions in 1.x: a JSX authoring front end, a `wasm32` build of the compiler, SSR presets for meta-frameworks, dedicated Angular/Svelte/Solid adapters, scoped `<style>`, and prop defaults computed at runtime (prop defaults are build-time values in 1.0).

## Repository and tests

- `src/`: the compiler (Rust): scanner, parser, script analysis with oxc, resolver and lowering, HTML renderer, JavaScript and interface emitters, CLI.
- `runtime/`: `@mnx/runtime`, with the React and Vue adapters.
- `plugin/`: `@mnx/unplugin`.

Install Rust 1.97 or newer and Node 20 or newer.

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
(cd runtime && npm ci && npm test)       # unit tests, incl. Signals differential tests
(cd runtime && npm run test:browser)     # Chromium: components, hydration, slots, events, adapters
(cd runtime && npm run test:tools)       # manifest schema and TypeScript checks
(cd plugin && npm ci && npm test)        # real Vite apps with React, Vue and no framework
```

The browser and plugin suites need Playwright's Chromium (`npx playwright install chromium`). `.github/workflows/ci.yml` runs every suite on each push. Behaviour is mutation-checked: each feature's code was deliberately broken in turn to confirm a test fails.
