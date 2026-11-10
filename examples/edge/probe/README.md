# Edge probe: does Zubra render inside a Cloudflare Worker?

A probe, not an example app. It runs three small Workers in `workerd` (Wrangler's local runtime) and records what happens, so the claim "the compiler runs on Workers" rests on something measured. It is the first stage (W1) of the Workers roadmap; the findings are below, and the stages that act on them follow.

You need the repository's `compiler/zubra.wasm` (`cd compiler && npm run build`, or copy the one from the published `@zubra/compiler`), then:

```sh
npm install
npm run dev:naive    # src/worker.js         @zubra/compiler, used as Node uses it
npm run dev:wasm     # src/worker-wasm.js    the wasm module imported, the request glue written out
npm run dev:server   # src/worker-server.js  @zubra/server's createZubra
```

then `curl http://localhost:8787/`.

## What happens

| Worker | Result | Why |
|---|---|---|
| `worker.js`, no flags | does not start: `No such module "node:child_process"` | `@zubra/compiler/index.js` imports `node:child_process`, `node:fs` and `node:path` |
| `worker.js`, `nodejs_compat` | does not start: `Uncaught TypeError: Invalid URL string` | `new URL('./zubra.wasm', import.meta.url)` runs at import, and `import.meta.url` in a Worker is not a URL. The bundle is also 3.8 KiB: the wasm is read from disk at run time, so it was never included |
| `worker-wasm.js` | **renders**: `<price-tag cents="129900"><data>$1299.00</data></price-tag>` | the wasm is imported (`import wasm from '…/zubra.wasm'`), which Wrangler ships as a precompiled `WebAssembly.Module`, and the compiler's own request glue is copied here. The module takes no imports of its own |
| `worker-server.js`, `nodejs_compat` | does not start: `import.meta.resolve is not a function` | `@zubra/server` calls `findCompiler()` as it loads, which resolves `@zubra/compiler` that way |

So the compiler is fine on Workers and the two npm packages are not, yet. The Hono adapter imports `@zubra/server`, so it does not run on Workers either: `candidates.md` listed it as running there, and that row was wrong.

What `@zubra/server` would still need after that first failure, read from its source rather than run: `import.meta.resolve('@zubra/runtime')` and `existsSync(components)` inside `createZubra`, and `readdirSync` / `readFileSync` to find and load components. A Worker has no components folder, so it has to be given the sources.

## Numbers (`wrangler dev --local`, workerd, one component)

- **Bundle:** 3,364 KiB, 934 KiB gzipped. Nearly all of it is `zubra.wasm` (3.4 MB raw, 953 KB gzipped on its own). Workers cap the compressed size of a deployed Worker, and the cap depends on the plan: check the current figure before relying on this bundle fitting, since the compiler leaves little room on a small plan.
- **First request:** 24 ms (instantiating the module and the first render).
- **After that:** 0.06 to 0.07 ms per render of `price-tag` (100 and 1000 renders in one request).

Workers coarsen `performance.now()` in production, so these are local-development figures, not a production benchmark.
