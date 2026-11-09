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

The same definition `--emit js` writes (props, template, styles, the script's setup) with the `@zubra/runtime` import replaced by a small `$define`, inlined, that turns it into the element. Because both outputs share the definition, they can't drift, and CI runs the runtime's browser suites and the registry's tests on both (`ZUBRA_EMIT=element npm run test:browser`).

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
- `{...spread}` in the template;
- `zb-await`;
- imports from `@zubra/runtime` other than the ones above (`resource`, `createContext`…), and runtime subpaths other than `/primitives` (`@zubra/runtime/zag`).

Not refused, but not done:
- **Server hydration.** A plain element renders its template on the client. Server markup inside it is replaced, not hydrated. For server-rendered pages, use `--emit js`.
- **Hot reload.** A plain element is defined once.
- **Signals from `@zubra/runtime`.** A plain element tracks its own `state()`s. A `state()` created by `@zubra/runtime` in another module isn't one of them, so an element doesn't update when it changes.

## Size, and which to use

The slot machinery is left out of a component that has no slots.

| | gzipped |
|---|---|
| a small element (toggle-switch, quantity-stepper) | about 5.5 KB |
| with lists, a ref and a form value (tag-input) | about 6 KB |
| with slots (accordion-panel) | about 7 KB |
| `@zubra/runtime`, shared by every component on the page | about 13 KB, plus 1–2 KB per component |

Each plain element carries its own copy of `$define`. For one to three components, plain output is smaller; past that, the shared runtime is. Use plain output to hand someone one file, to add a component to a page you don't build, or to publish a component with no dependencies. Use `--emit js` for an app.
