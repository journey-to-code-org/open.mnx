import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncServer } from '../src/server.js';
import { sqliteLog } from '../src/sqlite.js';

const change = (field, value, clock) => ({ collection: 'tasks', key: 't1', field, value, clock });
const push = (sync, changes) =>
  sync.fetch(new Request('http://localhost/_zb/sync/push', { method: 'POST', body: JSON.stringify({ changes }), headers: { 'content-type': 'application/json' } }));
const pull = async (sync, since = 0) => (await sync.fetch(new Request(`http://localhost/_zb/sync/pull?since=${since}`))).json();

test('the log survives a restart: same changes, same cursors, JSON values intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-sync-'));
  const path = join(dir, 'sync.db');
  try {
    const first = await sqliteLog(path);
    const before = createSyncServer({ log: first });
    await push(before, [change('title', 'Buy milk', '000000000000001-00000-a'), change('tags', ['x', { y: 1 }], '000000000000001-00001-a')]);
    await push(before, [change('done', true, '000000000000002-00000-b')]);
    first.close();

    const after = createSyncServer({ log: await sqliteLog(path) });
    const all = await pull(after);
    assert.deepEqual(all.changes.map((c) => c.value), ['Buy milk', ['x', { y: 1 }], true]);
    assert.equal(all.cursor, 3);
    assert.deepEqual((await pull(after, 2)).changes.map((c) => c.field), ['done']);
    assert.equal((await pull(after, 3)).cursor, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pages through a long log', async () => {
  const log = await sqliteLog();
  await log.append(Array.from({ length: 5 }, (_, i) => change('n', i, `00000000000000${i}-00000-a`)));
  const page = await log.after(0, 2);
  assert.deepEqual(page.changes.map((c) => c.value), [0, 1]);
  assert.equal(page.cursor, 2);
  assert.deepEqual((await log.after(page.cursor, 10)).changes.map((c) => c.value), [2, 3, 4]);
  log.close();
});

test('the live stream sends a backlog longer than one page before anything live', { timeout: 5000 }, async () => {
  const log = await sqliteLog();
  const paged = { append: (c) => log.append(c), after: (cursor) => log.after(cursor, 2) };
  await log.append(Array.from({ length: 5 }, (_, i) => change('n', i, `00000000000000${i}-00000-a`)));
  const sync = createSyncServer({ log: paged });
  const response = await sync.fetch(new Request('http://localhost/_zb/sync/live?since=0&peer=p1'));
  const reader = response.body.getReader();
  let text = '';
  while ((text.match(/event: changes/g) ?? []).length < 3) text += new TextDecoder().decode((await reader.read()).value);
  const values = [...text.matchAll(/^data: (.*)$/gm)].flatMap(([, data]) => JSON.parse(data).changes.map((c) => c.value));
  assert.deepEqual(values, [0, 1, 2, 3, 4]);
  await reader.cancel();
  log.close();
});

import { binaryPath, startBinary } from './backends.js';

test('the binary reads and extends the same SQLite file as sqliteLog()', { skip: !binaryPath && 'zubra-sync not built' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-sync-'));
  const path = join(dir, 'shared.db');
  try {
    const log = await sqliteLog(path);
    await log.append([change('title', 'From Node', '000000000000001-00000-a'), change('tags', ['x', { y: 1 }], '000000000000001-00001-a')]);
    log.close();
    const binary = await startBinary(['--db', path]);
    try {
      const pulled = await (await fetch(`${binary.base}/_zb/sync/pull?since=0`)).json();
      assert.deepEqual(pulled.changes.map((c) => c.value), ['From Node', ['x', { y: 1 }]]);
      assert.equal(pulled.cursor, 2);
      const pushed = await fetch(`${binary.base}/_zb/sync/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [change('done', true, '000000000000002-00000-b')] }) });
      assert.equal(pushed.status, 200);
    } finally {
      binary.close();
    }
    const reopened = await sqliteLog(path);
    assert.deepEqual((await reopened.after(0)).changes.map((c) => c.value), ['From Node', ['x', { y: 1 }], true]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
