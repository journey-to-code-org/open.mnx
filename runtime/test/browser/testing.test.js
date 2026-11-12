// The testing helpers (src/testing.js) in a page: one scenario mounted through plain HTML, React
// and Vue, with events through each framework's handlers, props set the framework's way, and
// slots as its children. `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site } from './harness.js';

useBrowser({ rating: join(here, 'fixtures/rating.zb'), card: join(here, 'fixtures/card.zb') });

const src = join(here, '../../src');

const PAGE = `
import { frameworks, mount } from '${src}/testing.js';
import Rating from '/rating.js';
import Card from '/card.js';
window.run = async () => {
  const before = document.body.children.length;
  const results = {};
  const found = await frameworks();
  for (const framework of found) {
    const rating = await mount(Rating, { framework, props: { value: 1 } });
    const r = { tag: rating.element.localName, start: rating.element.querySelector('output').textContent };
    rating.element.querySelector('.two').click();
    r.after = rating.element.value;
    r.valuechange = rating.events('valuechange');
    r.all = rating.events().map(([name]) => name);
    await rating.set({ heading: 'x' });
    r.kept = rating.element.value;
    await rating.set({ value: 0 });
    r.set = [rating.element.value, rating.element.querySelector('output').textContent];
    rating.unmount();
    r.removed = !document.contains(rating.element);
    const card = await mount(Card, { framework, props: { heading: 'Hi' }, slots: { default: 'Body', title: 'Custom' } });
    r.slots = [card.element.querySelector('header').textContent.trim(), card.element.querySelector('section').textContent.trim()];
    card.unmount();
    results[framework] = r;
  }
  let error = null;
  try { await mount(class {}, {}); } catch (e) { error = e.message; }
  let unknown = null;
  try { await mount(Rating, { framework: 'svelte' }); } catch (e) { unknown = e.message; }
  return { found, results, error, unknown, left: document.body.children.length - before };
};
`;

const sameRuntime = {
  name: 'same-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^@zubra\/runtime$/ }, () => ({ path: join(src, 'index.js') }));
    builder.onResolve({ filter: /^\/[a-z-]+\.js$/ }, (args) => ({ path: join(site, args.path) }));
  },
};

before(async () => {
  const entry = join(site, 'testing-page.entry.js');
  writeFileSync(entry, PAGE);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile: join(site, 'testing-page.js'),
    plugins: [sameRuntime], logLevel: 'error', nodePaths: [join(here, '../../node_modules')],
    define: { 'process.env.NODE_ENV': '"development"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  });
});

test('one scenario through plain HTML, React and Vue', async () => {
  const { page, messages } = await open('', { modules: ['testing-page'] });
  const { found, results, error, unknown, left } = await page.evaluate(() => window.run());
  assert.deepEqual(found, ['html', 'react', 'vue'], 'React and Vue are installed here');
  for (const framework of found) {
    assert.deepEqual(results[framework], {
      tag: 'zb-rating', start: '1', after: 2, valuechange: [2], all: ['beforevaluechange', 'valuechange', 'change'],
      kept: 2, set: [0, '0'], removed: true, slots: ['Custom', 'Body'],
    }, framework);
  }
  assert.match(error, /needs a compiled zubra element/);
  assert.match(unknown, /knows html, react, vue, not "svelte"/);
  assert.equal(left, 0, 'each mount cleaned up its container');
  assert.deepEqual(messages.filter((m) => !m.includes('React DevTools')), []);
});
