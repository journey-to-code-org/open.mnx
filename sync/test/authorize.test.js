// Who may write: without `authorize`, pages read but don't write (security audit K2). With it,
// each change is asked with its field and value (S6), so an app can keep fields for the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer, allowAnyone } from '../src/server.js';
import { syncObject } from '../src/durable-core.js';
import { durableStorage } from './durable-storage.js';
import { binaryPath, startBinary } from './backends.js';

const clock = (n) => `00000000000000${n}-00000-dev1`;
const change = (field, value, n = 1, collection = 'tasks') => ({ collection, key: 't1', field, value, clock: clock(n) });
const post = (sync, path, body) =>
  sync.fetch(new Request(`http://localhost/_zb/sync/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
const pull = async (sync) => (await sync.fetch(new Request('http://localhost/_zb/sync/pull?since=0'))).json();
const room = { room: 'tasks/t1', peer: 'p1', state: { name: 'Ada' } };
const signal = { room: 'tasks/t1', from: 'p1', to: 'p2', data: { sdp: 'x' } };

test('without authorize, a page may not push, join or signal, and is told why', async () => {
  const sync = createSyncServer();
  const pushed = await post(sync, 'push', { changes: [change('title', 'free beef')] });
  assert.equal(pushed.status, 403);
  assert.match((await pushed.json()).error, /takes no writes from pages until it is told who may make them: pass createSyncServer\(\{ authorize \}\)/);
  assert.deepEqual((await pull(sync)).changes, [], 'nothing reached the log');
  assert.equal((await sync.documents()).get('tasks', 't1'), undefined);
  for (const [path, body] of [['presence', room], ['signal', signal]]) {
    const answer = await post(sync, path, body);
    assert.equal(answer.status, 403, path);
    assert.match((await answer.json()).error, /authorize/, path);
  }
});

test('without authorize, pages still read, and the server still writes', async () => {
  const sync = createSyncServer();
  await sync.write('tasks', 't1', { title: 'from the server' });
  const read = await pull(sync);
  assert.deepEqual(read.changes.map((c) => c.value), ['from the server']);
});

test('allowAnyone opens writes to every page', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  assert.equal((await post(sync, 'push', { changes: [change('title', 'a')] })).status, 200);
  assert.equal((await post(sync, 'presence', room)).status, 200);
  assert.equal((await post(sync, 'signal', signal)).status, 200);
  assert.equal((await sync.documents()).get('tasks', 't1').title, 'a');
});

test("authorize is asked each change's field and value, so fields can be the server's alone", async () => {
  const asked = [];
  const sync = createSyncServer({
    authorize: (from) => {
      if (from.kind === 'change') asked.push([from.collection, from.key, from.field, from.value, from.write]);
      return from.kind !== 'change' || (from.collection === 'tasks' && from.field !== 'price');
    },
  });
  assert.equal((await post(sync, 'push', { changes: [change('title', 'a'), change('done', true, 2)] })).status, 200);
  assert.deepEqual(asked, [['tasks', 't1', 'title', 'a', true], ['tasks', 't1', 'done', true, true]]);
  const refused = await post(sync, 'push', { changes: [change('title', 'b', 3), change('price', 5, 4)] });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'Not yours to change', "an app's own refusal keeps its wording");
  assert.equal((await sync.documents()).get('tasks', 't1').title, 'a', 'all or nothing: the title in the same push was refused too');
  assert.equal((await post(sync, 'push', { changes: [change('qty', 1, 5, 'payments')] })).status, 403, 'a whole collection can be the server\'s');
});

test('authorize must be a function', () => {
  assert.throws(() => createSyncServer({ authorize: true }), /`authorize` is a function/);
  assert.throws(() => createSyncServer({ authorize: 'anyone' }), /`authorize` is a function/);
});

test('a Durable Object without an authorize of its own takes reads only; with one, it decides', async () => {
  const bare = syncObject({ storage: durableStorage() }, {});
  const pushed = await post(bare, 'push', { changes: [change('title', 'x')] });
  assert.equal(pushed.status, 403);
  assert.match((await pushed.json()).error, /authorize/);
  await bare.write('tasks', 't1', { title: 'server' });
  assert.equal((await pull(bare)).changes.length, 1, 'reads and server writes still work');

  const open = syncObject({ storage: durableStorage() }, { authorize: ({ field }) => field !== 'secret' });
  assert.equal((await post(open, 'push', { changes: [change('title', 'x')] })).status, 200);
  assert.equal((await post(open, 'push', { changes: [change('secret', 'x', 2)] })).status, 403, "the object's authorize sees the field");
});

test('the zubra-sync binary takes no writes from pages unless started with --open', { skip: !binaryPath && 'binary not built' }, async () => {
  for (const [args, status] of [[[], 403], [['--open'], 200]]) {
    const { base, close } = await startBinary(args);
    try {
      const send = (path, body) => fetch(`${base}/_zb/sync/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const pushed = await send('push', { changes: [change('title', 'x')] });
      assert.equal(pushed.status, status, `push ${args.join(' ') || '(closed)'}`);
      if (status === 403) assert.match((await pushed.json()).error, /start zubra-sync with --open/);
      assert.equal((await send('presence', room)).status, status, `presence ${args.join(' ') || '(closed)'}`);
      assert.equal((await send('signal', signal)).status, status, `signal ${args.join(' ') || '(closed)'}`);
      const read = await (await fetch(`${base}/_zb/sync/pull?since=0`)).json();
      assert.equal(read.changes.length, status === 200 ? 1 : 0, 'reads always work');
    } finally {
      close();
    }
  }
});
