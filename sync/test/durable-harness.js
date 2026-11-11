// A SyncObject on Node: durable-core.js (what SyncObject wraps) on a stand-in storage, and a
// namespace that hands out one object per name and copies arguments and results as RPC does.
// `evict()` drops every object, as Workers may: the next call makes a new one on the same storage.
import { syncObject } from '../src/durable-core.js';
import { durableStorage } from './durable-storage.js';

/** An object like a SyncObject subclass: the core, plus the app's own methods. */
export class Market {
  constructor(ctx, env, options) {
    this.env = env;
    this.sync = syncObject(ctx, this, options);
  }
  fetch(request) { return this.sync.fetch(request); }
  documents() { return this.sync.documents(); }
  write(...args) { return this.sync.write(...args); }
  snapshot(collections) { return this.sync.snapshot(collections); }
  authorize({ request, collection, kind }) {
    if (kind === 'read') return true;
    return collection !== 'stock' || request.headers.get('cookie') === `farmer=${this.env?.FARMER}`;
  }
  async take(key, qty) {
    const left = (await this.documents()).get('stock', key)?.qty ?? 0;
    if (left < qty) return { error: 'Sold out' };
    await this.write('stock', key, { qty: left - qty });
    return { ok: true };
  }
}

export function namespace(env = { FARMER: 'ada' }, options) {
  const storages = new Map();
  let objects = new Map();
  const rpc = (target) => new Proxy(target, {
    get(object, name) {
      if (name === 'fetch') return (request) => object.fetch(request);
      const method = object[name];
      if (typeof method !== 'function') return undefined;
      return async (...args) => structuredClone(await method.apply(object, structuredClone(args)));
    },
  });
  return {
    idFromName: (name) => `id:${name}`,
    get(id) {
      if (!storages.has(id)) storages.set(id, durableStorage());
      if (!objects.has(id)) objects.set(id, rpc(new Market({ storage: storages.get(id) }, env, options)));
      // A stub stays good across an eviction: it reaches whatever object is there now.
      return new Proxy({}, { get: (_, name) => (...args) => (objects.get(id) ?? (objects.set(id, rpc(new Market({ storage: storages.get(id) }, env, options))), objects.get(id)))[name](...args) });
    },
    evict() {
      objects = new Map();
    },
  };
}
