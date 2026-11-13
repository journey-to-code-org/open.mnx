import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer, allowAnyone } from '../src/server.js';
import { durableObjectLog } from '../src/durable-log.js';
import { durableStorage } from './durable-storage.js';

const change = (field, value, clock) => ({ collection: 'tasks', key: 't1', field, value, clock });

test('an object that restarts finds its log: same changes, same cursor, and the documents rebuilt', async () => {
  const storage = durableStorage();
  const before = createSyncServer({ authorize: allowAnyone, log: durableObjectLog(storage) });
  await before.write('tasks', 't1', { title: 'Buy milk', done: false });
  await before.write('tasks', 't1', { done: true });

  // A Durable Object evicted from memory comes back with only its storage.
  const after = createSyncServer({ authorize: allowAnyone, log: durableObjectLog(storage) });
  assert.deepEqual((await after.documents()).get('tasks', 't1'), { title: 'Buy milk', done: true });
  const pulled = await (await after.fetch(new Request('http://localhost/_zb/sync/pull?since=0'))).json();
  assert.equal(pulled.cursor, 3);
  // Its clock carries on past what it wrote before the restart.
  const [next] = await after.write('tasks', 't1', { done: false });
  assert.ok(next.clock > pulled.changes[2].clock);
  storage.close();
});

test("the table is the object's to name, beside tables of its own", async () => {
  const storage = durableStorage();
  storage.sql.exec('CREATE TABLE changes (id INTEGER PRIMARY KEY, note TEXT)');
  storage.sql.exec("INSERT INTO changes (note) VALUES ('the app’s own')");
  const log = durableObjectLog(storage, { table: 'sync_log' });
  await log.append([change('title', 'A', '000000000000001-00000-a')]);
  assert.deepEqual((await log.after(0)).changes.map((c) => c.value), ['A']);
  assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM changes').one().n, 1);
  storage.close();
});

test('refuses what is not a SQLite-backed storage, and a table name that is not a name', () => {
  assert.throws(() => durableObjectLog({}), /ctx\.storage/);
  assert.throws(() => durableObjectLog({ get() {}, put() {} }), /SQLite-backed/);
  const storage = durableStorage();
  for (const table of ['changes; DROP TABLE x', '1st', 'a b', '']) assert.throws(() => durableObjectLog(storage, { table }), /plain SQL name/, table);
  storage.close();
});
