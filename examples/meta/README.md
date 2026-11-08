# Zubra in meta-frameworks

Six apps, each a complete idea in a framework that renders on the server (or at build time), and each driven through in Chromium by its own `npm test`:

| App | Framework | What it is | How Zubra is used |
|---|---|---|---|
| [`next-conference/`](next-conference/) | Next.js 16 (App Router, Turbopack) | A conference schedule with starred talks and feedback | **The Turbopack loader** (`@zubra/unplugin/loader`, 2.8): `.zb` imports are React components; its server build renders the shadow roots (2.11). Form-associated elements in a **Server Action** form. |
| [`nuxt-bookshop/`](nuxt-bookshop/) | Nuxt 4 | A bookshop's inventory, with Nitro API routes | The **Vite plugin**: `.zb` imports are Vue components, with `v-model` on four kinds of control. `@zubra/server` adds the shadow roots in a Nitro plugin. |
| [`sveltekit-workouts/`](sveltekit-workouts/) | SvelteKit 3 | A workout log | The **Vite plugin**: elements used directly in Svelte, as form controls in a **form action** with `use:enhance`. `@zubra/server` adds the shadow roots in `hooks.server.js`. |
| [`react-router-trips/`](react-router-trips/) | React Router 8 (framework mode) | A shared trip budget | The **Vite plugin** : `.zb` imports are React components, as form controls in `<Form>` with a server `action`. `@zubra/server` adds the shadow roots to the stream in `entry.server.jsx`. |
| [`solidstart-potluck/`](solidstart-potluck/) | SolidStart 2 | A potluck sign-up | The **Vite plugin**: elements used directly in Solid (`prop:`, `on:`), as form controls posting to a server `action`. `@zubra/server` adds the shadow roots in middleware. |
| [`eleventy-trails/`](eleventy-trails/) | Eleventy 3 | A static trail guide | A **shortcode** renders components at build time with `@zubra/server`; a transform adds their CSS and modules. No bundler. Built plain and minified. |

Each app has its own `package.json` and installs the repository's packages as copies (`.npmrc`: `install-links`), as an app would get them from npm.

## What they found

Each app's README has the details, and the project's server roadmap (`plan/roadmap-server.md`) has the plan. In short:

1. **Light-DOM components conflict with framework hydration.** The frameworks render the host tag on the server, and the browser defines the elements before the framework hydrates. A light-DOM element then renders into its host, and the framework finds children it didn't put there:
   - React re-renders the page (error #418);
   - Vue deletes the element's template;
   - Svelte fails and leaves a blank page.

   Solid is the exception: it claims only the nodes it marked, so light DOM hydrates cleanly
   there (`solidstart-potluck/`).

   **Fixed in 3.3 for React and Vue, for an element given no framework children.** The React and
   Vue wrappers now server-render a light-DOM element's content as the host's inner HTML and keep
   the framework out of the host while hydrating (React: `dangerouslySetInnerHTML` with an empty
   string in the browser and `suppressHydrationWarning`; Vue: a vnode with no children at all), so
   the element hydrates its markup in place. `react-router-trips/`'s balance list,
   `nuxt-bookshop/`'s stock meter and `next-conference/`'s session card are light DOM, with page
   CSS reaching in. An element given children from React or Vue (slot content) still has to be
   `shadow`, and so does every component under SvelteKit, which uses elements directly. The plugin
   says which.
2. **The elements' own markup wasn't in the server HTML** (fixed in 2.8, and for Next.js in 2.11). Each framework renders only the host tag, so without JavaScript the elements were empty, and form-associated controls couldn't submit. Now `@zubra/server`'s `injectShadowRoots` renders each host's shadow root into the page (`<template shadowrootmode>`), from its `zb-props` attribute, and a hidden input stands in for each named form control until its element starts. Each app's no-JavaScript test now submits the form.
   - React and Vue adapters write `zb-props` themselves; in Svelte and Solid the Zubra plugin adds it in the server build (since 2.10; the apps wrote it by hand in 2.8 and 2.9).
   - Next.js streams Server Components and has no hook for its HTML: there the React wrapper writes a childless shadow-DOM element's shadow root itself, from the loader's server build (2.11).
   - A text field's edits can't be submitted before JavaScript (the hidden input carries the server's value).
   - A component that needs `Date` or `Intl` (the workout streak grid) is left for the browser.
3. **Comment-stripping broke hydration markers** (fixed in 2.10). An HTML minifier with `removeComments` deletes Zubra's markers. The elements came out right (they rendered afresh), but each logged a warning and in-place hydration was lost. Since 2.10 they put the markers back by structure and hydrate in place. `eleventy-trails/` still shows the one-line way to keep them for html-minifier-terser. (htmx hit the same thing in `../hypermedia/`.)
4. **Plugin detection missed React Router** (fixed in 2.7). It looked only for `@vitejs/plugin-react`. The plugin now recognises React Router, and warns about a light-DOM component server-rendered there, in Nuxt or in SvelteKit (since 3.3, as an error-in-waiting for SvelteKit and as a note about children for the others).
5. **Small things, fixed while building them:**
   - library mode's React entry now has `'use client'` (Next.js);
   - an empty URL prop no longer logs an error (a prop's `""` default, before the app sets it);
   - an object prop that a framework wrote as `"[object Object]"` is no longer reported as invalid JSON (Svelte).
