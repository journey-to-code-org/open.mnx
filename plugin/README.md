# @zubra/unplugin

Compile `.zb` components in Vite (and Rollup, webpack, esbuild and Rspack, through [unplugin](https://github.com/unjs/unplugin)). Importing a component gives each file what its framework expects, so nobody writes integration code.

```js
// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import zubra from '@zubra/unplugin/vite';

export default defineConfig({ plugins: [zubra(), react()] });
```

```tsx
// App.tsx
import Rating from './rating.zb';

export function App() {
  const [stars, setStars] = useState(1);
  return <Rating value={stars} onValueChange={(event) => setStars(event.detail)} />;
}
```

```vue
<!-- App.vue -->
<script setup>
import Rating from './rating.zb';
const stars = ref(1);
</script>
<template><Rating v-model="stars" /></template>
```

## JSX components

`.zb.jsx` and `.zb.tsx` files are components too (see the main README), resolved and wrapped like `.zb` files: `import Rating from './rating.zb.tsx'` in a React file is a React component, and `?element` gives the element. TypeScript reads the component's own source for its types, so no typings file is written for it.

## What an import gives

| Imported from | Default export |
|---|---|
| a `.jsx` / `.tsx` file | a React component (`@zubra/runtime/react`, React 18 and 19) |
| a `.vue` file | a Vue 3 component (`@zubra/runtime/vue`) |
| another `.zb` component | the custom element class |
| any other file | the project's framework (detected from the React or Vue Vite plugin), or the element class when there is none |

Every variant defines the custom element, so `<zb-rating>` also works in plain HTML. Add `?element`, `?react` or `?vue` to an import to choose explicitly. `tag` is also exported.

- **React**: props are set as properties; `on<Event>` in any casing listens for the component's events (`onValueChange` for `valuechange`); `value` + `onValueChange` is the controlled pattern. Children go into the component's slots (`slot="name"` for named slots) and stay live as React updates them.
- **Vue**: props are set as DOM properties before the element starts; events are Vue events (`@valuechange`); every `<prop>` + `<prop>change` pair supports `v-model:<prop>`, and `v-model` binds `value`. Named slots (`<template #title>`) become `slot="title"` content.
- **Anything else** (Svelte, Solid, Preact, Lit, Angular, plain DOM) uses the element directly: properties in, DOM events out, as with built-in elements. In Svelte, Solid and Preact projects (detected from their Vite plugins) every file gets the element, and the typings are written for that framework.

## Server builds and Astro

In a server build (Vite's SSR), each component module also registers its server renderer, which renders with `@zubra/compiler` from the component's sources embedded in the bundle. `renderToString(Element, { props, attributes, slots })` from `@zubra/runtime/server` uses it. Install `@zubra/compiler` in apps that render on the server, or pass `ssr: false` to leave it out.

For Astro, add the integration (it adds this plugin to Astro's Vite config):

```js
// astro.config.mjs
import zubra from '@zubra/unplugin/astro'
export default { integrations: [zubra()] }
```

```astro
---
import Rating from '../components/rating.zb'
---
<Rating value={3} class="big" />          <!-- server-rendered HTML, no JavaScript -->
<Rating value={3} client:load />          <!-- server-rendered, then hydrated -->
```

Props go to the component, other attributes to its host, children to its slots (`slot="name"` for a named one).

## Styles

With Vite, a component's `<style>` is a CSS module in Vite's pipeline, so PostCSS, Tailwind (`@reference "tailwindcss"`, `@apply`) and preprocessors (`<style lang="scss">`) process it. Light-DOM components' CSS lands in the page's CSS bundle; shadow components get theirs as a string (`?inline`) for their shadow roots. With other bundlers, plain CSS is inlined in the module. See the main README's Styles section.

## Options

```js
zubra({
  compiler: '/path/to/zubra',    // default: $ZUBRA_COMPILER, then @zubra/compiler, then `zubra` on PATH
  framework: 'auto',           // or 'react' | 'vue' | 'element': the default for plain files
  dts: true,                   // write typings next to each component; { dir: '.zubra/types' } writes them
                               // in the app instead (see Types), false writes none
  runtime: '@zubra/runtime',     // the runtime module compiled code imports
  ssr: true,                   // server builds register a renderer (needs @zubra/compiler at run time)
  root: process.cwd(),         // where your own components are (default: Vite's root, or the current folder):
                               // a package's component with one of their tags gets yours (docs/guide/04-composition.md)
})
```

## Types

Next to each component the plugin writes `rating.d.zb.ts`, typed for the project's framework: the React component's props and handlers, or the Vue component's props, events and `v-model`. TypeScript uses these files when `allowArbitraryExtensions` is on:

```json
{ "compilerOptions": { "allowArbitraryExtensions": true, "types": ["@zubra/unplugin/client"] } }
```

`@zubra/unplugin/client` covers `.zb` imports that don't have typings yet (before the first build) and the `?element` form. The generated files can be committed or ignored (`*.d.zb.ts`).

### Components shared by apps in different frameworks

Typings beside a component are typed for one framework, so when a React app and a Svelte app both build the same components folder, the last build decides what both read. Give each app its own:

```js
zubra({ dts: { dir: '.zubra/types' } })
```

```json
{ "extends": "./.zubra/types/tsconfig.json", "compilerOptions": { "types": ["@zubra/unplugin/client"] } }
```

The folder (relative to the app's root) mirrors the root: `src/rating.zb` is typed by `.zubra/types/src/rating.d.zb.ts`, and a component above the root by a `__` per folder up (`../ui/rating.zb` by `.zubra/types/__/ui/rating.d.zb.ts`). The `tsconfig.json` written there sets `allowArbitraryExtensions` and the `rootDirs` that pair each mirrored folder with the real one, so imports stay as written; if your tsconfig has its own `rootDirs`, add those to it. Set the option in every app that builds the shared folder and delete the `*.d.zb.ts` files already beside the components: TypeScript reads one beside a component first, and the build warns when it finds one. Ignore the folder in git.

In the editor you don't need these files: the VS Code extension's TypeScript plugin types `.zb` imports from the components directly, updated each time one is saved (see [Editor support](../docs/editor-support.md)). They're for `tsc` in builds and CI.

## Development

In Vite's dev server, editing a component **updates it in place**: the elements on the page get the new template, script and styles, and keep their props, state (by the order of the script's `let`s, as long as a value's kind doesn't change) and slotted content. A change to the element's interface (its props, events, `shadow` or `form-associated`) reloads the page instead. A compile error appears in Vite's overlay with the line, a code frame and the compiler's suggestion.

Components that import the edited one are recompiled too. Other bundlers' watch modes (Rollup, webpack) recompile on change.

The dev server also compiles each component for the **Zubra DevTools** (`--devtools`): select a node in the browser's Elements panel and the Zubra pane shows its component's `.zb` file and line, its props and state, and each binding's line and the signals it reads (see `editors/devtools`). Builds carry none of it.

To use the DevTools on a build too (a demo, a staging or preview deploy), pass `zubra({ devtools: true })` or set `ZUBRA_DEVTOOLS=1`: components are compiled the same way and `@zubra/runtime` resolves to its development build, which has the hook. It costs some bytes, so production builds leave it off by default.

## Tests

`npm test` builds real React, Vue and plain Vite apps, runs them in Chromium, type-checks the generated typings with TypeScript, and checks the dev server, `build --watch` and error reporting. It needs a Rust toolchain (the compiler is built from this repository) and Playwright with Chromium.
