---
name: zubra-component
description: Write or change a Zubra component (a `.zb` file, or a `.zb.jsx` function). Use when asked for a web component, a custom element, a form control, or a component that must work in more than one framework or render on the server. Covers the format, state, events, slots, forms, styles, and the boundary between what belongs in the component and what belongs in the app.
---

A Zubra component is one `.zb` file: a `<script>`, a `<style>`, and a template whose root is the host tag. The compiler turns it into a custom element, its server HTML, its typings and a React or Vue wrapper. You write the HTML; the compiler writes the class.

## Steps

1. **Decide whether it's a leaf.** A component takes data in through props and sends it out through events; it may hold children through slots. If it would need the app's store, router, context or component types, it's a container: write that in the app's framework and put Zubra components inside it. (https://github.com/journey-to-code-org/zubra/blob/main/docs/what-crosses-the-boundary.md has the full list.)
2. **Name the element with a hyphen** (`star-rating`, not `rating`), and put the file at `src/components/<tag>.zb` unless the project has another convention.
3. **Write the host tag with every prop**, each with its default, then the script, then the template. Follow the format below.
4. **Run `zubra check <file>`** (`npx zubra check` without a Rust toolchain). It prints each error with a caret and a suggested fix; `--format json` gives the same as data (Rust CLI only). Done when it prints `no errors`.
5. **If the component is server-rendered, run `zubra check --server <file>`** and move anything it names (a `Date`, an `Intl` call, a `window` read) into `onMount` or behind `hydrated()`, so the server HTML is complete.
6. **Write the test** the project's other components have (a browser test from `npm create zubra`, or `node --test` with the project's harness), covering each prop, each event and keyboard use.

## The format

```html
<!--
  A star rating.                               ← the description, for docs and typings
  @fires valuechange - The value changed; `detail` is the new value.
-->
<script>
  import { onMount } from '@zubra/runtime'
  let hovered = null                           // state: assigning it updates the DOM
  const shown = hovered ?? value               // derived: reads state or props, stays in sync
  const stars = [1, 2, 3, 4, 5].slice(0, max)  // in the server's subset, so the HTML has the stars
  function rate(stars) { value = stars }       // a prop is a name in the script, readable and writable
  onMount(() => console.log('in the DOM'))
</script>
<style>
  button { font: inherit; }                    /* scoped to this component, in light DOM too */
  button.lit { color: gold; }
</style>
<star-rating value:model={0} max={5} label="Rate">
  <zb-each items={stars} as="star" key={star}>
    <button type="button" aria-label="{star} of {max}" class:lit={star <= shown}
            onclick={() => rate(star)} onmouseenter={() => (hovered = star)} onmouseleave={() => (hovered = null)}>★</button>
  </zb-each>
  <output>{label}: {value}</output>
</star-rating>
```

- **Host tag**: `<tag attr={default} …>`. `value={0}` is a number prop, `label="Rate"` a string, `items={[]}` an array, bare `name` a required prop. Kebab-case attributes are camelCase props (`max-value` → `maxValue`). Flags: `shadow` (shadow DOM; light DOM is the default), `form-associated` (a form control), `host-reset` (for other people's pages).
- **`name:model={default}`** makes a prop two-way: assigning it in the script fires `<name>change` with the new value in `detail`. Frameworks bind it (`v-model`, `bind:value`, React's controlled pattern). Use it for every control's value; never fire the change event by hand.
- **`{expr}`** in text, inside quoted attributes (`class="card {kind}"`) or as a whole attribute (`items={list}`, any type). Any JavaScript expression; signals and props read as values.
- **Events on elements**: `onclick={fn}` or `onclick={() => …}`. Modifiers: `onsubmit.prevent`, `.stop`, `.once`, `.self`, `.capture`, `.passive`, `.submit` (submits the form after the handler); key filters `onkeydown.enter`, `.escape`, `.space`, `.up`, `.shift.enter`, `.mod.enter` (⌘ or Ctrl).
- **`class:name={bool}`**, `class={{ a, b: cond }}`, **`style:prop={value}`**, `style:--var={value}`, `style={{ … }}`. Never build a class or style string by hand.
- **`{...object}`** spreads attributes, `on<Name>` listeners and properties onto an HTML element (`<input {...api.getInputProps()}>`): use it for a headless library's prop getters. Explicit attributes win; it isn't allowed on the host, directives or Zubra components.
- **`ref={el}`** assigns an element to a `let` once rendered. **`<zb-window>`/`<zb-document>`** take listeners (`<zb-document onkeydown.escape={close}>`), removed on unmount.

## Directives

| | |
|---|---|
| `<p zb-if={…}>`, then `<p zb-else-if={…}>` / `<p zb-else>` on the next siblings | a condition on one element (prefer this for one element) |
| `<zb-if test={…}>…<zb-else-if test={…}>…</zb-else-if><zb-else>…</zb-else></zb-if>` | a condition over several siblings or text |
| `<zb-each items={list} as="item" index="i" key={item.id}>` | lists; always give a `key` when rows can reorder or be removed from the middle |
| `<zb-switch value={x}><zb-case is="a">…</zb-case><zb-case is={["b", "c"]}>…</zb-case><zb-else>…</zb-else></zb-switch>` | one value, several cases (status values, enums) |
| `let:total={item.price * item.qty}` on `zb-each` / `zb-then` | a derived name for the row or result, instead of repeating the expression |
| `<zb-slot>` and `<zb-slot name="x">fallback</zb-slot>` | children; `hasSlot('x')` says whether content was given |
| `<zb-await value={promiseOrResource}><zb-pending>…</zb-pending><zb-then as="data">…</zb-then><zb-catch as="error">… <button onclick={retry}>Retry</button></zb-catch></zb-await>` | async; `value={[a, b]}` waits for both; `as` may destructure (`as="{ name }"`); `retry()` in zb-catch; `delay={ms}`, `keep` |
| `<my-child value:bind={state}>` | two-way binding to a child's `:model` prop |

Markup in braces (`{a && <p>…</p>}`, `{a ? <b>…</b> : <i>…</i>}`, `{list.map((x) => <li key={x.id}>…</li>)}`) compiles to the same directives and is accepted, but write the directives: they're the house style. Any other `zb-` attribute is an error.

## Script rules

- **A top-level `let` is state.** Assign it (`count++`, `items = []`) or mutate it (`items.push(x)`, `item.done = !item.done`, `form.email = ""`): both update what read it. Arrays and plain objects in state are reactive proxies; `raw(items)` gives the original for `structuredClone` or `postMessage`.
- **A top-level `const` that reads props or state is derived**, kept in sync. Other `const`s, functions and imports run once per element.
- **Props are names.** Read `value`, assign `value = 3`. The script can't declare a name a prop has; a default from the script uses another name (`<x-card title={titleDefault}>`).
- **`let x = from(prop)`** is state that starts from a prop and resets when the prop changes; `let x = prop` reads it once.
- **Events**: `emit('name', detail)` from `@zubra/runtime`, name a string literal, all lowercase like the DOM's own (`itemselect`, not `itemSelect` or `item-select`); reuse native names where the meaning matches (`change`, `toggle`, `close`). `before<name>` events are cancelable: `if (!emit('beforeclose')) return`. Document each with `@fires name - text` in the description comment.
- **Hooks**, plain functions called during the script: `onMount(fn)` (may return a cleanup), `onUnmount(fn)`, `effect(fn)`, `watch(source, (next, prev) => …)`, `computed(fn)`, `state(v)`, `resource(fetcher)`, `id()` (for `id`/`for`/`aria-*`), `host()`, `hasSlot(name)`, `hydrated()`, `createContext`/`provide`/`inject`. Nothing re-renders, so there are no hook rules beyond "call them while the script runs".
- **Forms**: `form-associated` on the host makes the element a control; a single `:model` prop is its submitted value under its `name`. `validity(() => message)` takes part in validation (`''` is valid). `onFormReset`, `onFormRestore`, `onFormDisabled`.
- **Server functions**: `export async function save(formData) { 'use server'; … }` is the only export a script may have. It runs on the server (served by `@zubra/actions`); in the component its name is its URL, and `<form action={save}>` posts there with or without JavaScript. The result comes back as the form's `action` event: `onaction={(event) => (result = event.detail.value)}`. Validate the `FormData` inside the function; imports only it uses never reach the browser.
- **`<script lang="ts">`** for TypeScript (erasable syntax only). `declare const value: number | null` types a prop whose default doesn't say enough.

## Accessible widgets

There is no Radix here; use, in order: the platform (`<dialog>` with `showModal()`, `popover` + `popovertarget`, CSS anchor positioning, `<details name>`, `<select>`, `<input type=range>`); `rovingFocus(container, { selector, orientation, onMove })` and `typeahead(container, { selector })` from `@zubra/runtime/primitives`, called in `onMount` (each returns its cleanup) for menus, tab lists, toolbars and listboxes; and for combobox, date picker, colour picker or tree view, a Zag.js machine through `@zubra/runtime/zag`: `const machine = useMachine(combobox.machine, () => ({ id: uid, … }))` with `uid = id()` hoisted, `const api = computed(() => combobox.connect(machine.current, normalizeProps))`, then `{...api.getXProps()}` on the elements. Copy the registry's `tab-list`, `dropdown-menu`, `tool-tip`, `accordion-panel` and `combo-box` rather than writing one from scratch.

## JSX form

A `.zb.jsx` / `.zb.tsx` file default-exports a function; same element, same rules: `function StarRating({ value = model(0), max = 5, onValueChange })`, top-level `let` is state, `cond && <X/>` and `list.map(…)` with `key` are the directives, `children` is the default slot, `onValueChange(x)` fires `valuechange`. Prefer `.zb` unless the project is already JSX.

## What the server can't render

The server evaluates the deterministic subset (props, arithmetic, ternaries, template literals, arrow functions defined in the script (not `function` declarations), string and array methods, `Math` except `random`, `Object.keys/values/entries`). `Date`, `Intl`, `Math.random`, `toLocaleString`, `window`, `document` and `navigator` are browser-only: put them in `onMount`, in a handler, or in a `let` set from an effect, and show a server-safe fallback. `hydrated()` is `false` on the server and `true` once the element has started, for markup that only works with JavaScript.

## Reference

The Zubra README is the full reference; read a section only when a rule above isn't enough: https://github.com/journey-to-code-org/zubra#writing-a-component, `#directives`, `#classes-styles-events-and-references`, `#script-state-and-hooks`, `#events`, `#slots`, `#forms`, `#styles`, `#async-data`, `#server-rendering-and-hydration`. The registry holds twenty-five tested, accessible components to copy the shape from (`npx zubra add --list`; `registry/components/` in the Zubra repository).
