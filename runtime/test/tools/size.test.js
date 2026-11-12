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
  // for together, retry(), delay and keep, about 320 B — to 14 KB, and the DevTools hook's
  // recording side — what each effect binds, each flush, each listener, about 490 B; its reading
  // side loads only when the extension connects — to 14.5 KB. The production build has none of it.
  // And `animate`'s hooks in zb-if and zb-each — about 160 B; leave() and glide() themselves are
  // `src/motion.js`, loaded only by components that animate — to 15 KB, and the list work for
  // the js-framework-benchmark — a keyed zb-each moving only the rows out of order, about 125 B —
  // to 15.25 KB. Clearing a list that is all its parent holds by emptying the parent, about
  // 120 B more, fits within it. The faster Signals core — getPending() in O(pending), nodes in
  // private fields, lazy arrays and children, about 420 B — took it to 15.75 KB, and rows put on
  // the page without markers, cloned from a copy already in the document, with text written in
  // place, about 100 B, to 16 KB.)
  'src/index.js': { gzip: 16 * 1024 },
  // The production build (the `production` export condition): the same, without hot reloading
  // (12.5 KB until 3.2, 13 KB until 4.2, 13.5 KB until `animate`, 14 KB until the list work,
  // 14.25 KB until the faster Signals core, 14.75 KB until rows without markers).
  'dist/production/index.js': { gzip: 15 * 1024 },
  // An app that only uses Signals and effects.
  'src/effect.js': { gzip: 4 * 1024 },
  // `animate`'s leave() and glide(), loaded only by components that animate.
  'src/motion.js': { gzip: 1.25 * 1024 },
  // `tracked()`: reads after an `await` in a resource's fetcher, loaded only by components with
  // an async fetcher.
  'src/track.js': { gzip: 0.75 * 1024, external: ['./signal.js', './effect.js'] },
  // `{...spread}`'s binder (3.5), loaded only by components whose template spreads. (1.5 KB until
  // spread onto a Zubra component — its props as props, unset when their key goes, about 110 B.)
  'src/spread.js': { gzip: 1.75 * 1024, external: ['./element.js', './effect.js'] },
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
    const result = await build({ entryPoints: { entry: join(here, '../..', entry) }, bundle: true, splitting: true, outdir: '/out', minify: true, format: 'esm', write: false, logLevel: 'silent', plugins: [shared], metafile: true });
    // The entry and the chunks it imports statically: code a lazily loaded module shares with
    // the entry lands in a chunk of its own, and is still shipped up front.
    const outputs = result.metafile.outputs;
    const loaded = new Set();
    const load = (path) => {
      if (loaded.has(path)) return;
      loaded.add(path);
      for (const { path: next, kind } of outputs[path].imports) if (kind === 'import-statement' && outputs[next]) load(next);
    };
    load(Object.keys(outputs).find((path) => path.endsWith('/entry.js')));
    const names = new Set([...loaded].map((path) => path.split('/').pop()));
    const files = result.outputFiles.filter((file) => names.has(file.path.split('/').pop()));
    const code = Buffer.concat(files.map((file) => file.contents));
    const gzip = gzipSync(code).length;
    t.diagnostic(`${entry}: ${code.length} B minified, ${gzip} B gzip, ${brotliCompressSync(code).length} B brotli`);
    assert.ok(gzip <= budget.gzip, `${gzip} B gzip > ${budget.gzip} B`);
  });
}
