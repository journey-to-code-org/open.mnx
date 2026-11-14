# One design system, five consumers, four tools

A company has a React app, a Vue app, a Svelte app, an Angular app and a server-rendered page, and wants one set of components in all of them. This folder builds that once per tool (Zubra, Lit, Stencil and Enhance) and measures what each costs.

- **The design system** is six elements: `ds-badge`, `ds-field`, `ds-quantity`, `ds-tabs`, `ds-dialog` and `ds-table`. Each tool's version is in `impl/<tool>/`.
- **The hosts** are an order desk written once per framework (`hosts/react`, `vue`, `svelte`, `angular`) and a server page (`hosts/server`). A host's source doesn't know which tool built the components: it imports `ds`, which `hosts/config.mjs` points at `impl/<tool>/`.
- **One suite** (`test/`) drives every tool in every host: 104 tests, all passing.

```
npm install
npm test                 # builds Stencil's output, then every tool in every host, in Chromium
node measure.mjs         # the tables below
IMPL=lit npx vite hosts/react              # one host with one tool, by hand
node hosts/server/server.mjs enhance 8080  # the server page with one tool
```

## The contract

Every element takes properties in and fires DOM events out, with lowercase event names and the data in `detail`.

| Element | Props | Event | What the suite checks |
|---|---|---|---|
| `ds-badge` | `status` | | The label and its text |
| `ds-field` | `label`, `name`, `value`, `required`, `error` | `valuechange` | Typing reaches the host; the form submits it; Enter submits; the error is an alert |
| `ds-quantity` | `label`, `name`, `value`, `min`, `max` | `valuechange` | − and + and typing, clamped; the form submits it |
| `ds-tabs` | `tabs` (array), `selected`, `label` | `selectedchange` | Click, arrow keys, Home and End; focus follows |
| `ds-dialog` | `open`, `heading`, default slot | `openchange` | Shows the host's content, live; Escape and Close reach the host |
| `ds-table` | `caption`, `columns`, `rows` (arrays) | `rowselect` | Rows, money and status cells, sorting, `aria-sort` |

The React and Vue hosts use each tool's components for that framework (`impl/<tool>/react.*`, `vue.*`). The Svelte and Angular hosts use the elements as they are.

## What was measured

Zubra 5.14.0, Lit 3.3.3, Stencil 4.45.3 and Enhance SSR 4.0.3, all from npm, on Node 22 and Chromium. From `node measure.mjs` on 2026-11-13.

**Lines written** (not blank, not comments):

| | Zubra | Lit | Stencil | Enhance |
|---|---:|---:|---:|---:|
| Components | 189 | 274 | 245 | 232 |
| Support code the tool needed | 0 | 0 | 0 | 92 |
| React and Vue bindings, by hand | 18 | 47 | 21 | 34 |
| Build configuration | 1 | 0 | 36 | 0 |
| Server page | 19 | 25 | 22 | 23 |
| **Total** | **227** | **346** | **324** | **381** |

**JavaScript the design system adds to each host** (gzip, over the same host with no design system):

| Host | Zubra | Lit | Stencil | Enhance |
|---|---:|---:|---:|---:|
| React | 17.0 KB | 9.2 KB | 12.9 KB | 5.2 KB |
| Vue | 16.4 KB | 8.8 KB | 13.1 KB | 5.5 KB |
| Svelte | 14.6 KB | 8.3 KB | 11.6 KB | 5.0 KB |
| Angular | 14.8 KB | 8.3 KB | 11.7 KB | 5.1 KB |

Zubra also has a 1.1 KB chunk loaded on demand (it repairs hydration markers a sanitizer removed).

**The server page:**

| | Zubra | Lit | Stencil | Enhance |
|---|---:|---:|---:|---:|
| HTML, 3 orders (gzip) | 1.9 KB | 2.0 KB | 2.1 KB | 1.7 KB |
| JavaScript loaded (gzip) | 21.4 KB, 11 requests | 11.1 KB, 1 request | 12.8 KB, 1 request | 5.7 KB, 1 request |
| Elements defined, slow connection | 1108 ms | 526 ms | 519 ms | 419 ms |
| Render, 3 orders, new data each time | 641 µs | 147 µs | 1913 µs | 397 µs |
| Render, 100 orders, new data each time | 6013 µs | 1293 µs | 15189 µs | 4473 µs |
| Render, 3 orders, the same data again | 534 µs | 72 µs | 1904 µs | 426 µs |
| Render, 100 orders, the same data again | 5656 µs | 1301 µs | 14811 µs | 4223 µs |
| JavaScript off: orders readable | yes | yes | yes | yes |
| JavaScript off: label names its input | yes | yes | yes | yes |
| JavaScript off: the form adds the order | yes | no | no | yes |

## What the numbers don't say

- **One author wrote all four**, in one sitting, and six components is a small design system. Line counts are that author's code, not the least possible. The Zubra components are counted as `zubra fmt` writes them (it puts long tags over several lines); the others are as written by hand.
- **Lit and Stencil use shadow DOM here**, their default. That is why their forms don't post with JavaScript off: a form doesn't look inside a shadow root, so the controls submit through `ElementInternals`, which needs the element running. Stencil with `shadow: false` would post; that wasn't built.
- **Enhance isn't on `@enhance/element` in the browser.** Its elements render in their constructor, which `document.createElement` refuses, and React and Angular create elements that way. It also has attributes and a store but no properties. `impl/enhance/element.mjs` (the 92 support lines) keeps Enhance's element functions and morphdom on a base that renders once connected. Enhance's small size is partly that base.
- **The Vue host uses plain `v-model`** on the two controls, because Stencil's Vue output supports only that. Zubra's `v-model:selected` and `v-model:open` aren't exercised.
- **The Angular host binds `[value]` and `(valuechange)`**, not `ngModel`. Zubra ships `ZubraModel` and Stencil can generate value accessors; Lit and Enhance would need one written.
- **"Elements defined" is Chromium's throttle** (150 ms latency, 1.6 Mbit/s, nothing cached) against a local server that doesn't compress, not a real network.
- **Render times are one Node.js process on one machine**, and move by a few tens of microseconds between runs. "New data each time" changes one customer's name per render; "the same data again" renders one state repeatedly, which also shows what a server keeps from the last render. Zubra's are through the compiler's WebAssembly build, one request per component rendered.
- **Chromium only.**
