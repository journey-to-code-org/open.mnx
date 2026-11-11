// Every log Sync ships keeps the same promises (log-contract.js).
import { test } from 'node:test';
import { memoryLog } from '../src/server.js';
import { sqliteLog } from '../src/sqlite.js';
import { durableObjectLog } from '../src/durable-log.js';
import { durableStorage } from './durable-storage.js';
import { logContract, latestContract } from './log-contract.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logs = {
  memoryLog: { transactional: false, make: async () => ({ log: memoryLog(), done() {} }) },
  sqliteLog: { transactional: true, make: async () => { const log = await sqliteLog(); return { log, done: () => log.close() }; } },
  durableObjectLog: { transactional: true, make: async () => { const storage = durableStorage(); return { log: durableObjectLog(storage), done: () => storage.close() }; } },
};
// The same logs keeping each field's latest value only.
const latest = {
  "memoryLog({ keep: 'latest' })": { transactional: false, make: async () => ({ log: memoryLog({ keep: 'latest' }), done() {} }) },
  "sqliteLog(…, { keep: 'latest' })": { transactional: true, make: async () => { const log = await sqliteLog(':memory:', { keep: 'latest' }); return { log, done: () => log.close() }; } },
  "durableObjectLog(…, { keep: 'latest' })": { transactional: true, make: async () => { const storage = durableStorage(); return { log: durableObjectLog(storage, { keep: 'latest' }), done: () => storage.close() }; } },
};

for (const [name, { transactional, make }] of Object.entries({ ...logs, ...latest })) {
  for (const contract of [...logContract, ...(name in latest ? latestContract : [])]) {
    test(`${name}: ${contract.name}`, { skip: contract.transactional && !transactional && 'not transactional' }, async () => {
      const { log, done } = await make();
      try {
        await contract.run(log);
      } finally {
        done();
      }
    });
  }
}

test("switching a SQLite log to keep: 'latest' carries each field's latest value across, after the old cursors", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-latest-'));
  try {
    const path = join(dir, 'sync.db');
    const old = await sqliteLog(path);
    const at = (n) => `${String(n).padStart(15, '0')}-00000-a`;
    const change = (key, field, value, n) => ({ collection: 'seats', key, field, value, clock: at(n) });
    await old.append([change('A1', 'state', 'held', 1), change('A2', 'state', 'held', 2)]);
    await old.append([change('A1', 'state', 'taken', 3), change('A1', 'by', 'ada', 3)]);
    // Two writes of one field with one clock (a push sent twice): the later row wins.
    await old.append([change('A2', 'state', 'free', 4), change('A2', 'state', 'free', 4)]);
    const oldCursor = Number((await old.after(0)).cursor);
    old.close();

    const log = await sqliteLog(path, { keep: 'latest' });
    const all = await log.after(0);
    assert.deepEqual(all.changes.map((c) => `${c.key}.${c.field}=${c.value}`), ['A1.state=taken', 'A1.by=ada', 'A2.state=free']);
    // Numbered after the old log: a device that read all of it reads the carried values again.
    assert.deepEqual((await log.after(oldCursor)).changes.length, 3);
    assert.ok(Number(all.cursor) > oldCursor);
    // And it goes on as a latest-only log; opening it again doesn't carry anything twice.
    await log.append([change('A1', 'state', 'free', 9)]);
    log.close();
    const again = await sqliteLog(path, { keep: 'latest' });
    assert.deepEqual((await again.after(0)).changes.map((c) => `${c.key}.${c.field}=${c.value}`), ['A1.by=ada', 'A2.state=free', 'A1.state=free']);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keep is 'all' or 'latest'", async () => {
  assert.throws(() => memoryLog({ keep: 'some' }), /keep/);
  await assert.rejects(sqliteLog(':memory:', { keep: 'some' }), /keep/);
  assert.throws(() => durableObjectLog(durableStorage(), { keep: 'some' }), /keep/);
});
