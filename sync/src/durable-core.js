// What a SyncObject is, without Workers' modules: a sync server on the object's storage, its
// `authorize` asked of the object, and a snapshot of the documents for the Worker to render from.
// durable.js wraps this in a DurableObject; tests run it on Node against a stand-in storage.
import { createSyncServer } from './server.js';
import { durableObjectLog } from './durable-log.js';

export const MOUNT = '/_zb/sync';

/**
 * `owner` is the object: its `authorize(…)`, if it has one, decides as `createSyncServer`'s does.
 * `heartbeat` is shorter than on Node (5 s): a Durable Object isn't told when a page goes away,
 * only that the next keep-alive couldn't be written, so this is how long presence lingers.
 */
export function syncObject(ctx, owner, { mount = MOUNT, heartbeat = 5_000, device = 'server', table = 'changes', origins = [] } = {}) {
  const sync = createSyncServer({
    log: durableObjectLog(ctx.storage, { table }),
    mount,
    heartbeat,
    device,
    origins,
    authorize: (asked) => (typeof owner.authorize === 'function' ? owner.authorize(asked) : true),
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
