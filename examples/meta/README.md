# mnx in meta-frameworks

Six apps, each a complete idea in a framework that renders on the server (or at build time), and each driven through in Chromium by its own `npm test`:

| App | Framework | What it is | How mnx is used |
|---|---|---|---|
| [`next-conference/`](next-conference/) | Next.js 16 (App Router, Turbopack) | A conference schedule with starred talks and feedback | **Library mode** (Turbopack takes no bundler plugins): `mnx build --lib`, imported as React components. Form-associated elements in a **Server Action** form. |
| [`nuxt-bookshop/`](nuxt-bookshop/) | Nuxt 4 | A bookshop's inventory, with Nitro API routes | The **Vite plugin**: `.mnx` imports are Vue components, with `v-model` on four kinds of control. |
| [`sveltekit-workouts/`](sveltekit-workouts/) | SvelteKit 3 | A workout log | The **Vite plugin**: elements used directly in Svelte, as form controls in a **form action** with `use:enhance`. |
| [`react-router-trips/`](react-router-trips/) | React Router 8 (framework mode) | A shared trip budget | The **Vite plugin** (`framework: 'react'`): `.mnx` imports are React components, as form controls in `<Form>` with a server `action`. |
| [`solidstart-potluck/`](solidstart-potluck/) | SolidStart 2 | A potluck sign-up | The **Vite plugin**: elements used directly in Solid (`prop:`, `on:`), as form controls posting to a server `action`. |
| [`eleventy-trails/`](eleventy-trails/) | Eleventy 3 | A static trail guide | A **shortcode** renders components at build time; a transform adds their CSS and modules. No bundler. Built plain and minified. |

Each app has its own `package.json` and installs the repository's packages as copies (`.npmrc`: `install-links`), as an app would get them from npm.

## What they found

Each app's README has the details, and the project's server roadmap (`plan/roadmap-server.md`) has the plan. In short:

1. **Light-DOM components conflict with framework hydration.** The frameworks render the host tag on the server, and the browser defines the elements before the framework hydrates. A light-DOM element then renders into its host, and the framework finds children it didn't put there:
   - React re-renders the page (error #418);
   - Vue deletes the element's template;
   - Svelte fails and leaves a blank page.

   Solid is the exception: it claims only the nodes it marked, so light DOM hydrates cleanly
   there (`solidstart-potluck/`). The apps use shadow DOM components, which hydrate cleanly in
   every framework.
2. **The elements' own markup isn't in the server HTML.** Each framework (React Router and SolidStart too) renders only the host tag. So without JavaScript the elements are empty, and form-associated controls can't submit: each app's no-JavaScript test shows the action refusing the form.
3. **Comment-stripping breaks hydration markers.** An HTML minifier with `removeComments` deletes mnx's markers. The elements still come out right (they render afresh), but each logs a warning and in-place hydration is lost. `eleventy-trails/` shows the one-line fix for html-minifier-terser. (htmx hit the same thing in `../hypermedia/`.)
4. **Plugin detection missed React Router** (fixed in 2.7). It looked only for `@vitejs/plugin-react`. The plugin now recognises React Router, and warns when a light-DOM component is server-rendered there, in Nuxt or in SvelteKit.
5. **Small things, fixed while building them:**
   - library mode's React entry now has `'use client'` (Next.js);
   - an empty URL prop no longer logs an error (a prop's `""` default, before the app sets it);
   - an object prop that a framework wrote as `"[object Object]"` is no longer reported as invalid JSON (Svelte).
