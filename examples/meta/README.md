# Zubra in meta-frameworks

Six apps, each a complete idea in a framework that renders on the server (or at build time), and each driven through in Chromium by its own `npm test`:

| App | Framework | What it is | How Zubra is used |
|---|---|---|---|
| [`next-conference/`](next-conference/) | Next.js 16 (App Router, Turbopack) | A conference schedule with starred talks and feedback | **The Turbopack loader** (`@zubra/unplugin/loader`): `.zb` imports are React components; its server build renders each element's content into the page. Form-associated elements in a **Server Action** form. |
| [`nuxt-bookshop/`](nuxt-bookshop/) | Nuxt 4 | A bookshop's inventory, with Nitro API routes | The **Vite plugin**: `.zb` imports are Vue components, with `v-model` on four kinds of control. `@zubra/server` adds the shadow roots in a Nitro plugin. |
| [`sveltekit-workouts/`](sveltekit-workouts/) | SvelteKit 3 | A workout log | The **Vite plugin**: elements used directly in Svelte, as form controls in a **form action** with `use:enhance`. `@zubra/server` adds the shadow roots in `hooks.server.js`. |
| [`react-router-trips/`](react-router-trips/) | React Router 8 (framework mode) | A shared trip budget | The **Vite plugin** : `.zb` imports are React components, as form controls in `<Form>` with a server `action`. `@zubra/server` adds the shadow roots to the stream in `entry.server.jsx`. |
| [`solidstart-potluck/`](solidstart-potluck/) | SolidStart 2 | A potluck sign-up | The **Vite plugin**: elements used directly in Solid (`prop:`, `on:`), as form controls posting to a server `action`. `@zubra/server` adds the shadow roots in middleware. |
| [`eleventy-trails/`](eleventy-trails/) | Eleventy 3 | A static trail guide | A **shortcode** renders components at build time with `@zubra/server`; a transform adds their CSS and modules. No bundler. Built plain and minified. |

Each app has its own `package.json` and installs the repository's packages as copies (`.npmrc`: `install-links`), as an app would get them from npm.

## What they found

Each app's README has the details, and the project's server roadmap (`plan/roadmap-server.md`) has the plan. In short:

1. **Light DOM meets framework hydration.** The frameworks render the host tag on the server, and the browser defines the elements before the framework hydrates. A light-DOM element that renders into its host leaves the framework children it didn't put there:
   - React re-renders the page (error #418);
   - Vue deletes the element's template;
   - Svelte fails and leaves a blank page.

   Solid is the exception: it claims only the nodes it marked, so light DOM hydrates cleanly
   there (`solidstart-potluck/`).

   The React and Vue wrappers avoid this for an element given no framework children. They
   server-render a light-DOM element's content as the host's inner HTML and keep the framework
   out of the host while hydrating (React: `dangerouslySetInnerHTML` with an empty string in the
   browser and `suppressHydrationWarning`; Vue: a vnode with no children at all), so the element
   hydrates its markup in place. `react-router-trips/`'s balance list, `nuxt-bookshop/`'s stock
   meter and `next-conference/`'s session card are light DOM, with page CSS reaching in. An
   element given children from React or Vue (slot content) has to be `shadow`, and so does every
   component under SvelteKit, which uses elements directly. The plugin says which.
2. **Frameworks render only the host tag on the server.** Left at that, the elements would be empty without JavaScript, and form-associated controls couldn't submit. `@zubra/server`'s `injectShadowRoots` renders each host's shadow root into the page (`<template shadowrootmode>`), from its `zb-props` attribute, and a hidden input stands in for each named form control until its element starts. Each app's no-JavaScript test submits the form.
   - React and Vue wrappers write `zb-props` themselves; in Svelte and Solid the Zubra plugin adds it in the server build.
   - Next.js streams Server Components and has no hook for its HTML: there the React wrapper writes a childless element's content itself, from the loader's server build.
   - Svelte writes an object prop as `"[object Object]"` in its server HTML. The runtime treats that as not given yet, and Svelte sets the real object once it runs.
   - A text field's edits can't be submitted before JavaScript (the hidden input carries the server's value).
   - A component that needs `Date` or `Intl` (the workout streak grid) is left for the browser.
3. **Minifiers and fragment parsers keep the hydration markers.** They're processing instructions (`<?zb [?>`), which an HTML minifier's `removeComments` keeps: `eleventy-trails/` is also built minified, with nothing to configure. (htmx's fragment parser keeps them too, in `../hypermedia/`.) If something strips them anyway, an element puts them back by structure where it can and hydrates in place.
