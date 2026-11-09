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

/** Read server-sent events from a live response, as `{ event, data }`. */
async function* events(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event) yield { event, data: JSON.parse(data) };
    }
  }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
const live = (sync, peer, since = 0, signal) => sync.fetch(new Request(`http://localhost/_zb/sync/live?since=${since}&peer=${peer}`, { signal }));
const say = (sync, message) => sync.fetch(new Request('http://localhost/_zb/sync/presence', { method: 'POST', body: JSON.stringify(message), headers: { 'content-type': 'application/json' } }));

test('live: the backlog, then each push as it happens', { timeout: 5000 }, async () => {
  const sync = createSyncServer();
  await push(sync, [change('title', 'before')]);
  const stream = events(await live(sync, 'p1'));
  assert.deepEqual((await stream.next()).value.data.changes.map((c) => c.value), ['before']);
  await push(sync, [change('title', 'after', '000000000000002-00000-dev2')]);
  const next = (await stream.next()).value;
  assert.equal(next.event, 'changes');
  assert.deepEqual(next.data.changes.map((c) => c.value), ['after']);
  assert.equal(next.data.cursor, 2);
  await stream.return();
});

test('presence: reaches the other viewers, not the sender; a dropped connection leaves', { timeout: 5000 }, async () => {
  const sync = createSyncServer();
  const leaving = new AbortController();
  const theirs = await live(sync, 'p1', 0, leaving.signal);
  const mine = events(await live(sync, 'p2'));
  await mine.next(); // the (empty) backlog
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'p1', state: { cursor: { x: 1 } } })).status, 200);
  assert.deepEqual((await mine.next()).value, { event: 'presence', data: { room: 'boards/b1', peer: 'p1', state: { cursor: { x: 1 } } } });
  // p1's connection drops (a crash, no goodbye): the others hear that it left.
  leaving.abort();
  await theirs.body.cancel().catch(() => {});
  assert.deepEqual((await mine.next()).value, { event: 'presence', data: { room: 'boards/b1', peer: 'p1', state: null } });
  await mine.return();
});

test('presence: malformed messages and rooms you may not join are refused', async () => {
  const sync = createSyncServer({ authorize: ({ key }) => key !== 'private' });
  assert.equal((await say(sync, { room: 'nocollection', peer: 'p1', state: {} })).status, 400);
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'bad peer!', state: {} })).status, 400);
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'p1', state: [1] })).status, 400);
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'p1', state: { big: 'x'.repeat(5000) } })).status, 400);
  assert.equal((await say(sync, { room: 'boards/private', peer: 'p1', state: {} })).status, 403);
});
