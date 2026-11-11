// @zubra/sync's log contract, in workerd: durableObjectLog over a Durable Object's own storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorker } from './wrangler.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'contract');

test("every log contract case passes on a Durable Object's SQLite", { timeout: 120_000 }, async () => {
  const worker = await startWorker(dir, ['--config', join(dir, 'wrangler.jsonc')]);
  try {
    const results = await (await fetch(worker.url)).json();
    assert.ok(results.length >= 8, `ran ${results.length} cases`);
    assert.deepEqual(results.filter((r) => !r.ok), []);
  } finally {
    await worker.stop();
  }
});
