// A synchronous store over the sync server: `get` and `under` read the documents view, `write` is
// sync.write(). The contract a library of server-side rules can sit on (a check and a write with
// no await between are one step), checked the way such a library checks a store it's handed.
import assert from 'node:assert/strict';

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The three functions, over `docs` (from `await sync.documents()`) and `write`. */
export const storeOver = (docs, write) => ({
  get: (collection, key) => docs.get(collection, key) ?? null,
  under: (collection, prefix = '') => docs.all(collection, prefix).sort(byKey),
  write: (collection, key, fields) => write(collection, key, fields),
});

export async function checkStore(store, collection = 'store-check') {
  assert.equal(store.get(collection, 'a/1'), null, 'a missing document is null');
  const sent = store.write(collection, 'a/1', { n: 1, tag: 'x' });
  assert.deepEqual(store.get(collection, 'a/1'), { n: 1, tag: 'x' }, 'a write is stored before its promise settles');
  await sent;
  await store.write(collection, 'a/1', { n: 2 });
  assert.deepEqual(store.get(collection, 'a/1'), { n: 2, tag: 'x' }, 'a write merges fields');
  await store.write(collection, 'a/2', { n: 3 });
  await store.write(collection, 'b/1', { n: 4, nested: { list: [1, null] } });
  assert.deepEqual(store.under(collection, 'a/').map((doc) => doc.key), ['a/1', 'a/2'], 'under() filters by prefix, in key order');
  assert.equal(store.under(collection).length, 3, 'under() with no prefix is the whole collection');
  assert.deepEqual(store.get(collection, 'b/1').nested, { list: [1, null] }, 'values round-trip');
  store.get(collection, 'b/1').nested.list.push(2);
  assert.deepEqual(store.get(collection, 'b/1').nested, { list: [1, null] }, 'what a reader changes is its own');
}

/** Two requests for one seat at once, each checking then writing: exactly one wins. */
export async function oneWinner(store) {
  const claim = async (who) => {
    await Promise.resolve(); // whatever the request did first
    if (store.get('seats', 'B4')?.holder) return 'taken';
    const sent = store.write('seats', 'B4', { holder: who });
    await sent;
    return 'held';
  };
  const results = await Promise.all([claim('ada'), claim('bo')]);
  assert.deepEqual(results.sort(), ['held', 'taken']);
  assert.ok(['ada', 'bo'].includes(store.get('seats', 'B4').holder));
}
