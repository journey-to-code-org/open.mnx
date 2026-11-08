# Spoke & Chain: Hono and htmx

A bike shop's inventory with search, paging, quick sales and inline editing. It's built with
[Hono](https://hono.dev) and [htmx](https://htmx.org), and runs on **Node.js or Bun**:

```sh
cargo build                 # from the repository root (see below)
cd examples/hypermedia/hono-bikes
npm install
npm start                   # Node.js: http://localhost:3000
npm run start:bun           # or Bun
```

Every route answers in two ways:
- a plain request gets a whole page, so the shop works without JavaScript;
- an htmx request (`HX-Request: true`) gets just the fragment to swap: a row, the edit form, the
  next page, or the search results, plus the low-stock count out of band.

The Zubra components in those fragments are rendered on the server. The browser hydrates them
wherever htmx puts them.

| | |
|---|---|
| `src/app.js` | Routes and templates, with `hono/html`. |
| `src/zubra.js` | Renders components (with `@zubra/compiler`), and serves their browser modules and `@zubra/runtime`. |
| `components/` | `price-tag` and `stock-gauge` (rendered completely on the server), `tag-list`, and `qty-input` (a native number input that gains − and + buttons). |
| `test/app.test.js` | Chromium against the server on Node.js and on Bun, with and without JavaScript. |

`@zubra/compiler` installed from npm carries its WebAssembly build. Inside this repository, the
CLI from `cargo build` stands in for it, as in `examples/helpdesk/`.

## What it found

- **Hydration markers are HTML comments, and comments don't always survive.**
  - htmx 2 parses fragments with `Document.parseHTMLUnsafe()` where the browser has it.
  - In the Chromium build Playwright ships (153), that drops every comment. MDN says it
    shouldn't with no sanitizer, so this looks like a browser bug, but it's what this browser
    does.
  - The swapped-in elements' markers are gone, so Zubra can't hydrate them. It renders them fresh
    instead, which gives the right result but logs a warning per element. In-place hydration
    (and with it focus and scroll position) is lost.
  - The layout works around it: when the browser drops comments, it removes
    `parseHTMLUnsafe`, so htmx falls back to `DOMParser`, which keeps them. A test checks both
    paths.
  - Anything that strips comments (HTML minifiers, some sanitizers, CDNs' "optimizers") has the
    same effect.
  - Since 2.10 the workaround is optional: an element whose markers were stripped puts them back
    by structure and hydrates in place. The test without the parser fix now expects no
    warnings.
- **Custom elements can't be table rows.** `<inventory-row>` in a `<tbody>` is moved out of the
  table by the HTML parser. So the rows are plain `<tr>`s in Hono's templates, with components
  in their cells, and each row costs three renders.
- **One render per component, per row.** A page of 10 rows is 30 renders. With the CLI standing
  in (one process each), that's about 100 ms. With the WebAssembly build in the same process,
  it would be far less. A batch render (many components in one request) would help either way.
- **Formatting money takes arithmetic.** The server's renderer doesn't run
  `Intl.NumberFormat` (or `toFixed`), so `price-tag` builds `$1,299.00` from `%` and `/`.
  It works, but nobody should have to write it.
- **htmx and Zubra agree on form fields.** `qty-input` keeps its native `<input name>` in light
  DOM, so htmx's `hx-post` sends it like any other field. Its `valuechange` and htmx's own
  events don't collide.
