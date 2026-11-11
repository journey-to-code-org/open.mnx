// A SyncObject and the Worker's stub, on Node: the object is durable-core.js's (what SyncObject
// wraps), on a stand-in storage; the namespace hands out one object per name and copies every
// argument and result, as RPC does. The edge example runs the real thing in workerd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncObject } from '../src/durable-core.js';
import { syncStub, viewOf } from '../src/durable-stub.js';
import { durableStorage } from './durable-storage.js';

/** An object like a SyncObject subclass: the core, plus the app's own methods. */
class Market {
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
    return collection !== 'stock' || request.headers.get('cookie') === `farmer=${this.env.FARMER}`;
  }
  async take(key, qty) {
    const left = (await this.documents()).get('stock', key)?.qty ?? 0;
    if (left < qty) return { error: 'Sold out' };
    await this.write('stock', key, { qty: left - qty });
    return { ok: true };
  }
}

/** A Durable Object namespace: one object per name, arguments and results copied as RPC copies them. */
function namespace(env = { FARMER: 'ada' }, options) {
  const objects = new Map();
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
      if (!objects.has(id)) objects.set(id, rpc(new Market({ storage: durableStorage() }, env, options)));
      return objects.get(id);
    },
  };
}

const json = (body, headers = {}) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const change = (key, field, value, clock) => ({ collection: 'stock', key, field, value, clock });

async function listen(sync, peer) {
  const response = await sync.fetch(new Request(`http://shop/_zb/sync/live?since=0&peer=${peer}`));
  const reader = response.body.getReader();
  let text = '';
  return {
    async until(pattern) {
      while (!pattern.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    },
    close: () => reader.cancel(),
  };
}

test("the stub answers sync's requests and leaves the rest to the Worker", async () => {
  const sync = syncStub(namespace());
  assert.equal(await sync.fetch(new Request('http://shop/')), null);
  assert.equal(await sync.fetch(new Request('http://shop/_zb/syncing')), null);
  const pushed = await sync.fetch(new Request('http://shop/_zb/sync/push', json({ changes: [change('eggs', 'qty', 12, '000000000000001-00000-a')] }, { cookie: 'farmer=ada' })));
  assert.equal(pushed.status, 200);
  assert.equal((await (await sync.fetch(new Request('http://shop/_zb/sync/pull?since=0'))).json()).cursor, 1);
  assert.equal((await sync.fetch(new Request('http://shop/_zb/sync/nope'))).status, 404);
});

test("two Workers' stubs reach the same object: a page on one sees what the other writes", async () => {
  const ns = namespace();
  const one = syncStub(ns);
  const two = syncStub(ns);
  const page = await listen(one, 'p1');
  await two.write('stock', 'eggs', { qty: 6 });
  assert.match(await page.until(/"qty",[^]*"value":6/), /"value":6/);
  await page.close();
  assert.deepEqual((await one.documents()).get('stock', 'eggs'), { qty: 6 });
});

test("the object's authorize decides, with the object's env", async () => {
  const sync = syncStub(namespace({ FARMER: 'ada' }));
  const push = (cookie) => sync.fetch(new Request('http://shop/_zb/sync/push', json({ changes: [change('eggs', 'qty', 1, '000000000000001-00000-a')] }, { cookie })));
  assert.equal((await push('farmer=bob')).status, 403);
  assert.equal((await push('farmer=ada')).status, 200);
});

test("a read-then-write in the object's method doesn't interleave: two buyers, one carton", async () => {
  const sync = syncStub(namespace());
  await sync.write('stock', 'eggs', { qty: 1 });
  const results = await Promise.all([sync.stub.take('eggs', 1), sync.stub.take('eggs', 1)]);
  assert.deepEqual(results.map((r) => Object.keys(r)[0]).sort(), ['error', 'ok']);
  assert.equal((await sync.documents('stock')).get('stock', 'eggs').qty, 0);
});

test("the stub's documents are a copy of the collections asked for", async () => {
  const sync = syncStub(namespace());
  await sync.write('stock', 'eggs', { qty: 3, price: 450 });
  await sync.write('orders', 'o1', { qty: 1 });
  const stock = await sync.documents('stock');
  assert.deepEqual(stock.collections(), ['stock']);
  assert.deepEqual(stock.all('stock'), [{ key: 'eggs', qty: 3, price: 450 }]);
  assert.equal(stock.get('orders', 'o1'), undefined);
  stock.get('stock', 'eggs').qty = 99;
  assert.equal(stock.get('stock', 'eggs').qty, 3, 'what a reader changes is its own');
  stock.all('stock')[0].qty = 99;
  assert.equal(stock.all('stock')[0].qty, 3);
  await sync.write('stock', 'eggs', { qty: 2 });
  assert.equal(stock.get('stock', 'eggs').qty, 3, 'not kept current');
  assert.deepEqual((await sync.documents()).collections(), ['stock', 'orders']);
});

test('a named object is a separate log; options reach the sync server', { timeout: 3000 }, async () => {
  const ns = namespace(undefined, { heartbeat: 20, mount: '/sync' });
  const a = syncStub(ns, { name: 'a', mount: '/sync' });
  const b = syncStub(ns, { name: 'b', mount: '/sync' });
  await a.write('stock', 'eggs', { qty: 1 });
  assert.equal((await b.documents()).get('stock', 'eggs'), undefined);
  assert.equal(await a.fetch(new Request('http://shop/_zb/sync/pull')), null, 'the mount moved');
  const page = await listen({ fetch: (r) => a.fetch(new Request(r.url.replace('/_zb/sync', '/sync'))) }, 'p1');
  const hold = setInterval(() => {}, 1000); // the keep-alive timer is unref'd: keep the test alive for it
  try {
    await page.until(/: keep-alive/);
  } finally {
    clearInterval(hold);
    await page.close();
  }
});

test('viewOf reads a snapshot like documents(); syncStub wants a namespace', () => {
  const view = viewOf({ stock: [{ key: 'eggs', qty: 2 }] });
  assert.deepEqual(view.get('stock', 'eggs'), { qty: 2 });
  assert.deepEqual(view.all('nope'), []);
  assert.throws(() => syncStub(undefined), /namespace binding/);
  assert.throws(() => syncStub({}), /namespace binding/);
});
