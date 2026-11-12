// Several processes starting at once on one cache folder (workers of one app, parallel test
// files): each must find every action. A process that imported a server half while another was
// rewriting it used to find none, and answered every post with 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const components = fileURLToPath(new URL('./components', import.meta.url));
const entry = new URL('../src/index.js', import.meta.url).href;
const start = (cacheDir) =>
  new Promise((done, fail) =>
    execFile(process.execPath, ['--input-type=module', '-e', `const { createActions } = await import(${JSON.stringify(entry)}); const a = await createActions({ components: ${JSON.stringify(components)}, cacheDir: ${JSON.stringify(cacheDir)} }); console.log(a.routes().length);`], (error, stdout) => (error ? fail(error) : done(Number(stdout)))),
  );

test('processes starting together on one cache folder each find every action', { timeout: 120_000 }, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'zubra-actions-cache-'));
  try {
    for (let round = 0; round < 12; round++) {
      const found = await Promise.all(Array.from({ length: 12 }, () => start(cacheDir)));
      assert.deepEqual(found, Array(12).fill(3), `round ${round}`);
    }
    assert.deepEqual(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp')), [], 'nothing half-written is left');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
