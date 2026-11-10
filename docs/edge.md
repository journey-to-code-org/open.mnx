# Zubra on Cloudflare Workers

Components render in a Worker with no file system and no Node.js APIs. Two entry points exist for it:

- `@zubra/compiler/wasm`: `createCompiler(wasm)` over a `WebAssembly.Module` you pass in. In a Worker, `import wasm from '@zubra/compiler/zubra.wasm'` gives a precompiled one (a Worker can't compile WebAssembly from bytes).
- `@zubra/server/edge`: `createZubra({ wasm, components: { 'price-tag': source } })`, with the same `render`, `page()`, `head()`, `scripts()` and `fetch()` as the Node entry. `@zubra/server/hono-edge` is the Hono middleware over it.

```js
// wrangler.jsonc: "rules": [{ "type": "Text", "globs": ["**/*.zb"] }]
import wasm from '@zubra/compiler/zubra.wasm';
import { zubra } from '@zubra/server/hono-edge';
import priceTag from './components/price-tag.zb';

const middleware = zubra({ wasm, components: { 'price-tag': priceTag } });
```

`@zubra/runtime` is not served by the Worker: put it in your static assets under `<prefix>/runtime/`, or point the import map at a CDN with `imports`.

## Proven

[`examples/edge/hono-bikes-worker`](../examples/edge/hono-bikes-worker) is the bike shop of `examples/hypermedia/hono-bikes`, and its CI test runs it in workerd and compares status, redirects and HTML to the Node.js app's, byte for byte. Its bundle was 3465 KiB (962 KiB gzipped) when measured with Wrangler 4.45.0; check your plan's Worker size limit against that.

## Limits and failures

- Markup may nest 256 elements deep, in a template and in slot content; deeper is a compile error. Slot content is HTML your Worker was handed, so this is the bound on what a request can make the compiler follow.
- If the compiler traps on an input anyway, that request throws a `CompilerCrash` and `createCompiler(wasm)` starts a fresh instance for the next one, so one bad input doesn't cost the isolate its compiler. This needs the `WebAssembly.Module`, which is what a Worker's `import wasm from '@zubra/compiler/zubra.wasm'` gives you.
- Streamed pages (`page().streamResponse()`) work from a bundled Worker: the inline scripts are text, which a bundler can't rewrite.

Only Workers has a CI job. Deno Deploy, Vercel Edge and Fastly may work, but nothing here runs them.
