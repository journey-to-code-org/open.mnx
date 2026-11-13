// What a SyncObject is, without Workers' modules: a sync server on the object's storage, its
// `authorize` asked of the object, and a snapshot of the documents for the Worker to render from.
// durable.js wraps this in a DurableObject; tests run it on Node against a stand-in storage.
import { createSyncServer, MOUNT } from './server.js';
import { durableObjectLog } from './durable-log.js';

export { MOUNT };

/**
 * `owner` is the object: its `authorize(…)`, if it has one, decides as `createSyncServer`'s does;
 * without one, pages may read and not write.
 * `heartbeat` is shorter than on Node (2 s, not 15): a Durable Object isn't told when a page's
 * connection is cut, only that a keep-alive couldn't be written, which on workerd is the third
 * after the cut. So a crashed page's presence lingers about three keep-alives (6 s). A page that
 * closes normally says it's leaving and is gone at once.
 */
export function syncObject(ctx, owner, { mount = MOUNT, heartbeat = 2_000, device = 'server', table = 'changes', origins = [] } = {}) {
  const sync = createSyncServer({
    log: durableObjectLog(ctx.storage, { table }),
    mount,
    heartbeat,
    device,
    origins,
    // Without an authorize of its own, the object takes reads only, as createSyncServer does.
    authorize: typeof owner.authorize === 'function' ? (asked) => owner.authorize(asked) : undefined,
  });
  return {
    async fetch(request) {
      return (await sync.fetch(request)) ?? new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    },
    documents: sync.documents,
    write: sync.write,
    /** `{ collection: [{ key, ...fields }] }` for the collections named, or every one: plain data, for RPC. */
    async snapshot(collections = []) {
      const docs = await sync.documents();
      const names = collections.length ? collections : docs.collections();
      return Object.fromEntries(names.map((name) => [name, docs.all(name)]));
    },
  };
}
