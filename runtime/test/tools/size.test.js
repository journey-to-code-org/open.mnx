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
  // Everything, the Signals implementation included. (12 KB until 2.7, whose progressive
  // enhancement — hydrated(), the .submit and .mod modifiers, the missing-markers warning — took
  // it to 12.5 KB, and 2.8's server bridge — reading `mnx-props`, dropping form fallbacks — to
  // 13 KB.)
  'src/index.js': { gzip: 13 * 1024 },
  // The production build (the `production` export condition): the same, without hot reloading.
  'dist/production/index.js': { gzip: 12.5 * 1024 },
  // An app that only uses Signals and effects.
  'src/effect.js': { gzip: 4 * 1024 },
};

for (const [entry, budget] of Object.entries(BUDGETS)) {
  test(`${entry} fits its budget`, async (t) => {
    // Split as a bundler would: remark.js (stripped markup) is imported only when needed.
    const result = await build({ entryPoints: { entry: join(here, '../..', entry) }, bundle: true, splitting: true, outdir: '/out', minify: true, format: 'esm', write: false, logLevel: 'silent' });
    const code = result.outputFiles.find((file) => file.path.endsWith('/entry.js')).contents;
    const gzip = gzipSync(code).length;
    t.diagnostic(`${entry}: ${code.length} B minified, ${gzip} B gzip, ${brotliCompressSync(code).length} B brotli`);
    assert.ok(gzip <= budget.gzip, `${gzip} B gzip > ${budget.gzip} B`);
  });
}
