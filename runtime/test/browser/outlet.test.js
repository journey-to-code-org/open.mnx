// Outlets (experimental, src/outlet.js): a Zubra list asks React to render each row, and the
// rows are part of the React tree: context, state and handlers work, keyed moves keep state,
// and rows come and go with the list. `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site } from './harness.js';

useBrowser({ 'outlet-list': join(here, 'fixtures/outlet-list.zb') });

const src = join(here, '../../src');

const REACT_APP = `
import { createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { wrap } from '${src}/react.js';
import Element from '/outlet-list.js';
const List = wrap(Element);
const Theme = createContext('none');
window.clicked = [];
window.mounted = new Set();
function Row({ item }) {
  const theme = useContext(Theme);
  const [count, setCount] = useState(0);
  useEffect(() => {
    window.mounted.add(item.id);
    return () => window.mounted.delete(item.id);
  }, []);
  return <button className="row" onClick={() => { setCount(count + 1); window.clicked.push(item.id); }}>{item.name}:{theme}:{count}</button>;
}
function App() {
  const [items, setItems] = useState([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  const [theme, setTheme] = useState('dark');
  window.set = { setItems, setTheme };
  return (
    <Theme.Provider value={theme}>
      <List items={items} renderRow={(item) => <Row item={item} />} renderSummary={(n) => <b>{n} rows</b>} />
    </Theme.Provider>
  );
}
const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<App />));
window.update = (fn) => flushSync(() => fn(window.set));
window.unmount = () => root.unmount();
`;

const sameRuntime = {
  name: 'same-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^@zubra\/runtime$/ }, () => ({ path: join(src, 'index.js') }));
    builder.onResolve({ filter: /^@zubra\/runtime\/[a-z]+$/ }, (args) => ({ path: join(src, `${args.path.split('/').pop()}.js`) }));
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
    define: { 'process.env.NODE_ENV': '"development"' },
  });
}

before(async () => {
  await bundle('outlet-react19', REACT_APP);
  await bundle('outlet-react18', REACT_APP, { react: 'react18', 'react-dom': 'react-dom18' });
});

const rows = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    rows: [...document.querySelectorAll('zb-outlet-list li')].map((li) => `${li.dataset.id}=${li.querySelector('zb-outlet').textContent}`),
    summary: document.querySelector('zb-outlet-list footer').textContent,
  };
});

for (const name of ['outlet-react19', 'outlet-react18']) {
  test(`${name}: render props fill the element's outlets as part of the React tree`, async () => {
    const { page, messages } = await open('<div id="root"></div>', { modules: [name] });
    await page.waitForSelector('zb-outlet-list li .row');
    assert.deepEqual(await rows(page), { rows: ['1=a:dark:0', '2=b:dark:0'], summary: '2 rows' },
      "each row rendered in its outlet, with the app's context");

    await page.click('li[data-id="2"] .row');
    await page.click('li[data-id="2"] .row');
    assert.deepEqual((await rows(page)).rows, ['1=a:dark:0', '2=b:dark:2'], 'React state and handlers work in an outlet');
    assert.deepEqual(await page.evaluate(() => window.clicked), [2, 2]);

    await page.evaluate(() => window.update((set) => set.setTheme('light')));
    assert.deepEqual((await rows(page)).rows, ['1=a:light:0', '2=b:light:2'], 'a context change reaches the rows');

    await page.evaluate(() => window.update((set) => set.setItems([{ id: 2, name: 'b' }, { id: 1, name: 'a' }])));
    assert.deepEqual((await rows(page)).rows, ['2=b:light:2', '1=a:light:0'], "a keyed move keeps each row's state");

    await page.evaluate(() => window.update((set) => set.setItems([{ id: 2, name: 'B' }, { id: 3, name: 'c' }])));
    assert.deepEqual(await rows(page), { rows: ['2=B:light:2', '3=c:light:0'], summary: '2 rows' },
      'a new item for a kept row re-renders it; a removed row goes, a new one comes');

    await page.evaluate(() => window.update((set) => set.setItems([])));
    assert.deepEqual(await rows(page), { rows: [], summary: '0 rows' });
    assert.deepEqual(await page.evaluate(() => [...window.mounted]), [], 'the rows of removed outlets are unmounted');
    await page.evaluate(() => window.unmount());
    assert.deepEqual(messages.filter((m) => !m.includes('React DevTools')), []);
  });
}
