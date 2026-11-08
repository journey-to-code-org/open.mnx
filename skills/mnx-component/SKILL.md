---
name: mnx-component
description: Write or change an mnx component (a `.mnx` file, or a `.mnx.jsx` function). Use when asked for a web component, a custom element, a form control, or a component that must work in more than one framework or render on the server. Covers the format, state, events, slots, forms, styles, and the boundary between what belongs in the component and what belongs in the app.
---

An mnx component is one `.mnx` file: a `<script>`, a `<style>`, and a template whose root is the host tag. The compiler turns it into a custom element, its server HTML, its typings and a React or Vue wrapper. You write the HTML; the compiler writes the class.

## Steps

1. **Decide whether it's a leaf.** A component takes data in through props and sends it out through events; it may hold children through slots. If it would need the app's store, router, context or component types, it's a container: write that in the app's framework and put mnx components inside it. (https://github.com/journey-to-code-org/open.mnx/blob/main/docs/what-crosses-the-boundary.md has the full list.)
2. **Name the element with a hyphen** (`star-rating`, not `rating`), and put the file at `src/components/<tag>.mnx` unless the project has another convention.
3. **Write the host tag with every prop**, each with its default, then the script, then the template. Follow the format below.
4. **Run `mnx check <file>`** (`npx mnx check` without a Rust toolchain). It prints each error with a caret and a suggested fix; `--format json` gives the same as data. Done when it prints `no errors`.
5. **If the component is server-rendered, run `mnx check --server <file>`** and move anything it names (a `Date`, an `Intl` call, a `window` read) into `onMount` or behind `hydrated()`, so the server HTML is complete.
6. **Write the test** the project's other components have (a browser test from `npm create mnx`, or `node --test` with the project's harness), covering each prop, each event and keyboard use.

## The format

```html
<!--
  A star rating.                               ← the description, for docs and typings
  @fires valuechange - The value changed; `detail` is the new value.
-->
<script>
  import { onMount } from '@mnx/runtime'
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
  <mnx-each items={stars} as="star" key={star}>
    <button type="button" aria-label="{star} of {max}" class:lit={star <= shown}
            onclick={() => rate(star)} onmouseenter={() => (hovered = star)} onmouseleave={() => (hovered = null)}>★</button>
  </mnx-each>
  <output>{label}: {value}</output>
</star-rating>
```

- **Host tag**: `<tag attr={default} …>`. `value={0}` is a number prop, `label="Rate"` a string, `items={[]}` an array, bare `name` a required prop. Kebab-case attributes are camelCase props (`max-value` → `maxValue`). Flags: `shadow` (shadow DOM; light DOM is the default), `form-associated` (a form control), `host-reset` (for other people's pages).
- **`name:model={default}`** makes a prop two-way: assigning it in the script fires `<name>change` with the new value in `detail`. Frameworks bind it (`v-model`, `bind:value`, React's controlled pattern). Use it for every control's value; never fire the change event by hand.
- **`{expr}`** in text, inside quoted attributes (`class="card {kind}"`) or as a whole attribute (`items={list}`, any type). Any JavaScript expression; signals and props read as values.
- **Events on elements**: `onclick={fn}` or `onclick={() => …}`. Modifiers: `onsubmit.prevent`, `.stop`, `.once`, `.self`, `.capture`, `.passive`, `.submit` (submits the form after the handler); key filters `onkeydown.enter`, `.escape`, `.space`, `.up`, `.shift.enter`, `.mod.enter` (⌘ or Ctrl).
- **`class:name={bool}`**, `class={{ a, b: cond }}`, **`style:prop={value}`**, `style:--var={value}`, `style={{ … }}`. Never build a class or style string by hand.
- **`ref={el}`** assigns an element to a `let` once rendered. **`<mnx-window>`/`<mnx-document>`** take listeners (`<mnx-document onkeydown.escape={close}>`), removed on unmount.

## Directives

| | |
|---|---|
| `<mnx-if test={…}>…<mnx-else-if test={…}>…</mnx-else-if><mnx-else>…</mnx-else></mnx-if>` | conditionals |
| `<mnx-each items={list} as="item" index="i" key={item.id}>` | lists; always give a `key` when rows can reorder or be removed from the middle |
| `<mnx-slot>` and `<mnx-slot name="x">fallback</mnx-slot>` | children; `hasSlot('x')` says whether content was given |
| `<mnx-await value={promiseOrResource}>pending<mnx-then as="data">…</mnx-then><mnx-catch as="error">…</mnx-catch></mnx-await>` | async |
| `<my-child value:bind={state}>` | two-way binding to a child's `:model` prop |

## Script rules

- **A top-level `let` is state.** Assign it (`count++`, `items = []`) or mutate it (`items.push(x)`, `item.done = !item.done`, `form.email = ""`): both update what read it. Arrays and plain objects in state are reactive proxies; `raw(items)` gives the original for `structuredClone` or `postMessage`.
- **A top-level `const` that reads props or state is derived**, kept in sync. Other `const`s, functions and imports run once per element.
- **Props are names.** Read `value`, assign `value = 3`. The script can't declare a name a prop has; a default from the script uses another name (`<x-card title={titleDefault}>`).
- **`let x = from(prop)`** is state that starts from a prop and resets when the prop changes; `let x = prop` reads it once.
- **Events**: `emit('name', detail)` from `@mnx/runtime`, name a string literal, all lowercase like the DOM's own (`itemselect`, not `itemSelect` or `item-select`); reuse native names where the meaning matches (`change`, `toggle`, `close`). `before<name>` events are cancelable: `if (!emit('beforeclose')) return`. Document each with `@fires name - text` in the description comment.
- **Hooks**, plain functions called during the script: `onMount(fn)` (may return a cleanup), `onUnmount(fn)`, `effect(fn)`, `watch(source, (next, prev) => …)`, `computed(fn)`, `state(v)`, `resource(fetcher)`, `id()` (for `id`/`for`/`aria-*`), `host()`, `hasSlot(name)`, `hydrated()`, `createContext`/`provide`/`inject`. Nothing re-renders, so there are no hook rules beyond "call them while the script runs".
- **Forms**: `form-associated` on the host makes the element a control; a single `:model` prop is its submitted value under its `name`. `validity(() => message)` takes part in validation (`''` is valid). `onFormReset`, `onFormRestore`, `onFormDisabled`.
- **`<script lang="ts">`** for TypeScript (erasable syntax only). `declare const value: number | null` types a prop whose default doesn't say enough.

## JSX form

A `.mnx.jsx` / `.mnx.tsx` file default-exports a function; same element, same rules: `function StarRating({ value = model(0), max = 5, onValueChange })`, top-level `let` is state, `cond && <X/>` and `list.map(…)` with `key` are the directives, `children` is the default slot, `onValueChange(x)` fires `valuechange`. Prefer `.mnx` unless the project is already JSX.

## What the server can't render

The server evaluates the deterministic subset (props, arithmetic, ternaries, template literals, string and array methods, `Math` except `random`, `Object.keys/values/entries`). `Date`, `Intl`, `Math.random`, `toLocaleString`, `window`, `document` and `navigator` are browser-only: put them in `onMount`, in a handler, or in a `let` set from an effect, and show a server-safe fallback. `hydrated()` is `false` on the server and `true` once the element has started, for markup that only works with JavaScript.

## Reference

The mnx README is the full reference; read a section only when a rule above isn't enough: https://github.com/journey-to-code-org/open.mnx#writing-a-component, `#directives`, `#classes-styles-events-and-references`, `#script-state-and-hooks`, `#events`, `#slots`, `#forms`, `#styles`, `#async-data`, `#server-rendering-and-hydration`. The registry holds twenty tested, accessible components to copy the shape from (`npx mnx add --list`; `registry/components/` in the mnx repository).
