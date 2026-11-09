# Server rendering, honestly

"Server-side rendering isn't great with web components" is the objection people give most often, and it has been true of most web-component tooling. This page says exactly what Zubra renders on the server, where, with what, and where it still falls short. The README's [Server rendering and hydration](../README.md#server-rendering-and-hydration) section is the reference; this is the plain account.

## What's different

Most web-component SSR emulates a DOM on the server, runs the element's class against it, and serializes the result. Zubra doesn't run the element on the server at all. The compiler holds the template and the script, so it renders the HTML itself: in Rust (the CLI, `zubra serve`), in WebAssembly (`@zubra/compiler` on Node, Bun, or anything else that runs wasm), or through `@zubra/server`. There is no DOM emulation, no `jsdom`, no element registry on the server.

The element then hydrates that HTML in the browser: it finds its template's parts in the existing markup by the hydration markers (or, if a minifier stripped them, by structure) and binds to them. Nothing is re-rendered, and a part writes only when its value differs from what the server sent.

## What renders where

| Server | How it renders | What it can evaluate |
|---|---|---|
| **The Rust CLI** (`zubra compile`, `zubra serve`), so Flask, Rails, Go, PHP, any server at all | Native | Everything in the deterministic subset (below) |
| **`@zubra/compiler`** on Node or Bun (`render()`), **`@zubra/server`** (Express, Fastify, Hono, Eleventy, or any engine) | The same compiler, as WebAssembly | The same subset, so Flask and Node produce byte-identical HTML |
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

These are the honest gaps:

1. **Light DOM inside a hydrating framework, for an element given framework children.** A light-DOM element with *no* React or Vue children works under Next.js, React Router and Nuxt: the wrapper server-renders its content as the host's inner HTML and keeps the framework out of the host while hydrating, so the element hydrates in place and page CSS reaches in. SolidStart works through `injectShadowRoots(html, { lightDom: true })`, since Solid leaves nodes it didn't render alone. What's left: an element whose slot content is React or Vue nodes must still be `shadow` (React would re-render the page, Vue would remove the element's nodes), and so must every component under SvelteKit, which uses elements directly and claims every node. `@zubra/unplugin` says which.
2. **Next.js elements given React children.** An element whose slot content is React nodes can't also carry server-rendered content: React's `dangerouslySetInnerHTML` and children are exclusive, and a declarative shadow root as a React child breaks hydration (the parser turns it into a shadow root, so React's first child is gone). Those elements render in the browser. This needs React to understand declarative shadow DOM, which it doesn't yet; it isn't something Zubra can fix from its side, so it stays documented rather than planned.
3. **Streaming is for slow data, not for pages that must work without JavaScript.** `@zubra/server` streams: a prop given as a promise renders as pending (the component's `zb-await` shows its pending content), and `page.stream(html)` sends the page first and each resolved region as its promise settles, in a `<template for>`. Chrome and Edge 150+ put the region in place themselves, even without JavaScript; in other browsers, and inside shadow roots, a short inline script does, and the element hydrates it. Where the browser can't, the pending content stays without JavaScript, so a page that has to be complete without it in every browser should await the data before rendering.
4. **`Date` and `Intl` components are browser-only** on the server, by design: formatting a date on the server and the client can disagree, and a hydration mismatch is worse than an empty region. `zubra check --server` names them.

## Hydration markers through minifiers and sanitizers

The server's HTML carries the element's hydration markers as processing instructions: `<?zb [?>` … `<?zb ]?>` around a region, `<?zb [??>` for one left to the browser, `<?zb [!?>` for slot content, `<?zb ?>` before dynamic text. The element reads them to bind to the markup without re-rendering. Chrome and Edge 150+ parse each as a `ProcessingInstruction`; every other browser parses it as a comment (`<!--?zb [?-->`), and the runtime reads both. 5.0 moved to this form *from* comment markers because comments are what minifiers remove by default; processing instructions are rarer, and most tools pass them through.

Not all do. `server/test/markers.test.js` runs real registry output through the tools a page is likely to meet, and this table is what it measures (versions in `server/package.json`):

| Tool | Markers | What to do |
|---|---|---|
| html-minifier-terser (`removeComments`, `collapseWhitespace`) | kept | nothing |
| @minify-html/node (defaults) | kept | nothing |
| @swc/html | stripped by default | `preserveComments: ['^\\?zb']` (or `removeComments: false`) |
| htmlnano (any preset) | stripped by default: its parser drops processing instructions | the posthtml parser option `directives: [{ name: '?zb', start: '<', end: '>' }]` |
| DOMPurify | stripped | none that keeps only these (`ADD_TAGS: ['#comment']` keeps every comment) |
| sanitize-html | stripped, with every tag and attribute allowed | none |

Where a tool strips them anyway, the markup still hydrates: an element that finds its markup without markers puts them back by structure, walking its template against the DOM (a text anchor's text runs to the next element, a `zb-if` holds the branch the current values choose, a `zb-each` one row per item). The code that does this, `remark.js`, loads only when an element meets such markup, so a page whose pipeline keeps the markers never downloads it. Where the shape can't be placed for sure (`zb-await` regions, content projected into a child component), the element renders fresh with a warning naming the missing markers. Every registry component hydrates in place with every marker removed (`registry/test/stripped.test.js`).

So the contract is: markers survive the common minifiers as shipped or with one option; sanitizers remove them and the element recovers; and the recovery is measured, not assumed. If your pipeline has a tool that isn't in the table, run its output through `document.body.innerHTML = html` in a browser and count `<?zb` (or `<!--?zb`): the same count in and out means the fast path.

## What this means in practice

- **A plain server** (any language) gets complete, correct HTML for every component in the subset, with hydration that keeps focus and input state. This is the case Zubra was built for, and it's the smoothest.
- **A meta-framework** gets complete HTML through the bridge, with light or shadow DOM for elements without framework children and shadow DOM for the rest. It works in every one in CI (`examples/meta/`, each with a no-JavaScript test).
- **Compared with a framework's own SSR**, Next.js or Nuxt rendering their own components is still smoother: no bridge, no `shadow` flag for an element with children, and the framework's own streaming. Zubra's server story is complete for leaf components and plain servers, and close to it inside frameworks.
