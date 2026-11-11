// @zubra/sync on Cloudflare Workers. A Durable Object holds the sync server (one per app), with
// the log in its own SQLite; the Worker forwards sync requests to it and reads and writes through
// it. Extend SyncObject, and put what must not interleave (check stock, then take it) in its
// methods: the object runs one call at a time.
//
//   import { SyncObject, syncStub } from '@zubra/sync/durable';
//
//   export class Market extends SyncObject {
//     static options = { heartbeat: 5000 };                  // createSyncServer's, and `table`
//     authorize({ request, collection, key, kind }) { … }    // as on Node; secrets are this.env's
//     async take(key, qty) {
//       const left = (await this.documents()).get('stock', key)?.qty ?? 0;
//       if (left < qty) return { error: 'Sold out' };
//       await this.write('stock', key, { qty: left - qty });
//       return { ok: true };
//     }
//   }
//
//   export default {
//     async fetch(request, env) {
//       const sync = syncStub(env.MARKET);
//       return (await sync.fetch(request)) ?? render(request, await sync.documents('stock'));
//     },
//   };
//   // wrangler.jsonc: durable_objects.bindings [{ name: 'MARKET', class_name: 'Market' }],
//   //                 migrations [{ tag: 'v1', new_sqlite_classes: ['Market'] }]
import { DurableObject } from 'cloudflare:workers';
import { syncObject } from './durable-core.js';

export { durableObjectLog } from './durable-log.js';
export { syncStub, viewOf } from './durable-stub.js';

export class SyncObject extends DurableObject {
  #sync;
  constructor(ctx, env) {
    super(ctx, env);
    this.#sync = syncObject(ctx, this, this.constructor.options);
  }
  /** Sync's requests (`/_zb/sync/*`), forwarded by the Worker's `syncStub(…).fetch`. */
  fetch(request) {
    return this.#sync.fetch(request);
  }
  /** Every document, kept current (in the object's own methods; the Worker uses the stub's). */
  documents() {
    return this.#sync.documents();
  }
  /** Write as the server: to the log and every live page. */
  write(collection, key, fields) {
    return this.#sync.write(collection, key, fields);
  }
  /** Plain data for the stub's `documents()`. */
  snapshot(collections) {
    return this.#sync.snapshot(collections);
  }
}
