# Shelfwise: Nuxt with mnx components

A bookshop's inventory. Filter books by genre (filtered on the server, with the URL kept in sync), see stock against each book's reorder point, and edit a book's price, stock, tags and front-page flag, saved through a Nitro API route that validates them.

Nuxt builds with Vite, so the mnx plugin goes straight into `nuxt.config.ts`:

```ts
import mnx from '@mnx/unplugin/vite';
export default defineNuxtConfig({ vite: { plugins: [mnx()] } });
```

Imported into a `.vue` file, a `.mnx` file is a Vue component:

```vue
<MoneyInput v-model="draft.price" label="Price" :min="0.01" />
<ToggleSwitch v-model:checked="draft.featured" label="Featured" />
```

| What | Where |
|---|---|
| `v-model` on mnx elements (`value`), and `v-model:checked` on a `:model` prop with another name | `app/pages/books/[id].vue` |
| A filter on an mnx element driving `useFetch`'s query, so Nitro filters on the server, and the URL follows | `app/pages/index.vue` |
| Registry components (`mnx add money-input quantity-stepper tag-input toggle-switch segmented-control`) beside the app's own `stock-meter` | `mnx/` |
| An API that validates what the editor sends (422 with field errors) | `server/api/books/[id].put.ts` |

```sh
npm install
npm run dev
npm run build && npm start      # PORT=3000 by default
npm test                        # builds, starts, drives it in Chromium
```

Inside this repository, the mnx compiler is the CLI from `cargo build` (the tests find it) or a built `compiler/mnx.wasm`. `.npmrc` installs the repository's packages as copies, as they'd come from npm.

## What this app found

These are recorded in the project's server roadmap (`plan/roadmap-server.md`).

- **The components are shadow DOM here, for the same reason as in the Next.js app, with a worse failure.** Nuxt server-renders each element's host tag, and the browser defines the elements before Vue hydrates. A light-DOM element renders its template into the host, and Vue fixes the mismatch by *removing* the nodes it didn't expect. Those nodes are the element's template, so the element ends up empty. Shadow-DOM elements hydrate cleanly.
- **Props aren't in the server HTML.** The Vue adapter renders a bare `<stock-meter>` on the server, so each element shows its defaults ("Out of stock") until hydration hands it its props.
- `mnx add` from a locally installed `@mnx/compiler` has no registry: the registry is copied into the package when it's published. The repository's own `compiler/cli.js add` was used here.
