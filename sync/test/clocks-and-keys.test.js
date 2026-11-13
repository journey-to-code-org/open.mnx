// Security audit S1 and S2. S1: a pushed clock far in the future would win every merge for ever
// and, at 999999999999999-99999, made every server write after it throw. S2: a field named `key`
// passed one document off as another wherever documents are listed as { key, ...fields }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer, allowAnyone, memoryLog } from '../src/server.js';
import { binaryPath, startBinary } from './backends.js';

const stamp = (time, counter = 0, device = 'dev1') => `${String(time).padStart(15, '0')}-${String(counter).padStart(5, '0')}-${device}`;
const push = (sync, changes) =>
  sync.fetch(new Request('http://localhost/_zb/sync/push', { method: 'POST', body: JSON.stringify({ changes }), headers: { 'content-type': 'application/json' } }));
const change = (field, value, clock, key = 't1') => ({ collection: 'tasks', key, field, value, clock });

test('S1: a clock more than maxSkew ahead is refused, the whole push with it', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  const refused = await push(sync, [change('title', 'fine', stamp(Date.now())), change('title', 'forever', '999999999999999-99999-evil')]);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /ahead of the server's by more than maxSkew/);
  assert.equal((await sync.documents()).get('tasks', 't1'), undefined, 'nothing from that push');
  // The server still writes, after the refused push.
  const [written] = await sync.write('tasks', 't1', { title: 'from the server' });
  assert.ok(written.clock < '999999999999999', written.clock);
});

test('S1: a clock a little ahead (a device with a fast clock) is taken, and the server writes after it', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  const fast = stamp(Date.now() + 30_000, 7, 'fast');
  assert.equal((await push(sync, [change('title', 'a', fast)])).status, 200);
  const [written] = await sync.write('tasks', 't1', { title: 'b' });
  assert.ok(written.clock > fast);
  assert.equal((await sync.documents()).get('tasks', 't1').title, 'b');
});

test('S1: maxSkew is the limit, and can be set', async () => {
  const strict = createSyncServer({ authorize: allowAnyone, maxSkew: 1_000 });
  assert.equal((await push(strict, [change('a', 1, stamp(Date.now() + 5_000))])).status, 400);
  assert.equal((await push(strict, [change('a', 1, stamp(Date.now() + 500))])).status, 200);
});

test('S1: a far-future clock already in the log (from before) does not drag the server into the future or break its writes', async () => {
  const log = memoryLog();
  await log.append([change('title', 'poisoned', '999999999999999-99999-evil')]);
  const sync = createSyncServer({ authorize: allowAnyone, log });
  const written = await sync.write('tasks', 't2', { title: 'still writes', note: 'and again' });
  assert.equal(written.length, 2);
  for (const each of written) assert.ok(Number(each.clock.slice(0, 15)) < Date.now() + 60_000, each.clock);
  assert.equal((await sync.documents()).get('tasks', 't2').title, 'still writes');
});

test("S1: the server's counter carries into the next millisecond rather than outgrowing five digits", async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  const fields = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`f${i}`, i]));
  const clocks = [];
  // 120,000 writes in a few milliseconds would overflow; push one at the counter's edge instead.
  const edge = stamp(Date.now() + 20_000, 99_999, 'fast');
  await push(sync, [change('x', 1, edge)]);
  for (const each of await sync.write('tasks', 't3', fields)) clocks.push(each.clock);
  for (const clock of clocks) assert.match(clock, /^\d{15}-\d{5}-server$/, clock);
  assert.ok(clocks.every((clock) => clock > edge));
  assert.deepEqual([...clocks].sort(), clocks, 'in order');
});

test('S2: a field named key is refused in a push and in write()', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  const refused = await push(sync, [change('key', 'someone-elses-order', stamp(Date.now()))]);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /can't be named key/);
  await assert.rejects(() => sync.write('tasks', 't1', { key: 'other' }), /`key` can't be a field name/);
});

test('S2: documents().all() lists each document under its own key, whatever its fields', async () => {
  const log = memoryLog();
  // A field named key that got into a log before this check.
  await log.append([change('title', 'mine', stamp(1)), change('key', 'theirs', stamp(2))]);
  const sync = createSyncServer({ authorize: allowAnyone, log });
  const [doc] = (await sync.documents()).all('tasks');
  assert.equal(doc.key, 't1');
  assert.equal(doc.title, 'mine');
});

test("S1: a device doesn't follow a far-future stamp it hears, but does follow one a little ahead", async () => {
  const { deviceClock } = await import('../src/connect.js');
  const clocks = deviceClock('dev1');
  const poisoned = clocks.see('999999999999999-99999-evil');
  assert.ok(Number(poisoned.slice(0, 15)) < Date.now() + 60_000, poisoned);
  const near = Date.now() + 20_000;
  const followed = clocks.see(stamp(near, 5, 'fast'));
  assert.ok(Number(followed.slice(0, 15)) >= near, followed);
  assert.ok(clocks.tick() > followed, 'and keeps going from there');
});

test("S1: a device's counter carries into the next millisecond", async () => {
  const { deviceClock } = await import('../src/connect.js');
  const clocks = deviceClock('dev1');
  // Ahead of real time, every tick lands on the same millisecond until the counter runs out.
  clocks.see(stamp(Date.now() + 30_000, 0, 'fast'));
  let last = '';
  for (let i = 0; i < 100_002; i++) {
    const next = clocks.tick();
    if (!/^\d{15}-\d{5}-dev1$/.test(next) || next <= last) assert.fail(`tick ${i}: ${last} then ${next}`);
    last = next;
  }
});

test('S1 and S2 in the zubra-sync binary: far-future clocks and a field named key are refused', { skip: !binaryPath && 'binary not built' }, async () => {
  const { base, close } = await startBinary(['--open']);
  try {
    const send = (changes) => fetch(`${base}/_zb/sync/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
    const ahead = await send([change('title', 'forever', '999999999999999-99999-evil')]);
    assert.equal(ahead.status, 400);
    assert.match((await ahead.json()).error, /ahead of the server's/);
    assert.equal((await send([change('key', 'other', stamp(Date.now()))])).status, 400);
    assert.equal((await send([change('title', 'fast device', stamp(Date.now() + 30_000))])).status, 200);
    const read = await (await fetch(`${base}/_zb/sync/pull?since=0`)).json();
    assert.deepEqual(read.changes.map((c) => c.value), ['fast device']);
  } finally {
    close();
  }
});
