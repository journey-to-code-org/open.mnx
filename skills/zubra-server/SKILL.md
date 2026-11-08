---
name: zubra-server
description: Render Zubra components on a server. Use when adding components to an Express, Fastify, Hono, Flask, Rails, Eleventy or other server-rendered page, when a meta-framework (Nuxt, SvelteKit, React Router, SolidStart, Next.js) needs the elements' markup before JavaScript, or when a page must work without JavaScript.
---

Zubra renders components without a DOM on the server: the compiler emits the HTML, the element hydrates it in place. Which path depends on the server.

## Steps

1. **Pick the path** from the table. Done when the server's HTML contains the component's rendered markup (not an empty host tag), the browser logs no hydration warning, and the page's forms submit with JavaScript off.
2. **Keep components in the server's subset** for what must be in the HTML: props, arithmetic, ternaries, template literals, arrow functions defined in the script (not `function` declarations), string/array methods, `Math` (not `random`), `Object.keys/values/entries`. `Date`, `Intl`, `window`, `navigator` are browser-only; `zubra check --server <file>` names each such part. Move them into `onMount` or behind `hydrated()`.
3. **Inside a hydrating framework, an element given framework children must be `shadow`**, and so must every component under SvelteKit; a light-DOM element with no framework children works under Next.js, React Router, Nuxt and SolidStart (the wrappers, or `injectShadowRoots` with `lightDom: true` for Solid, render its content and keep the framework out of the host).

| Server | Path |
|---|---|
| Express, Fastify, Hono, Eleventy, any Node template engine | `@zubra/server`: `createZubra({ components })`, then per request `page.render(tag, props, slots)` and `page.finish(html)`, which adds the components' CSS and modules. `zubra.handle(req, res)` or `zubra.fetch(request)` serves `/_zubra/…`. Adapters: `@zubra/server/express`, `/fastify`, `/hono`. |
| Node without a framework, Bun, scripts | `render(path, { props, slots })` from `@zubra/compiler` returns `{ html, css }`. |
| Flask, Rails, Go, PHP, anything that isn't Node | One long-lived `zubra serve` process; a JSON line per render (the request format is in the `zubra-cli` skill). Serve the compiled modules and `@zubra/runtime` statically. `examples/backends/flask-garden/` is the pattern. |
| Astro | `@zubra/unplugin/astro`; components render on the server and `client:load` hydrates. |
| Nuxt, React Router, Next.js | The React and Vue wrappers render each element's content into its host on the server (light or shadow DOM) for elements with no framework children, and leave it alone while hydrating; nothing to add. Next.js needs `@zubra/unplugin/loader` with a server rule (`condition: { not: 'browser' }, options: { server: true }`) and `serverExternalPackages: ['@zubra/compiler']`. Elements given framework children must be `shadow` and go through `injectShadowRoots` (below), or draw in the browser under Next.js. |
| SvelteKit, SolidStart | The framework renders only the host tag. Pass the page's HTML through `zubra.injectShadowRoots(html)` (or `injectShadowRootsStream()`) from `@zubra/server` in the framework's HTML hook: SvelteKit `handle`'s `transformPageChunk`, a middleware in SolidStart (with `{ lightDom: true }`: Solid tolerates light-DOM children). Components under SvelteKit must be `shadow`. The plugin writes `zb-props` on each host so the element starts with its props. |

## Streaming slow data

Give a prop as a promise: `page.render('reviews', { items: fetchReviews() })`. The component's `<zb-await value={items}>` renders its pending content; `page.stream(html).pipe(res)` (Express/Node) or `return page.streamResponse(html)` (Hono) sends the page, then the resolved region when the promise settles, hydrated by the element. Without JavaScript the pending content stays, so stream only what the page can show late.

## Without JavaScript

- Light-DOM components keep native inputs, links and forms in the page, so they work as they are.
- `<select value>` and `<textarea value>` render the chosen value.
- Under the bridge, a `form-associated` component with a `name` gets a hidden input with its server value, so the form submits; the user can't edit that value before hydration.
- `hydrated()` and `:state(hydrated)` show a fallback (an Apply button) only until the element is live.

## Hydration markers

The server HTML carries processing-instruction markers (`<?zb [?>`, `<?zb ]?>`, `<?zb ?>`). Minifiers (with `removeComments`), htmx and the HTML parser keep them, so there's nothing to configure. A sanitizer that drops them makes the element restore them by structure (slower, one warning for `zb-await` and projected content). Markup from a 4.x server has comment markers (`<!--[-->`) instead: keep those with `ignoreCustomComments: [ZUBRA_MARKER_COMMENT]` (from `@zubra/compiler`) in html-minifier-terser.

## Reference

https://github.com/journey-to-code-org/zubra/blob/main/docs/server-rendering.md (the honest account, with the gaps), https://github.com/journey-to-code-org/zubra#server-rendering-and-hydration, and in the repository `server/src/index.js`, `examples/helpdesk/`, `examples/meta/README.md`.
