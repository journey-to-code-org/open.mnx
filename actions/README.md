# @zubra/actions

Serve Zubra components' `'use server'` functions over plain form posts. The same form works without JavaScript (a post and a redirect back) and with it (a `fetch`, no navigation, an `action` event on the form).

```js
import { createActions } from '@zubra/actions';
const actions = await createActions({ components: 'components' });

if (await actions.handle(req, res)) return;     // Node's http
const response = await actions.fetch(request);  // fetch-style servers; null if not ours
```

Adapters: `@zubra/actions/hono`, `@zubra/actions/express`, `@zubra/actions/fastify`. Put `actions.script()` on pages with action forms.

On Cloudflare Workers (no disk to compile from): `npx zubra-actions build components --out src/actions`, then `createActions({ actions })` from `@zubra/actions/edge`. See `docs/actions.md`.

The contract, the security rules and the no-JavaScript path are in [docs/actions.md](https://github.com/journey-to-code-org/zubra/blob/main/docs/actions.md).
