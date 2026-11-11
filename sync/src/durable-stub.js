// The Worker's side of a SyncObject: forward sync requests to it, read its documents, write as
// the server. Plain JavaScript (the namespace is a binding the Worker is given), so it runs on
// Node in tests too.
import { MOUNT, documentsView } from './server.js';

/** A snapshot (`{ collection: [{ key, ...fields }] }`) read like `sync.documents()`. */
export function viewOf(snapshot) {
  const split = ({ key, ...fields }) => ({ key, fields });
  return documentsView({
    find: (collection, key) => {
      const doc = (snapshot[collection] ?? []).find((each) => each.key === key);
      return doc && split(doc).fields;
    },
    list: (collection) => (snapshot[collection] ?? []).map(split),
    names: () => Object.keys(snapshot),
  });
}

/**
 * `namespace` is the Durable Object binding (`env.SYNC`); `name` picks the object (one per app:
 * the log's cursor is one order). The stub's own methods (`stub.placeOrder(…)`) are the object's,
 * over RPC: put a read-then-write that mustn't interleave there, not in the Worker.
 */
export function syncStub(namespace, { name = 'sync', mount = MOUNT } = {}) {
  if (!namespace || typeof namespace.idFromName !== 'function') {
    throw new TypeError('syncStub(env.SYNC): pass the Durable Object namespace binding');
  }
  const stub = namespace.get(namespace.idFromName(name));
  const base = mount.replace(/\/$/, '');
  return {
    stub,
    /** The object's answer to a sync request, or null when the request isn't one. */
    async fetch(request) {
      return new URL(request.url).pathname.startsWith(`${base}/`) ? stub.fetch(request) : null;
    },
    /**
     * The documents as they are now, for rendering: a copy, not kept current, and reading it then
     * writing from the Worker can interleave with other requests. Name the collections you need
     * to send less.
     */
    async documents(...collections) {
      return viewOf(await stub.snapshot(collections));
    },
    /** Write as the server, through the object: to its log and every live page. */
    write: (collection, key, fields) => stub.write(collection, key, fields),
  };
}
