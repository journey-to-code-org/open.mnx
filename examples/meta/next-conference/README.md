# WebConf: Next.js with mnx components

A conference schedule. Filter the talks by track, star the ones you want (kept in `localStorage`), and rate a talk afterwards through a form handled by a **Server Action**.

Next.js 16 builds with Turbopack, which takes webpack-style loaders but not bundler plugins. `next.config.mjs` gives `.mnx` files mnx's loader (`@mnx/unplugin/loader`, since 2.8), and the app imports components directly, as React (client) components:

```jsx
'use client';
import SessionCard from '../components/session-card.mnx';
```

(Before 2.8 the app used library mode, `mnx build --lib`, which still works for a component package.)

| What | Where |
|---|---|
| A Server Component reading data, passing it to a client component that uses mnx elements | `app/page.jsx` → `app/Schedule.jsx` |
| Two-way props as React state (`value` + `onValueChange`, `starred` + `onStarredChange`) | `app/Schedule.jsx` |
| mnx **form controls** in a Server Action form: `star-rating` and `toggle-switch` are form-associated, so `rating` and `followup` arrive in `FormData`, and `required` stops the submission like a native input | `app/sessions/[id]/FeedbackForm.jsx`, `app/actions.js` |
| Components from the registry (`mnx add segmented-control star-rating toggle-switch`) beside the app's own (`session-card`) | `components/` |

```sh
npm install
npm run dev        # edits to components/ rebuild through the loader
npm run build && npm start
npm test           # builds, starts, and drives it in Chromium
```

Inside this repository, the mnx compiler comes from `MNX_COMPILER` (the CLI from `cargo build`) or a built `compiler/mnx.wasm`. `.npmrc` installs the repository's packages as copies (`install-links`), as they'd come from npm. Next won't resolve a symlinked package outside the app.

## What this app found

These are recorded in the project's server roadmap (`plan/roadmap-server.md`).

- **The components are shadow DOM here.** Next server-renders each element's host tag, and the browser defines the elements before React hydrates. A light-DOM element then renders its template into the host, React finds children it didn't render, reports a hydration error (#418), and re-renders the page from scratch. Shadow-DOM elements render into their shadow root, which React doesn't look at, so they hydrate cleanly. Making light DOM work under framework hydration is on the roadmap.
- **The element's own markup isn't in the server HTML.** React renders the host tag (`<session-card>`, with its props as `mnx-props` since 2.8) on the server, and the card's template appears once the element starts. In React Router, Nuxt, SvelteKit and SolidStart, `@mnx/server` adds the shadow roots to the page (2.8). Next streams React Server Components and has no hook for transforming its HTML, so that's still open here.
- **Fixed while building it:** library mode's React entry now starts with `'use client'`, so it can be imported from a Server Component. The runtime no longer reports an empty URL (a prop's `""` default, before the app sets it) as unsafe.
