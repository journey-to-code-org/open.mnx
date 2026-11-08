# Server rendering, honestly

"Server-side rendering isn't great with web components" is the objection people give most often, and it has been true of most web-component tooling. This page says exactly what Zubra renders on the server, where, with what, and where it still falls short. The README's [Server rendering and hydration](../README.md#server-rendering-and-hydration) section is the reference; this is the plain account.

## What's different

Most web-component SSR emulates a DOM on the server, runs the element's class against it, and serializes the result. Zubra doesn't run the element on the server at all. The compiler holds the template and the script, so it renders the HTML itself: in Rust (the CLI, `zubra serve`), in WebAssembly (`@zubra/compiler` on Node, Bun, or anything else that runs wasm), or through `@zubra/server`. There is no DOM emulation, no `jsdom`, no element registry on the server.

The element then hydrates that HTML in the browser: it finds its template's parts in the existing markup by the hydration markers (or, if a minifier stripped them, by structure) and binds to them. Nothing is re-rendered, and a part writes only when its value differs from what the server sent.

## What renders where

| Server | How it renders | What it can evaluate |
|---|---|---|
| **The Rust CLI** (`zubra compile`, `zubra serve`), so Flask, Rails, Go, PHP, Eleventy, any server at all | Native | Everything in the deterministic subset (below) |
| **`@zubra/compiler`** on Node or Bun (`render()`), **`@zubra/server`** (Express, Fastify, Hono, or any engine) | The same compiler, as WebAssembly | The same subset, so Flask and Node produce byte-identical HTML |
| **Astro** (`@zubra/unplugin/astro`) | Components render on the server; a client directive hydrates them | The same |
| **Nuxt, React Router, Next.js** | The React and Vue wrappers write the element's content into the host on the server (light DOM: its rendered children; shadow DOM: a declarative shadow root) and keep the framework out of the host while hydrating; `@zubra/server`'s `injectShadowRoots()` is the alternative for shadow DOM where the page has an HTML hook | The same |
| **SvelteKit, SolidStart** | The framework renders the host tag; `@zubra/server`'s `injectShadowRoots()` fills it (shadow roots; with `lightDom: true` under Solid, light-DOM children too), before the framework's hydration runs | The same |

### The deterministic subset

The server evaluates the component's JavaScript where the answer is the same everywhere: literals, props, member access, arithmetic, comparisons, logic, ternaries, template literals; arrow functions and callbacks; string, array and number methods (`.includes`, `.map`, `.filter`, `.reduce`, `.join`, `.slice`, `.toFixed`, `.toSorted`, …); `Math` except `random`; `Number()`, `String()`, `Object.keys/values/entries`. `compiler/test/server-evaluation.test.js` runs every supported expression in V8 and checks the compiler agrees.

What it doesn't evaluate: anything non-deterministic (`Date`, `Intl`, `Math.random()`, `toLocaleString()`), anything that needs the browser (`window`, `document`, `navigator`), and anything outside the subset. Those parts are left to the element: text renders empty, attributes are left out, and conditionals and lists become empty `<?zb [??>` regions that the element fills when it starts. `zubra check --server` lists them per component, and makes it an error when the missing part is `checked`, `selected`, `value` or `disabled`, because a form without JavaScript would then submit the wrong thing.

## What works without JavaScript

- The markup, in every server above.
- Links, native inputs and forms inside a light-DOM component: they are real page elements.
- `<select value>` and `<textarea value>` show the server's value.
- A form-associated component with a `name`, under the SSR bridge: a hidden input carries its server-rendered value, so the form submits correctly. A user can't *edit* that value without JavaScript (the hidden input holds what the server sent), so choices, steppers and selects work, and a typed text field doesn't.
- `hydrated()` and `:state(hydrated)` let the markup show a no-JavaScript fallback (an Apply button) that disappears once the element is live.

## Where it still falls short

These are the honest gaps as of 3.3, each on the roadmap:

1. **Light DOM inside a hydrating framework, for an element given framework children.** Since 3.3 a light-DOM element with *no* React or Vue children works under Next.js, React Router and Nuxt: the wrapper server-renders its content as the host's inner HTML and keeps the framework out of the host while hydrating, so the element hydrates in place and page CSS reaches in. SolidStart works through `injectShadowRoots(html, { lightDom: true })`, since Solid leaves nodes it didn't render alone. What's left: an element whose slot content is React or Vue nodes must still be `shadow` (React would re-render the page, Vue would remove the element's nodes), and so must every component under SvelteKit, which uses elements directly and claims every node. `@zubra/unplugin` says which.
2. **Next.js elements given React children.** An element whose slot content is React nodes can't also carry server-rendered content: React's `dangerouslySetInnerHTML` and children are exclusive, and a declarative shadow root as a React child breaks hydration (the parser turns it into a shadow root, so React's first child is gone). Those elements render in the browser. This needs React to understand declarative shadow DOM, which it doesn't yet; it isn't something Zubra can fix from its side, so it stays documented rather than planned.
3. **Streaming is for slow data, not for pages that must work without JavaScript.** Since 3.3, `@zubra/server` streams: a prop given as a promise renders as pending (the component's `zb-await` shows its pending content), and `page.stream(html)` sends the page first and the resolved region as the promise settles, swapped in by a short inline script and hydrated by the element. Without JavaScript the pending content stays, so a page that has to be complete without it should await the data before rendering, as before.
4. **`Date` and `Intl` components are browser-only** on the server, by design: formatting a date on the server and the client can disagree, and a hydration mismatch is worse than an empty region. `zubra check --server` names them.

## What this means in practice

- **A plain server** (any language) gets complete, correct HTML for every component in the subset, with hydration that keeps focus and input state. This is the case Zubra was built for, and it's the smoothest.
- **A meta-framework** gets complete HTML through the bridge, with light or shadow DOM for elements without framework children (3.3) and shadow DOM for the rest. It works in every one in CI (`examples/meta/`, each with a no-JavaScript test).
- **Compared with a framework's own SSR**, Next.js or Nuxt rendering their own components is still smoother: no bridge, no `shadow` flag for an element with children, and the framework's own streaming. Zubra's server story is complete for leaf components and plain servers, and close to it inside frameworks.
