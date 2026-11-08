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
  // it to 12.5 KB, and 2.8's server bridge — reading `zb-props`, dropping form fallbacks — to
  // 13 KB, and 3.2's deep reactivity — a state's arrays and objects update the DOM when
  // mutated, `deep.js`, about 370 B — to 13.5 KB, and 4.2's zb-await — an array value waited
  // for together, retry(), delay and keep, about 320 B — to 14 KB.)
  'src/index.js': { gzip: 14 * 1024 },
  // The production build (the `production` export condition): the same, without hot reloading
  // (12.5 KB until 3.2, 13 KB until 4.2).
  'dist/production/index.js': { gzip: 13.5 * 1024 },
  // An app that only uses Signals and effects.
  'src/effect.js': { gzip: 4 * 1024 },
  // `{...spread}`'s binder (3.5), loaded only by components whose template spreads.
  'src/spread.js': { gzip: 1.5 * 1024, external: ['./element.js', './effect.js'] },
  // rovingFocus and typeahead (3.6), for menus, tab lists and toolbars.
  'src/primitives.js': { gzip: 1.25 * 1024 },
  // The Zag adapter (3.6), without Zag itself (an app's dependency, like the machines).
  'src/zag.js': { gzip: 0.5 * 1024, external: ['./element.js', '@zag-js/vanilla'] },
};

for (const [entry, budget] of Object.entries(BUDGETS)) {
  test(`${entry} fits its budget`, async (t) => {
    // Split as a bundler would: remark.js (stripped markup) is imported only when needed.
    // `external`: modules the entry shares with the main runtime, which an app already has.
    const shared = { name: 'shared', setup(build) { build.onResolve({ filter: /.*/ }, (args) => (budget.external?.includes(args.path) ? { path: args.path, external: true } : undefined)); } };
    const result = await build({ entryPoints: { entry: join(here, '../..', entry) }, bundle: true, splitting: true, outdir: '/out', minify: true, format: 'esm', write: false, logLevel: 'silent', plugins: [shared] });
    const code = result.outputFiles.find((file) => file.path.endsWith('/entry.js')).contents;
    const gzip = gzipSync(code).length;
    t.diagnostic(`${entry}: ${code.length} B minified, ${gzip} B gzip, ${brotliCompressSync(code).length} B brotli`);
    assert.ok(gzip <= budget.gzip, `${gzip} B gzip > ${budget.gzip} B`);
  });
}
