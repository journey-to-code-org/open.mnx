# Plain elements: `--emit element`

```sh
zubra compile toggle-switch.zb --emit element --output toggle-switch.js
```

```html
<script type="module" src="toggle-switch.js"></script>
<toggle-switch label="Wi-Fi" checked></toggle-switch>
```

The module defines a `class extends HTMLElement` and registers it. It imports nothing (except other components it uses, and `@zubra/runtime/primitives` if the script imports it), so it works on a page with no build step and no package installed.

## What it is

The custom element as you'd write it by hand, so you can read it to learn the platform. One class, top to bottom:

- `static observedAttributes`, and `attributeChangedCallback` turning each attribute's text into its prop's type (`raw === null ? 0 : Number(raw)`);
- each prop as a `get`/`set` pair over a private `#props` object, and the constructor taking over properties a framework set before the class was defined;
- `connectedCallback` adopting the component's stylesheet and, the first time, running `#setup()`: your `<script>`, as you wrote it, with props read as `element.name` and state as `name.value` (`count.value++`);
- the template as markup, cloned once per element, with the nodes that change found by position and named after their class, id or tag (`const less = content.children[0]`);
- one line per dynamic spot: what it reads, and the DOM call that writes it (`bind(() => element.label, (value) => less.setAttribute("aria-label", value))`), and `addEventListener` for each event;
- a microtask-batched `#update()`, and, for a form control, `attachInternals()` with `setFormValue`, `setValidity` and `formResetCallback`.

What the platform doesn't do for light DOM is in small, commented helpers after the class, each written into the module only when the component uses it: keyed lists (`list`), conditionals (`when`), light-DOM slots, deep `state()`, and the URL checks. A component without slots has none of the slot code; one without lists has no `list`.

The output is checked by behaviour, not by text: CI runs the runtime's browser suites and the registry's tests on both `--emit js` and `--emit element` (`ZUBRA_EMIT=element npm run test:browser`).

It covers light-DOM components:
- props as properties and observed attributes (parsed by the default's type), including properties set before the element was defined;
- every template part: text, attributes (with the URL and `srcset` checks), properties, events with modifiers, `zb-window`/`zb-document` listeners, refs, `class:`, `classes`, `style:`, `zb-if`, `zb-each` (keyed rows keep their focus and are moved, not rebuilt), `zb-switch`, `let:`;
- light-DOM slots, with fallbacks and `hasSlot()`, kept live while React, Vue, Svelte or Lit add, remove and reorder the host's children;
- `state()` (with deep mutation), `computed()`, `effect()`, `onMount`, `onUnmount`, `id`, `host`, `emit`;
- form association: `formValue`, `validity`, a two-way prop as the form value, form reset;
- scoped styles, adopted by the document or the shadow root the element is in;
- the framework adapters (`:state(hydrated)`, `zb-props`).

Updates are batched in a microtask and re-run the component's bindings; an element off the page doesn't update, and catches up when it's back.

## What it refuses

Each with an error that names it and points at `--emit js`:
- shadow DOM (`<x-a shadow>`);
- `{...spread}` in the template (one of the 26 registry components, `combo-box`, uses it, through Zag's props; reading the loop back with `zubra convert` would be the larger half of the work, so it stays refused until more components need it);
- `zb-await`;
- imports from `@zubra/runtime` other than the ones above (`resource`, `createContext`…), and runtime subpaths other than `/primitives` (`@zubra/runtime/zag`).

Not refused, but not done:
- **Server hydration.** A plain element renders its template on the client. Server markup inside it is replaced, not hydrated. For server-rendered pages, use `--emit js`.
- **Hot reload.** A plain element is defined once.
- **Signals from `@zubra/runtime`.** A plain element tracks its own `state()`s. A `state()` created by `@zubra/runtime` in another module isn't one of them, so an element doesn't update when it changes.

## Size, and which to use

Each module holds only what its component uses, so plain output is small:

| | gzipped |
|---|---|
| the README's copy button | about 1.6 KB |
| a small element (toggle-switch, quantity-stepper) | about 2.2 KB |
| with lists, a ref and a form value (tag-input) | about 3.7 KB |
| with slots (accordion-panel) | about 3.5 KB |
| `@zubra/runtime`, shared by every component on the page | about 15 KB, plus 1–2 KB per component |

(Minified with esbuild, then `gzip -9`. The runtime's figure is its production build in a bundle, which `runtime/test/tools/size.test.js` holds to 15.25 KB; served file by file by `@zubra/server`, with no bundler, it is about 18 KB.) Each plain element carries its own copy of the helpers it uses. For a handful of components, plain output is smaller; past that, the shared runtime is. Use plain output to read what a component does, to hand someone one file, to add a component to a page you don't build, or to publish a component with no dependencies. Use `--emit js` for an app, and for server-rendered pages.

A component written as JSX (`.zb.jsx`, `.zb.tsx`) reads the same way: its script is written out as `zubra convert --as zubra` would write it, with props as `element.name` and state as `name.value`, and its text keeps JSX's whitespace rule.

## Back to `.zb`: `zubra convert`

The other direction: `zubra convert my-element.js` reads a custom element in this shape and writes the `.zb` component it means.

```sh
zubra compile toggle-switch.zb --emit element --output toggle-switch.js
# … read it, change it, learn from it …
zubra convert toggle-switch.js --out toggle-switch.zb
```

It undoes what the emitter did. The props (`static zubra`, or `observedAttributes` with `#props`) become the host tag's attributes. The script comes back as written: `element.count` is `count`, `const count = state(0)` is `let count = 0`, and the hooks are imported again. Each `bind()` goes back onto its node as an attribute, a `class:`, a `style:` or text. Each listener becomes an `on…`, with its modifiers read back from the checks (`onkeydown.enter.prevent`). `list()`, `when()` and the slots become `<zb-each>`, `<zb-if>` and `<zb-slot>`, and the stylesheet comes back unscoped. An element written by hand in the same shape converts too: a class with `#setup()` that clones its markup, names its nodes and keeps a list of `bind(read, write)` updates.

It is checked as a fixed point: every component `--emit element` accepts (the registry and the runtime's test components, 61 of them), compiled, converted back and compiled again, gives the same element. What it can't place (a DOM call that isn't one of the emitter's, module code beyond the element and its helpers) is reported at its line with `not converted:`, not guessed, and the result is compiled to check it. TypeScript's types don't survive the trip, since the element is JavaScript.

