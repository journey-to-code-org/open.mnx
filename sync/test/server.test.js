import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer } from '../src/server.js';

const change = (field, value, clock = '000000000000001-00000-dev1') => ({ collection: 'tasks', key: 't1', field, value, clock });
const push = (sync, changes, headers = {}) =>
  sync.fetch(new Request('http://localhost/_zb/sync/push', { method: 'POST', body: JSON.stringify({ changes }), headers: { 'content-type': 'application/json', ...headers } }));
const pull = async (sync, since = 0) => (await sync.fetch(new Request(`http://localhost/_zb/sync/pull?since=${since}`))).json();

test('changes come back out in order, after a cursor', async () => {
  const sync = createSyncServer();
  assert.equal((await push(sync, [change('title', 'a'), change('done', true)])).status, 200);
  assert.equal((await push(sync, [change('title', 'b', '000000000000002-00000-dev2')])).status, 200);
  const all = await pull(sync);
  assert.deepEqual(all.changes.map((c) => c.value), ['a', true, 'b']);
  assert.equal(all.cursor, 3);
  assert.deepEqual((await pull(sync, 2)).changes.map((c) => c.value), ['b']);
});

test('malformed changes, cross-site writes and other paths are refused', async () => {
  const sync = createSyncServer();
  assert.equal((await push(sync, [{ collection: 'tasks' }])).status, 400);
  assert.equal((await push(sync, [change('$clocks', {})])).status, 400);
  assert.equal((await push(sync, [change('title', 'x')], { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await sync.fetch(new Request('http://localhost/_zb/sync/nope'))).status, 404);
  assert.equal(await sync.fetch(new Request('http://localhost/elsewhere')), null);
  assert.deepEqual((await pull(sync)).changes, []);
});

test('authorize() decides who writes and who sees what', async () => {
  const sync = createSyncServer({ authorize: ({ request, key, write }) => (write ? request.headers.get('x-user') === 'ada' : key !== 'secret') });
  assert.equal((await push(sync, [change('title', 'x')])).status, 403);
  assert.equal((await push(sync, [change('title', 'x')], { 'x-user': 'ada' })).status, 200);
  assert.equal((await push(sync, [{ ...change('title', 'y'), key: 'secret' }], { 'x-user': 'ada' })).status, 200);
  assert.deepEqual((await pull(sync)).changes.map((c) => c.key), ['t1']);
});
