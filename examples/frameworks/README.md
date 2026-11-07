# mnx in every framework

One app per framework mnx supports, each a complete idea rather than a demo of one feature. The
UI is a mix of the framework's own components and mnx elements, used the way that framework uses
any element: no wrappers written by hand, no glue code.

| App | Framework | What it is | What it shows |
| --- | --- | --- | --- |
| [`react-board/`](react-board/) | React 19 | A sprint board | `.mnx` imports as React components; React-managed children in an element's slots (reordered, filtered, added); drag and drop; an mnx form control as a controlled input (`value` + `onValueChange`); undo |
| [`vue-budget/`](vue-budget/) | Vue 3 | A budget tracker | `v-model` on mnx elements, including form controls inside `v-for`; slot content from a Vue template; an SVG donut chart built from Vue's computed state |
| [`svelte-flashcards/`](svelte-flashcards/) | Svelte 5 | A spaced-repetition trainer | A shadow-DOM element with named slots filled from Svelte markup; `{#key}` re-creation; an element listening on the document (1–4 keys) and cleaning up |
| [`solid-markets/`](solid-markets/) | Solid | A live market dashboard | `prop:`/`on:` bindings updated on every tick; nested mnx elements (a tile's spark line); an SVG chart with pointer events; price alerts and a portfolio |
| [`lit-chat/`](lit-chat/) | Lit 3 | A team chat | Light-DOM mnx elements inside a LitElement's shadow root, with their styles adopted there; the signed-in user provided by `@lit/context` and read by mnx's `inject()` (the context protocol) |
| [`preact-habits/`](preact-habits/) | Preact 10 | A habit tracker | Objects as props; a colour from Preact's `style` prop reaching into elements as a custom property; a contribution-style grid with keyboard navigation; an mnx form control in a Preact form |
| [`angular-booking/`](angular-booking/) | Angular 22 | A booking wizard | Reactive forms whose controls are mnx elements (`mnxModel` with `formControlName`), validation, a step indicator; compiled ahead of time in Vite with Analog's plugin |

Astro is covered by [`../recipes/`](../recipes/), and plain HTML by [`../todo/`](../todo/) and
[`../planner/`](../planner/).

## Running one

The apps share one toolchain install, in this directory:

```sh
cd examples/frameworks
npm install
cd react-board      # or any other app
npx vite            # npx vite build for a production build
```

Each app also has its own `package.json`, so it works on its own if you copy it out of the
repository and run `npm install` there. Inside the repository the packages are linked from
`runtime/`, `plugin/` and `compiler/`, so build the compiler first: either `npm run build` in
`compiler/` (WebAssembly), or `cargo build` at the root and `MNX_COMPILER=../../../target/debug/mnx npx vite`.

## Tested

`npm test` here builds every app and goes through it in Chromium (`test/<framework>.test.js`):
the features above, a reload where the app saves its data, and no console errors. CI runs it on
every change.

## Notes per framework

- **React**: `import Card from './task-card.mnx'` gives a React component. Events are
  `on<Event>` in any casing (`onCardDrop` for `carddrop`). The Vite config dedupes React because
  the runtime is linked from this repository, which has its own copy; installed from npm there's
  only one.
- **Vue**: in `.vue` files the import is a Vue component: `v-model` binds `value` +
  `valuechange`, `@valuechange` listens, `<template #name>` fills a named slot.
- **Svelte, Solid, Lit, Preact**: the element itself. Svelte and Preact set properties for
  defined elements; Solid needs `prop:` (and `attr:` for data attributes); Lit uses `.prop` and
  `@event`.
- **Angular**: `CUSTOM_ELEMENTS_SCHEMA`, `[prop]` and `(event)`; `mnxModel` from
  `@mnx/runtime/angular` makes an element a form control. With Analog's Vite plugin, `.mnx`
  files are imported directly. (The Angular CLI's builder doesn't take Vite plugins: compile
  components with `mnx compile --emit js` there.)
