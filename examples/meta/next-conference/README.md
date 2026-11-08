# WebConf: Next.js with Zubra components

![Conference schedule](../../../demos/shots/next-conference.jpg)

This one needs a server, so it isn't in the [live demos](https://journey-to-code-org.github.io/zubra/); the commands below run it.

A conference schedule. Filter the talks by track, star the ones you want (kept in `localStorage`), and rate a talk afterwards through a form handled by a **Server Action**.

Next.js 16 builds with Turbopack, which takes webpack-style loaders but not bundler plugins. `next.config.mjs` gives `.zb` files Zubra's loader (`@zubra/unplugin/loader`), and the app imports components directly, as React (client) components:

```jsx
'use client';
import SessionCard from '../components/session-card.zb';
```

(A component package built with `zubra build --lib` works too: its React entry starts with `'use client'`, so a Server Component can import it.)

| What | Where |
|---|---|
| A Server Component reading data, passing it to a client component that uses Zubra elements | `app/page.jsx` → `app/Schedule.jsx` |
| Two-way props as React state (`value` + `onValueChange`, `starred` + `onStarredChange`) | `app/Schedule.jsx` |
| Zubra **form controls** in a Server Action form: `star-rating` and `toggle-switch` are form-associated, so `rating` and `followup` arrive in `FormData`, and `required` stops the submission like a native input | `app/sessions/[id]/FeedbackForm.jsx`, `app/actions.js` |
| Components from the registry (`zubra add segmented-control star-rating toggle-switch`) beside the app's own (`session-card`) | `components/` |

```sh
npm install
npm run dev        # edits to components/ rebuild through the loader
npm run build && npm start
npm test           # builds, starts, and drives it in Chromium
```

Inside this repository, the Zubra compiler comes from `ZUBRA_COMPILER` (the CLI from `cargo build`) or a built `compiler/zubra.wasm`. `.npmrc` installs the repository's packages as copies (`install-links`), as they'd come from npm. Next won't resolve a symlinked package outside the app.

## What this app found

These are recorded in the project's server roadmap (`plan/roadmap-server.md`).

- **The session card is light DOM, and React keeps out of it.** Next server-renders each element's host tag, and the browser defines the elements before React hydrates. A light-DOM element that rendered its template into the host first would leave React children it didn't render: React would report a hydration error (#418) and re-render the page from scratch. The React wrapper prevents that for an element given no React children: it writes the element's content as the host's inner HTML, which React doesn't hydrate. The registry's controls are shadow DOM; an element given React children has to be.
- **Next has no hook for its HTML.** React renders the host tag (`<session-card>`, with its props as `zb-props`). In React Router, Nuxt, SvelteKit and SolidStart, `@zubra/server` adds the elements' content to the page, but Next streams React Server Components. So:
  - the loader's server build (`next.config.mjs`, `options: { server: true }`) registers how to render each component;
  - the React wrapper writes a childless element's content (a shadow-DOM element's declarative shadow root, a light-DOM element's rendered children) as the host's inner HTML.

  The test checks the cards without JavaScript, and that the elements keep the parser's nodes when they start.
- **A declarative shadow root can't be a React child.** A `<template shadowrootmode>` as a React *child* breaks hydration: the parser turns it into a shadow root, React finds a different child, reports #418 and re-renders the page, and a template React creates is never a shadow root. As the host's inner HTML (an empty string in the browser, with `suppressHydrationWarning`), it's clean in `next dev` and in production.
