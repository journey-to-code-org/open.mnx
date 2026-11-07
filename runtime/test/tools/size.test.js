// Size budgets: the runtime as an app ships it (bundled, minified, compressed). A budget is
// raised only on purpose, in the same change as what needed the bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const BUDGETS = {
  // Everything, the Signals implementation included.
  'src/index.js': { gzip: 12 * 1024 },
  // An app that only uses Signals and effects.
  'src/effect.js': { gzip: 4 * 1024 },
};

for (const [entry, budget] of Object.entries(BUDGETS)) {
  test(`${entry} fits its budget`, async (t) => {
    const result = await build({ entryPoints: [join(here, '../..', entry)], bundle: true, minify: true, format: 'esm', write: false, logLevel: 'silent' });
    const code = result.outputFiles[0].contents;
    const gzip = gzipSync(code).length;
    t.diagnostic(`${entry}: ${code.length} B minified, ${gzip} B gzip, ${brotliCompressSync(code).length} B brotli`);
    assert.ok(gzip <= budget.gzip, `${gzip} B gzip > ${budget.gzip} B`);
  });
}
