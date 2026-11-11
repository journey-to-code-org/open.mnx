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

[`examples/edge/hono-bikes-worker`](../examples/edge/hono-bikes-worker) is the bike shop of `examples/hypermedia/hono-bikes`, and its CI test runs it in workerd and compares status, redirects and HTML to the Node.js app's, byte for byte. Its bundle was 3465 KiB (962 KiB gzipped) when measured with Wrangler 4.45.0. Workers check only the uncompressed size, against 64 MiB on every plan.

## Sync and Actions

Both run on Workers too, with a Durable Object holding what a Worker's isolates can't share:

- **Sync**: `@zubra/sync/durable`. Extend `SyncObject` for a Durable Object that holds the sync server, its log in the object's own SQLite (`durableObjectLog`); the Worker forwards `/_zb/sync/*` to it with `syncStub(env.BINDING)`, and reads a copy of the documents from it to render pages. A read-then-write that mustn't interleave goes in a method of the object. See [Sync](sync.md#on-cloudflare-workers-a-durable-object).
- **Actions**: `npx zubra-actions build components --out src/actions` writes the server functions as modules for the bundler, and `createActions({ actions })` from `@zubra/actions/edge` answers posts as the Node entry does. See [Actions](actions.md#without-a-disk-cloudflare-workers).
- Put `@zubra/sync`'s browser modules (`index.js`, `connect.js`, `webrtc.js`) and the actions script (`@zubra/actions/client`, at `/_zb/actions.js`) in your static assets, and map `@zubra/sync` and `@zubra/sync/connect` with `imports`.

[`examples/edge/standup-worker`](../examples/edge/standup-worker) is the standup board on a Worker, plus a form whose server function races through the object. Its CI job runs it in workerd with two browsers (typing, presence, the race, the form without JavaScript, a restart), and runs Sync's log contract inside a Durable Object. Its bundle is 3416 KiB (950 KiB gzipped) with Wrangler 4.45.0, almost all of it the compiler. Workers check only the uncompressed size, against 64 MiB on every plan.

What's measured on workerd locally, not on Cloudflare: a page that closes leaves its presence rooms at once (it says so on `pagehide`); one whose connection is cut is noticed when keep-alives stop getting through (`SyncObject` sends one every 2 s), which took about three of them in the spike, and depends on `wrangler dev`'s local proxy. An open live stream keeps the object in memory, which a Durable Object is billed for by duration.

## Limits and failures

- Markup may nest 256 elements deep, in a template and in slot content; deeper is a compile error. Slot content is HTML your Worker was handed, so this is the bound on what a request can make the compiler follow.
- If the compiler traps on an input anyway, that request throws a `CompilerCrash` and `createCompiler(wasm)` starts a fresh instance for the next one, so one bad input doesn't cost the isolate its compiler. This needs the `WebAssembly.Module`, which is what a Worker's `import wasm from '@zubra/compiler/zubra.wasm'` gives you.
- Streamed pages (`page().streamResponse()`) work from a bundled Worker: the inline scripts are text, which a bundler can't rewrite.

Only Workers has a CI job. Deno Deploy, Vercel Edge and Fastly may work, but nothing here runs them.
