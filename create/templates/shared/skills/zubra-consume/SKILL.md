---
name: zubra-consume
description: Use a Zubra component (or a library built with `zubra build --lib`) from an app: React, Vue, Svelte, Solid, Angular, Lit, Preact, Astro or plain HTML, with the bundler plugin or without one. Use when wiring a `.zb` import, passing an object prop, listening for a component's event, binding a value two-way, or putting children in a slot.
---

Every framework uses the element the same way underneath: **properties in, DOM events out, children as slots.** Nothing is written by hand to bridge them; the plugin or the library's wrappers do it.

## Steps

1. **Check how the project builds.** Vite, Rollup, webpack, esbuild or Rspack: `@zubra/unplugin` (`zubra()` in the bundler config; `npm create zubra` wrote it). Next.js: `@zubra/unplugin/loader` in `turbopack.rules`. The Angular CLI: compile with `zubra compile --emit js` and import the `.js`. No bundler: import the compiled module as a `<script type="module">`.
2. **Import the component** and write the tag. What the import gives depends on the importing file (table below). Typings are written next to the `.zb` file, so props and events are checked.
3. **Pass objects and arrays as properties, never as attribute strings.** Through the plugin, the wrappers and every framework listed below, a bound value *is* a property. In raw HTML, an attribute is the fallback: JSON for arrays and objects (`data='{"a":1}'`).
4. **Listen for the DOM event name**: all lowercase (`valuechange`), with the data in `event.detail`. Each framework's spelling is in the table.
5. **Bind two-way** through the `<prop>` + `<prop>change` pair the component declares with `:model`.
6. Done when the framework's dev server shows the component, a typo'd prop is a type error, and the event handler receives `detail`.

## Per framework

| Framework | Import gives | Props | Events | Two-way | Children |
|---|---|---|---|---|---|
| React 18/19 (`.jsx`/`.tsx`) | A React component (`import Rating from './rating.zb'`) | `<Rating value={3} items={list} />` | `onValueChange={(e) => e.detail}` | `value={v} onValueChange={…}` | JSX children; `slot="name"` on an element for named slots |
| Vue 3 (`.vue`) | A Vue component | `:items="list"` | `@valuechange="…"` | `v-model:value` (or `v-model` for `value`) | default and `<template #name>` slots |
| Svelte 5 | The element (typings written) | `<star-rating {value} items={list}>` | `onvaluechange={…}` | `bind:value` | children; `slot="name"` |
| Solid | The element (typings written) | `prop:items={list}` for objects; plain attributes for primitives | `on:valuechange={…}` | `prop:value` + `on:valuechange` | children; `slot="name"` |
| Angular | The element; `CUSTOM_ELEMENTS_SCHEMA` on the component | `[items]="list"` | `(valuechange)="…"` | `zubraModel [(ngModel)]="x"` from `@zubra/runtime/angular` | content projection; `slot="name"` |
| Lit, Preact | The element | `.items=${list}` (Lit), `items={list}` (Preact) | `@valuechange=${…}`, `onvaluechange={…}` | the pair by hand | children |
| Astro (`@zubra/unplugin/astro`) | A server-rendered component (`<Rating value={3} client:load />`) | props as values in the frontmatter's JSX | a `<script>` on the page: `addEventListener('valuechange', …)` | the pair in a script | children; `slot="name"` |
| Plain HTML | The element, once its module is loaded | `el.items = list` in a script, or JSON attributes | `el.addEventListener('valuechange', …)` | the pair by hand | children; `slot="name"` |

A library from `zubra build --lib` has the same per element: `@acme/ui/star-rating` (the element), `@acme/ui/react` and `@acme/ui/vue` (wrappers), typings, and `custom-elements.json` for editors and Storybook.

## Context from the app

Components that `inject(theme)` read it from the nearest `<zb-context>` around them, so the app can provide a theme, locale or current user once instead of passing it to every element. `value` can be a plain value or a signal.

| Framework | Provide it |
|---|---|
| React | `<ZubraContext context={theme} value={mode}>…</ZubraContext>` from `@zubra/runtime/react` |
| Vue | `<ZubraContext :context="theme" :value="mode">…</ZubraContext>` from `@zubra/runtime/vue` |
| Svelte, Solid, Angular, Lit, plain HTML | `import '@zubra/runtime/context'`, then `<zb-context>` with its `context` and `value` properties: `<zb-context {context} {value}>`, `prop:context`, `[context]="theme" [value]="mode"`, `.context=${theme}`, `el.value = …` |

`theme` is the key from `createContext()` that the components import. Any Context Protocol consumer is answered, Lit's `@consume` included.

## State shared with the app

A signal (a module-level `state()` or `computed()`, a `@zubra/sync` field) can be read by elements and by the app's own code at once, without copying it into the framework's state and back:

| Framework | Read it | Write it |
|---|---|---|
| React | `const items = useSignal(cart, { deep: true })` from `@zubra/runtime/react` | `cart.set(…)`, or mutate `cart.get()` |
| Vue | `const items = useSignal(cart, { deep: true })` from `@zubra/runtime/vue`: a ref | `items.value = …` (or mutate it) |
| Svelte | `const items = toStore(cart, { deep: true })` from `@zubra/runtime/bridge`, then `$items` | `$items = …`, `bind:value={$items}` |
| Solid | `const items = from(toStore(cart))` (solid-js `from`) | `cart.set(…)` |
| Angular | `items = toSignal(toStore(cart), { requireSync: true })` | `cart.set(…)` |
| Anything else | `subscribe(cart, (value) => …)` from `@zubra/runtime/bridge`, or RxJS `from(toStore(cart))` | `cart.set(…)` |

`deep: true` also follows mutations inside an array or object (`push`, a property write); without it only `set` counts.

## What crosses, and what doesn't

Props, events, two-way binding, slots, form participation, refs to the host, shared signals (above) and server rendering cross the element boundary. Render props, the framework's own context objects (provide the value through `<zb-context>` instead, above), Suspense and transitions, and the framework's own components as children-by-name do not: for those, put the Zubra component inside a framework component rather than the other way round. https://github.com/journey-to-code-org/zubra/blob/main/docs/what-crosses-the-boundary.md has the list with the alternatives. React-only widget libraries (Radix, shadcn/ui, React Aria) don't cross either. Inside a Zubra component, use the platform, `@zubra/runtime/primitives` or Zag.js, as in the registry's `tab-list`, `dropdown-menu`, `tool-tip` and `combo-box`. https://github.com/journey-to-code-org/zubra/blob/main/docs/guide/accessible-widgets.md maps Radix to these.

## Server rendering in a framework

Nuxt, React Router and SolidStart: an element given framework children must be `shadow`, and the page goes through `zubra.injectShadowRoots()` from `@zubra/server` (SolidStart with `{ lightDom: true }`); under SvelteKit every component must be `shadow` (one hook per framework, in `examples/meta/`). Next.js: the loader's server rule renders shadow-DOM elements without React children. Astro and plain servers render light-DOM components as they are. Details: https://github.com/journey-to-code-org/zubra/blob/main/docs/server-rendering.md.

## Reference

https://github.com/journey-to-code-org/zubra#using-components-in-an-app, `plugin/README.md` in the Zubra repository, and a complete tested app per framework in its `examples/frameworks/` and `examples/meta/`.
