// Leaks: elements that are removed (by hand, or by React and Vue unmounting them) can be
// garbage-collected, even when they read a signal that outlives them. Counted with the DevTools
// protocol: force a collection, then count the live instances of each element class.
// `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site, engine } from './harness.js';

// The DevTools protocol is Chromium's.
const skip = engine !== 'chromium' && 'counting live objects needs Chromium';

useBrowser({
  shared: join(here, 'fixtures/shared.mnx'),
  card: join(here, 'fixtures/card.mnx'),
  rating: join(here, 'fixtures/rating.mnx'),
  badge: join(here, 'fixtures/badge.mnx'),
  inbox: join(here, 'fixtures/inbox.mnx'),
}, {
  'shared-state.js': "import { state } from '@mnx/runtime';\nexport const shared = state(1);\nwindow.shared = shared;\n",
});

const src = join(here, '../../src');
const pageModules = {
  name: 'page-modules',
  setup(builder) {
    builder.onResolve({ filter: /^\/[a-z-]+\.js$/ }, (args) => ({ path: args.path, external: true }));
  },
};

before(async () => {
  const entry = join(site, 'leak-apps.entry.jsx');
  writeFileSync(entry, `
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { createApp, h } from 'vue';
    import { wrap as react } from '${src}/react.js';
    import { wrap as vue } from '${src}/vue.js';
    import Card from '/card.js';
    import Rating from '/rating.js';
    const ReactCard = react(Card), ReactRating = react(Rating);
    const VueCard = vue(Card), VueRating = vue(Rating);
    window.mountReact = (count) => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const rows = Array.from({ length: count }, (_, i) => (
        <ReactCard key={i} heading={'h' + i}><p>{i}</p><ReactRating value={i % 3} onValueChange={() => {}} /></ReactCard>
      ));
      flushSync(() => root.render(<>{rows}</>));
      return () => { flushSync(() => root.unmount()); host.remove(); };
    };
    window.mountVue = (count) => {
      const host = document.createElement('div');
      document.body.append(host);
      const app = createApp({ render: () => Array.from({ length: count }, (_, i) =>
        h(VueCard, { key: i, heading: 'h' + i }, { default: () => [h('p', String(i)), h(VueRating, { modelValue: i % 3 })] })) });
      app.mount(host);
      return () => { app.unmount(); host.remove(); };
    };
  `);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile: join(site, 'leak-apps.js'), jsx: 'automatic',
    plugins: [pageModules], logLevel: 'error', nodePaths: [join(here, '../../node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  });
});

/** Live instances of each tag's element class, after a forced garbage collection. */
async function live(page, tags) {
  const client = await page.context().newCDPSession(page);
  const counts = {};
  for (let round = 0; round < 3; round++) await client.send('HeapProfiler.collectGarbage');
  for (const tag of tags) {
    const { result: prototype } = await client.send('Runtime.evaluate', { expression: `customElements.get(${JSON.stringify(tag)}).prototype` });
    const { objects } = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId });
    const { result } = await client.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
    counts[tag] = result.value;
    await client.send('Runtime.releaseObject', { objectId: objects.objectId });
  }
  await client.detach();
  return counts;
}

const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all([...document.querySelectorAll('*')].filter((el) => el.localName.startsWith('mnx-')).map((el) => el.updateComplete));
});

test('removed elements are collected, even when they read a signal that outlives them', { skip }, async () => {
  const { page, messages } = await open('<div id="box"></div>', { modules: ['shared', 'card', 'badge', 'inbox'] });
  await page.evaluate(() => {
    const box = document.getElementById('box');
    for (let i = 0; i < 100; i++) {
      box.insertAdjacentHTML('beforeend', `<mnx-shared><span>${i}</span></mnx-shared><mnx-card heading="c${i}"><p>${i}</p></mnx-card><mnx-inbox></mnx-inbox>`);
    }
  });
  await settle(page);
  assert.deepEqual(await live(page, ['mnx-shared', 'mnx-card', 'mnx-inbox', 'mnx-badge']), { 'mnx-shared': 100, 'mnx-card': 100, 'mnx-inbox': 100, 'mnx-badge': 200 });
  // Work while connected: the shared signal changes, rows re-render.
  await page.evaluate(() => { window.shared.set(2); });
  await settle(page);
  await page.evaluate(() => { document.getElementById('box').replaceChildren(); window.shared.set(3); });
  await settle(page);
  assert.deepEqual(await live(page, ['mnx-shared', 'mnx-card', 'mnx-inbox', 'mnx-badge']), { 'mnx-shared': 0, 'mnx-card': 0, 'mnx-inbox': 0, 'mnx-badge': 0 });
  assert.deepEqual(messages, []);
  await page.close();
});

for (const framework of ['React', 'Vue']) {
  test(`elements ${framework} unmounts are collected`, { skip }, async () => {
    const { page, messages } = await open('', { modules: ['card', 'rating', 'leak-apps'] });
    await page.evaluate((name) => { window.unmount = window[`mount${name}`](100); }, framework);
    await settle(page);
    assert.deepEqual(await live(page, ['mnx-card', 'mnx-rating']), { 'mnx-card': 100, 'mnx-rating': 100 });
    await page.evaluate(() => window.unmount());
    await page.evaluate(() => { delete window.unmount; });
    await settle(page);
    assert.deepEqual(await live(page, ['mnx-card', 'mnx-rating']), { 'mnx-card': 0, 'mnx-rating': 0 });
    assert.deepEqual(messages.filter((message) => !/You are running a development build of Vue/.test(message)), []);
    await page.close();
  });
}
