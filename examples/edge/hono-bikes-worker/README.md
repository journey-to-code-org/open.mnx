# Bike shop on a Cloudflare Worker

The Spoke & Chain shop from [`../../hypermedia/hono-bikes`](../../hypermedia/hono-bikes), served by a Worker. The routes are the same file (`src/shop.js`); only the host differs:

| | Node.js (`hono-bikes/src/app.js`) | Worker (`src/worker.js`) |
|---|---|---|
| Components | read from `components/` | `.zb` text imports (a `Text` rule in `wrangler.jsonc`) |
| Compiler | `@zubra/compiler` loads `zubra.wasm` from disk | `import wasm from '@zubra/compiler/zubra.wasm'`, a precompiled module |
| Middleware | `@zubra/server/hono` | `@zubra/server/hono-edge` |
| Static files | read at startup | Workers static assets (`scripts/build-assets.mjs` copies htmx, the stylesheet and `@zubra/runtime`) |

```sh
npm install
npm run dev     # wrangler dev --local
npm test        # the Worker in workerd against the Node.js app, byte for byte
```

The test covers the list, search, category and paging, htmx fragments, redirects, 404s, selling, edit errors (422) and saves, and the browser modules and assets.
