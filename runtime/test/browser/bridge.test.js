// Signal bridges in real apps: a store shared by a Zubra element and React 19, React 18 and Vue 3
// code, each writing it and each seeing the other's writes. `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site } from './harness.js';

const CART = "import { state, computed } from '@zubra/runtime';\nexport const cart = state([]);\nexport const total = computed(() => cart.get().length * 2);\n";
useBrowser({ 'cart-count': join(here, 'fixtures/cart-count.zb') }, { 'cart-state.js': CART });

const src = join(here, '../../src');

const REACT_APP = `
import { memo } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useSignal } from '${src}/react.js';
import { cart, total } from '/cart-state.js';
import '/cart-count.js';
// Each reader is memoized with no props, so it re-renders only when its own subscription says so.
const Deep = memo(function Deep() {
  return <p id="app">{useSignal(cart, { deep: true }).join(',')}</p>;
});
const Shallow = memo(function Shallow() {
  return <p id="shallow">{useSignal(cart).length}</p>;
});
const Total = memo(function Total() {
  return <p id="total">{useSignal(total)}</p>;
});
function App() {
  return (
    <>
      <zb-cart-count></zb-cart-count>
      <Deep />
      <Shallow />
      <Total />
      <button id="push" onClick={() => cart.get().push('app')}>push</button>
      <button id="replace" onClick={() => cart.set([...cart.get(), 'set'])}>set</button>
    </>
  );
}
const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<App />));
window.unmount = () => root.unmount();
`;

const VUE_APP = `
import { createApp, h } from 'vue';
import { useSignal } from '${src}/vue.js';
import { cart, total } from '/cart-state.js';
import '/cart-count.js';
const App = {
  setup() {
    const items = useSignal(cart, { deep: true });
    const doubled = useSignal(total);
    window.items = items;
    return () => [
      h('zb-cart-count'),
      h('p', { id: 'app' }, items.value.join(',')),
      h('p', { id: 'total' }, String(doubled.value)),
      h('button', { id: 'push', onClick: () => items.value.push('app') }, 'push'),
      h('button', { id: 'replace', onClick: () => { items.value = [...items.value, 'set']; } }, 'set'),
    ];
  },
};
const app = createApp(App);
app.mount('#root');
window.unmount = () => app.unmount();
`;

// One copy of the runtime for the app, the element and the store: everything goes in the bundle.
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
  await bundle('bridge-react19', REACT_APP);
  await bundle('bridge-react18', REACT_APP, { react: 'react18', 'react-dom': 'react-dom18' });
  await bundle('bridge-vue3', VUE_APP);
});

const read = (page) => page.evaluate(() => ({
  element: document.querySelector('zb-cart-count output').textContent,
  app: document.getElementById('app').textContent,
  total: document.getElementById('total').textContent,
  shallow: document.getElementById('shallow')?.textContent,
}));
const settle = (page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 20)));

for (const name of ['bridge-react19', 'bridge-react18', 'bridge-vue3']) {
  test(`${name}: the app and an element share a signal, both ways`, async () => {
    const react = name.includes('react');
    const { page, messages } = await open('<div id="root"></div>', { modules: [name] });
    await page.waitForSelector('zb-cart-count output');
    assert.deepEqual(await read(page), { element: '0', app: '', total: '0', shallow: react ? '0' : undefined });

    await page.click('zb-cart-count button');
    await settle(page);
    assert.deepEqual(await read(page), { element: '1', app: 'element', total: '2', shallow: react ? '0' : undefined },
      'the element pushed: the deep reader and the computed follow; the shallow reader doesn\'t (same array)');

    await page.click('#push');
    await settle(page);
    assert.deepEqual(await read(page), { element: '2', app: 'element,app', total: '4', shallow: react ? '0' : undefined },
      'the app mutated the store: the element follows');

    await page.click('#replace');
    await settle(page);
    assert.deepEqual(await read(page), { element: '3', app: 'element,app,set', total: '6', shallow: react ? '3' : undefined },
      'replacing the value reaches every reader');

    await page.evaluate(() => window.unmount());
    assert.deepEqual(messages.filter((m) => !m.includes('Download the React DevTools')), []);
  });
}
