---
name: mnx-server
description: Render mnx components on a server. Use when adding components to an Express, Fastify, Hono, Flask, Rails, Eleventy or other server-rendered page, when a meta-framework (Nuxt, SvelteKit, React Router, SolidStart, Next.js) needs the elements' markup before JavaScript, or when a page must work without JavaScript.
---

mnx renders components without a DOM on the server: the compiler emits the HTML, the element hydrates it in place. Which path depends on the server.

## Steps

1. **Pick the path** from the table. Done when the server's HTML contains the component's rendered markup (not an empty host tag), the browser logs no hydration warning, and the page's forms submit with JavaScript off.
2. **Keep components in the server's subset** for what must be in the HTML: props, arithmetic, ternaries, template literals, string/array methods, `Math` (not `random`), `Object.keys/values/entries`. `Date`, `Intl`, `window`, `navigator` are browser-only; `mnx check --server <file>` names each such part. Move them into `onMount` or behind `hydrated()`.
3. **Inside a hydrating framework, make the component `shadow`**, or the framework's hydration will remove or re-render what the element drew. Light DOM is right everywhere else.

| Server | Path |
|---|---|
| Express, Fastify, Hono, any Node template engine | `@mnx/server`: `createMnx({ components })`, then per request `page.render(tag, props, slots)` and `page.finish(html)`, which adds the components' CSS and modules. `mnx.handle(req, res)` or `mnx.fetch(request)` serves `/_mnx/…`. Adapters: `@mnx/server/express`, `/fastify`, `/hono`. |
| Node without a framework, Bun, scripts | `render(path, { props, slots })` from `@mnx/compiler` returns `{ html, css }`. |
| Flask, Rails, Go, PHP, Eleventy, anything that isn't Node | One long-lived `mnx serve` process; a JSON line per render (the request format is in the `mnx-cli` skill). Serve the compiled modules and `@mnx/runtime` statically. `examples/backends/flask-garden/` is the pattern. |
| Astro | `@mnx/unplugin/astro`; components render on the server and `client:load` hydrates. |
| Nuxt, SvelteKit, React Router, SolidStart | The framework renders only the host tag. Pass the page's HTML through `mnx.injectShadowRoots(html)` (or `injectShadowRootsStream()`) from `@mnx/server` in the framework's HTML hook: SvelteKit `handle`'s `transformPageChunk`, a Nitro plugin on `render:html` (Nuxt, SolidStart), React Router's `entry.server`. Each is in `examples/meta/`. Components must be `shadow`. The plugin writes `mnx-props` on each host so the element starts with its props. |
| Next.js | `@mnx/unplugin/loader` with a server rule (`condition: { not: 'browser' }, options: { server: true }`) and `serverExternalPackages: ['@mnx/compiler']`. Shadow-DOM elements without React children render on the server; others draw in the browser. |

## Without JavaScript

- Light-DOM components keep native inputs, links and forms in the page, so they work as they are.
- `<select value>` and `<textarea value>` render the chosen value.
- Under the bridge, a `form-associated` component with a `name` gets a hidden input with its server value, so the form submits; the user can't edit that value before hydration.
- `hydrated()` and `:state(hydrated)` show a fallback (an Apply button) only until the element is live.

## Hydration markers

The server HTML carries comment markers (`<!--[-->`). A minifier with `removeComments`, or htmx in some Chromium versions, strips them; the element then restores them by structure (slower, one warning for `mnx-await` and projected content). Keep them with `ignoreCustomComments: [MNX_MARKER_COMMENT]` (from `@mnx/compiler`) in html-minifier-terser.

## Reference

https://github.com/journey-to-code-org/open.mnx/blob/main/docs/server-rendering.md (the honest account, with the gaps), https://github.com/journey-to-code-org/open.mnx#server-rendering-and-hydration, and in the repository `server/src/index.js`, `examples/helpdesk/`, `examples/meta/README.md`.
