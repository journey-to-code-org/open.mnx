// <zb-context> and the React and Vue ZubraContext components: context from the app's own code,
// answered on the Context Protocol, so components read it with inject(). `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site } from './harness.js';

useBrowser(
  { 'theme-label': join(here, 'fixtures/theme-label.zb') },
  { 'theme.js': `import { createContext } from '@zubra/runtime';\nexport const theme = createContext('light');\n` },
  { '@zubra/runtime/context': '/runtime/context.js' },
);

const src = join(here, '../../src');

const REACT_APP = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ZubraContext } from '${src}/react.js';
import { theme } from '/theme.js';
import '/theme-label.js';
function App() {
  const [mode, setMode] = useState('dark');
  const [shown, setShown] = useState(true);
  window.set = { setMode, setShown };
  return (
    <>
      <ZubraContext context={theme} value={mode}>
        <div><zb-theme-label id="inside"></zb-theme-label></div>
        <ZubraContext context={theme} value="sepia"><zb-theme-label id="nested"></zb-theme-label></ZubraContext>
        {shown && <zb-theme-label id="later"></zb-theme-label>}
      </ZubraContext>
      <zb-theme-label id="outside"></zb-theme-label>
    </>
  );
}
const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<App />));
window.update = (fn) => flushSync(() => fn(window.set));
`;

const VUE_APP = `
import { createApp, h, ref } from 'vue';
import { ZubraContext } from '${src}/vue.js';
import { theme } from '/theme.js';
import '/theme-label.js';
const mode = ref('dark'), shown = ref(true);
window.set = { setMode: (v) => { mode.value = v; }, setShown: (v) => { shown.value = v; } };
const App = {
  setup() {
    return () => [
      h(ZubraContext, { context: theme, value: mode.value }, () => [
        h('div', [h('zb-theme-label', { id: 'inside' })]),
        h(ZubraContext, { context: theme, value: 'sepia' }, () => [h('zb-theme-label', { id: 'nested' })]),
        shown.value ? h('zb-theme-label', { id: 'later' }) : null,
      ]),
      h('zb-theme-label', { id: 'outside' }),
    ];
  },
};
createApp(App).mount('#root');
window.update = async (fn) => { fn(window.set); await new Promise((r) => setTimeout(r)); };
`;

// One copy of the runtime for the app and the elements.
const sameRuntime = {
  name: 'same-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^@zubra\/runtime$/ }, () => ({ path: join(src, 'index.js') }));
    builder.onResolve({ filter: /^\/[a-z-]+\.js$/ }, (args) => ({ path: join(site, args.path) }));
  },
};

async function bundle(name, source, alias = {}) {
  const entry = join(site, `${name}.entry.jsx`);
  writeFileSync(entry, source);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile: join(site, `${name}.js`),
    jsx: 'automatic', alias, plugins: [sameRuntime], logLevel: 'error',
    nodePaths: [join(here, '../../node_modules')],
    define: {
      'process.env.NODE_ENV': '"development"',
      __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
}

before(async () => {
  await bundle('context-react19', REACT_APP);
  await bundle('context-react18', REACT_APP, { react: 'react18', 'react-dom': 'react-dom18' });
  await bundle('context-vue3', VUE_APP);
});

const labels = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return Object.fromEntries([...document.querySelectorAll('zb-theme-label')].map((el) => [el.id, el.querySelector('span').textContent]));
});

test('plain HTML: <zb-context> answers inject(), a signal value is followed, and a late context is picked up', async () => {
  const { page, messages } = await open(`
    <zb-context id="ctx"><zb-theme-label id="inside"></zb-theme-label></zb-context>
    <zb-theme-label id="outside"></zb-theme-label>`, {
    modules: ['theme-label'],
    beforeModules: "const { theme } = await import('/theme.js'); await import('@zubra/runtime/context'); window.theme = theme;",
  });
  assert.deepEqual(await labels(page), { inside: 'light', outside: 'light' }, 'no context set yet: the default');
  assert.equal(await page.$eval('#ctx', (el) => getComputedStyle(el).display), 'contents');

  await page.evaluate(() => { const ctx = document.getElementById('ctx'); ctx.value = 'dark'; ctx.context = window.theme; });
  assert.deepEqual(await labels(page), { inside: 'dark', outside: 'light' }, 'given its context later: the consumer asked again');

  await page.evaluate(() => { document.getElementById('ctx').value = 'sepia'; });
  assert.deepEqual(await labels(page), { inside: 'sepia', outside: 'light' }, 'a new value reaches subscribers');

  await page.evaluate(async () => {
    const { Signal } = await import('@zubra/runtime');
    window.mode = new Signal.State('night');
    document.getElementById('ctx').value = window.mode;
  });
  assert.deepEqual(await labels(page), { inside: 'night', outside: 'light' }, 'a signal value: its current value');
  await page.evaluate(() => window.mode.set('day'));
  assert.deepEqual(await labels(page), { inside: 'day', outside: 'light' }, 'and its changes');

  await page.evaluate(() => { document.getElementById('ctx').value = 'plain'; window.mode.set('ignored'); });
  assert.deepEqual(await labels(page), { inside: 'plain', outside: 'light' }, 'a replaced signal is no longer followed');
  assert.deepEqual(messages, []);
});

for (const name of ['context-react19', 'context-react18', 'context-vue3']) {
  test(`${name}: ZubraContext provides to the elements inside it`, async () => {
    const { page, messages } = await open('<div id="root"></div>', { modules: [name] });
    assert.deepEqual(await labels(page), { inside: 'dark', nested: 'sepia', later: 'dark', outside: 'light' },
      'the nearest provider answers; outside, the default');
    await page.evaluate(() => window.update((set) => set.setMode('light')));
    assert.deepEqual(await labels(page), { inside: 'light', nested: 'sepia', later: 'light', outside: 'light' }, 'the app changed the value');
    await page.evaluate(() => window.update((set) => set.setShown(false)));
    await page.evaluate(() => window.update((set) => { set.setShown(true); set.setMode('dark'); }));
    assert.deepEqual(await labels(page), { inside: 'dark', nested: 'sepia', later: 'dark', outside: 'light' }, 'an element added later is answered');
    assert.deepEqual(messages.filter((m) => !m.includes('React DevTools')), []);
  });
}
