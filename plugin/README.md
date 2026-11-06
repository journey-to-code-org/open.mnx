# @mnx/unplugin

Compile `.mnx` components in Vite (and Rollup, webpack, esbuild and Rspack, through [unplugin](https://github.com/unjs/unplugin)). Importing a component gives each file what its framework expects, so nobody writes integration code.

```js
// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mnx from '@mnx/unplugin/vite';

export default defineConfig({ plugins: [mnx(), react()] });
```

```tsx
// App.tsx
import Rating from './rating.mnx';

export function App() {
  const [stars, setStars] = useState(1);
  return <Rating value={stars} onValueChange={(event) => setStars(event.detail)} />;
}
```

```vue
<!-- App.vue -->
<script setup>
import Rating from './rating.mnx';
const stars = ref(1);
</script>
<template><Rating v-model="stars" /></template>
```

## What an import gives

| Imported from | Default export |
|---|---|
| a `.jsx` / `.tsx` file | a React component (`@mnx/runtime/react`, React 18 and 19) |
| a `.vue` file | a Vue 3 component (`@mnx/runtime/vue`) |
| another `.mnx` component | the custom element class |
| any other file | the project's framework (detected from the React or Vue Vite plugin), or the element class when there is none |

Every variant defines the custom element, so `<mnx-rating>` also works in plain HTML. Add `?element`, `?react` or `?vue` to an import to choose explicitly. `tag` is also exported.

- **React**: props are set as properties; `on<Event>` in any casing listens for the component's events (`onValueChange` for `valuechange`); `value` + `onValueChange` is the controlled pattern. Children go into the component's slots (`slot="name"` for named slots) and stay live as React updates them.
- **Vue**: props are set as DOM properties before the element starts; events are Vue events (`@valuechange`); every `<prop>` + `<prop>change` pair supports `v-model:<prop>`, and `v-model` binds `value`. Named slots (`<template #title>`) become `slot="title"` content.
- **Anything else** (Angular, Svelte, Solid, Lit, plain DOM) uses the element directly: properties in, DOM events out, as with built-in elements.

## Options

```js
mnx({
  compiler: '/path/to/mnix',   // default: $MNX_COMPILER, then `mnix` on PATH
  framework: 'auto',           // or 'react' | 'vue' | 'element': the default for plain files
  dts: true,                   // write typings next to each component
  runtime: '@mnx/runtime',     // the runtime module compiled code imports
})
```

## Types

Next to each component the plugin writes `rating.d.mnx.ts`, typed for the project's framework: the React component's props and handlers, or the Vue component's props, events and `v-model`. TypeScript uses these files when `allowArbitraryExtensions` is on:

```json
{ "compilerOptions": { "allowArbitraryExtensions": true, "types": ["@mnx/unplugin/client"] } }
```

`@mnx/unplugin/client` covers `.mnx` imports that don't have typings yet (before the first build) and the `?element` form. The generated files can be committed or ignored (`*.d.mnx.ts`).

## Development

Compile errors fail the build and show in Vite's overlay, with the source line and a suggestion. Editing a component reloads the page, because the platform can't redefine a custom element. Components that import it are recompiled too.

## Tests

`npm test` builds real React, Vue and plain Vite apps, runs them in Chromium, type-checks the generated typings with TypeScript, and checks the dev server, `build --watch` and error reporting. It needs a Rust toolchain (the compiler is built from this repository) and Playwright with Chromium.
