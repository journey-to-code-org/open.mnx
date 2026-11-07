# Server rendering, honestly

"Server-side rendering isn't great with web components" is the objection people give most often, and it has been true of most web-component tooling. This page says exactly what mnx renders on the server, where, with what, and where it still falls short. The README's [Server rendering and hydration](../README.md#server-rendering-and-hydration) section is the reference; this is the plain account.

## What's different

Most web-component SSR emulates a DOM on the server, runs the element's class against it, and serializes the result. mnx doesn't run the element on the server at all. The compiler holds the template and the script, so it renders the HTML itself: in Rust (the CLI, `mnx serve`), in WebAssembly (`@mnx/compiler` on Node, Bun, or anything else that runs wasm), or through `@mnx/server`. There is no DOM emulation, no `jsdom`, no element registry on the server.

The element then hydrates that HTML in the browser: it finds its template's parts in the existing markup by the hydration markers (or, if a minifier stripped them, by structure) and binds to them. Nothing is re-rendered, and a part writes only when its value differs from what the server sent.

## What renders where

| Server | How it renders | What it can evaluate |
|---|---|---|
| **The Rust CLI** (`mnx compile`, `mnx serve`), so Flask, Rails, Go, PHP, Eleventy, any server at all | Native | Everything in the deterministic subset (below) |
| **`@mnx/compiler`** on Node or Bun (`render()`), **`@mnx/server`** (Express, Fastify, Hono, or any engine) | The same compiler, as WebAssembly | The same subset, so Flask and Node produce byte-identical HTML |
| **Astro** (`@mnx/unplugin/astro`) | Components render on the server; a client directive hydrates them | The same |
| **Nuxt, SvelteKit, React Router, SolidStart** | The framework renders the host tag; `@mnx/server`'s `injectShadowRoots()` fills it with the server-rendered template as a declarative shadow root, before the framework's hydration runs | The same |
| **Next.js** | No HTML hook, so the React wrapper writes the shadow root itself in the server build, for elements with no React children | The same |

### The deterministic subset

The server evaluates the component's JavaScript where the answer is the same everywhere: literals, props, member access, arithmetic, comparisons, logic, ternaries, template literals; arrow functions and callbacks; string, array and number methods (`.includes`, `.map`, `.filter`, `.reduce`, `.join`, `.slice`, `.toFixed`, `.toSorted`, …); `Math` except `random`; `Number()`, `String()`, `Object.keys/values/entries`. `compiler/test/server-evaluation.test.js` runs every supported expression in V8 and checks the compiler agrees.

What it doesn't evaluate: anything non-deterministic (`Date`, `Intl`, `Math.random()`, `toLocaleString()`), anything that needs the browser (`window`, `document`, `navigator`), and anything outside the subset. Those parts are left to the element: text renders empty, attributes are left out, and conditionals and lists become empty `<!--[?-->` regions that the element fills when it starts. `mnx check --server` lists them per component, and makes it an error when the missing part is `checked`, `selected`, `value` or `disabled`, because a form without JavaScript would then submit the wrong thing.

## What works without JavaScript

- The markup, in every server above.
- Links, native inputs and forms inside a light-DOM component: they are real page elements.
- `<select value>` and `<textarea value>` show the server's value.
- A form-associated component with a `name`, under the SSR bridge: a hidden input carries its server-rendered value, so the form submits correctly. A user can't *edit* that value without JavaScript (the hidden input holds what the server sent), so choices, steppers and selects work, and a typed text field doesn't.
- `hydrated()` and `:state(hydrated)` let the markup show a no-JavaScript fallback (an Apply button) that disappears once the element is live.

## Where it still falls short

These are the honest gaps as of 3.1, each on the roadmap:

1. **Light DOM inside a hydrating framework.** A light-DOM component renders its template into its host before React, Vue or Svelte hydrate the page, and the framework then finds children it didn't render: React re-renders the page, Vue removes the children, Svelte fails. In Nuxt, SvelteKit, React Router and Next.js, server-rendered mnx components must be `shadow`, and `@mnx/unplugin` warns if they aren't. Solid and Astro don't mind. Plain servers, Flask, Hono, Eleventy and htmx are fine with light DOM, which is why it stays the default.
2. **Next.js elements given React children.** An element whose slot content is React nodes can't also carry a server-rendered shadow root under Next.js, because React hydrates the children. Those elements render in the browser.
3. **No streaming.** The server sends a complete page. `<mnx-await>` lets a page render its shell with pending regions, but resolved content is not streamed in afterwards.
4. **`Date` and `Intl` components are browser-only** on the server, by design: formatting a date on the server and the client can disagree, and a hydration mismatch is worse than an empty region. `mnx check --server` names them.

## What this means in practice

- **A plain server** (any language) gets complete, correct HTML for every component in the subset, with hydration that keeps focus and input state. This is the case mnx was built for, and it's the smoothest.
- **A meta-framework** gets complete HTML through the bridge, with shadow DOM. It works in every one in CI (`examples/meta/`, each with a no-JavaScript test), and it's one `shadow` flag away from the plain-server experience, which is the gap above.
- **Compared with a framework's own SSR**, Next.js or Nuxt rendering their own components is still smoother: no bridge, no shadow-DOM requirement, streaming. mnx's server story is complete for leaf components and plain servers, and good inside frameworks; it isn't yet invisible there.
