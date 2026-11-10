# Edge probe: does Zubra render inside a Cloudflare Worker?

A probe, not an example app. It runs three small Workers in `workerd` (Wrangler's local runtime) and records what happens, so the claim "the compiler runs on Workers" rests on something measured. It is the first stage (W1) of the Workers roadmap; the findings are below, and the stages that act on them follow.

You need the repository's `compiler/zubra.wasm` (`cd compiler && npm run build`, or copy the one from the published `@zubra/compiler`), then:

```sh
npm install
npm run dev:naive    # src/worker.js         @zubra/compiler, used as Node uses it
npm run dev:wasm     # src/worker-wasm.js    @zubra/compiler/wasm over the imported wasm module
npm run dev:server   # src/worker-server.js  @zubra/server/edge over a text-imported component
```

then `curl http://localhost:8787/`.

## What happens

| Worker | Result | Why |
|---|---|---|
| `worker.js`, no flags | does not start: `No such module "node:child_process"` | `@zubra/compiler/index.js` imports `node:child_process`, `node:fs` and `node:path` |
| `worker.js`, `nodejs_compat` | does not start: `Uncaught TypeError: Invalid URL string` | `new URL('./zubra.wasm', import.meta.url)` runs at import, and `import.meta.url` in a Worker is not a URL. The bundle is also 3.8 KiB: the wasm is read from disk at run time, so it was never included |
| `worker-wasm.js` | **renders**: `<price-tag cents="129900"><data>$1299.00</data></price-tag>` | the wasm is imported (`import wasm from '@zubra/compiler/zubra.wasm'`), which Wrangler ships as a precompiled `WebAssembly.Module`, and handed to `createCompiler` from `@zubra/compiler/wasm`, the entry that has no Node dependencies (it began as this file's pasted request glue). The module takes no imports of its own |
| `worker-server.js` | **renders**: `$1,299.00`, with the component's CSS and import map in the page and its browser module served | `@zubra/server/edge`: the component is a text import (a `Text` rule for `**/*.zb` in `wrangler.jsonc`), the compiler its wasm module, and `createZubra({ wasm, components })` does the rest. Before it, `createZubra` failed at import with `import.meta.resolve is not a function`: `@zubra/server` called `findCompiler()` as it loaded, and read a components folder |

The first run had the compiler fine on Workers and both npm packages not. `@zubra/compiler/wasm` fixed the first; `@zubra/server/edge` and `@zubra/server/hono-edge` fix the second. The Hono adapter used to import the Node entry, so it never ran on Workers: `candidates.md` listed it as running there, and that row was wrong.

What it needed, found by reading the source and confirmed by the fix: `import.meta.resolve` in two places, `existsSync` and `readdirSync` on the components folder, `readFileSync` for sources, and Node streams for `stream()` / `streamResponse()`. The portable part now lives in `server/src/core.js`; the Node entry adds the disk, the edge entry adds a map of sources. The runtime (`@zubra/runtime`) is not served by the edge entry, since a Worker has no disk to serve it from: put it in the static assets directory, or point the import map at a CDN with `imports`.

## Numbers (`wrangler dev --local`, workerd, one component)

- **Bundle:** 3,364 KiB, 934 KiB gzipped for the compiler alone; 3,388 KiB, 941 KiB with `@zubra/server/edge` and the component. Nearly all of it is `zubra.wasm` (3.4 MB raw, 953 KB gzipped on its own). Workers cap the compressed size of a deployed Worker, and the cap depends on the plan: check the current figure before relying on this bundle fitting, since the compiler leaves little room on a small plan.
- **First request:** 24 ms (instantiating the module and the first render).
- **After that:** 0.06 to 0.07 ms per render of `price-tag` (100 and 1000 renders in one request).

Workers coarsen `performance.now()` in production, so these are local-development figures, not a production benchmark.
