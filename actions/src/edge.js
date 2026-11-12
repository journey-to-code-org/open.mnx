// @zubra/actions without a disk: for Cloudflare Workers, Deno and anything else that can't compile
// a components folder when it starts. The server functions come from `zubra-actions build`; the
// requests are answered exactly as the Node entry answers them (core.js).
//
//   import { actions } from './actions/index.js';          // npx zubra-actions build components --out src/actions
//   import { createActions } from '@zubra/actions/edge';
//   const forms = createActions({ actions, context: ({ request, env }) => ({ user: who(request, env) }) });
//   export default { fetch: async (request, env) => (await forms.fetch(request, { env })) ?? page(request) };
//
// The enhancing script (`@zubra/actions/client`) is served from your static assets at
// /_zb/actions.js, as the runtime is, unless you pass its source as `client`.
import { createActionsCore, routesFrom } from './core.js';

export { MOUNT, SCRIPT_PATH, COOKIE } from './core.js';

/**
 * `actions`: `{ url: fn }`, the build's `actions` (or several merged). `context(…)` gets
 * `{ request, ...extra }`, where `extra` is fetch's second argument (`{ env, ctx }` in a Worker).
 * `origins`, `onError` as the Node entry's.
 */
export function createActions({ actions, client = null, origins = [], onError = (error) => console.error(error), context = () => ({}), maxBytes } = {}) {
  if (!actions || typeof actions !== 'object') throw new TypeError("createActions({ actions }): pass `actions` from `zubra-actions build`'s index.js");
  return createActionsCore({ routes: routesFrom(actions), client, origins, onError, context, maxBytes });
}
