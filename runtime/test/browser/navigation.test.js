// Links inside components through the app's router (src/navigation.js): plain HTML with a
// hand-written router, React Router and Vue Router. A routed link changes the URL without
// reloading the page; the links it must leave alone stay links. `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site } from './harness.js';

useBrowser({ 'nav-links': join(here, 'fixtures/nav-links.zb') }, {}, { '@zubra/runtime/navigation': '/runtime/navigation.js' });

const src = join(here, '../../src');

const REACT_APP = `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createBrowserRouter, RouterProvider, Outlet, Link, useNavigate, useLocation } from 'react-router';
import { useRouteLinks } from '${src}/react.js';
import '/nav-links.js';
function Layout() {
  useRouteLinks(useNavigate());
  const location = useLocation();
  return (
    <>
      <zb-nav-links><Link className="framework" to="/c">C</Link></zb-nav-links>
      <a className="app" href="/d">D</a>
      <p id="route">{location.pathname + location.search + location.hash}</p>
      <Outlet />
    </>
  );
}
const router = createBrowserRouter([{ path: '*', element: <Layout /> }]);
window.routed = [];
router.subscribe((state) => window.routed.push(state.location.pathname));
createRoot(document.getElementById('root')).render(<RouterProvider router={router} />);
`;

const VUE_APP = `
import { createApp, h } from 'vue';
import { createRouter, createWebHistory, useRoute, RouterView } from 'vue-router';
import { useRouteLinks } from '${src}/vue.js';
import '/nav-links.js';
const Page = { render: () => null };
const router = createRouter({ history: createWebHistory(), routes: [{ path: '/:any(.*)*', component: Page }] });
window.routed = [];
router.afterEach((to) => window.routed.push(to.path));
const App = {
  setup() {
    useRouteLinks((to) => router.push(to));
    const route = useRoute();
    return () => [
      h('zb-nav-links'),
      h('a', { class: 'app', href: '/d' }, 'D'),
      h('p', { id: 'route' }, route.fullPath),
      h(RouterView),
    ];
  },
};
createApp(App).use(router).mount('#root');
`;

const sameRuntime = {
  name: 'same-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^@zubra\/runtime$/ }, () => ({ path: join(src, 'index.js') }));
    builder.onResolve({ filter: /^\/[a-z-]+\.js$/ }, (args) => ({ path: join(site, args.path) }));
  },
};

async function bundle(name, source) {
  const entry = join(site, `${name}.entry.jsx`);
  writeFileSync(entry, source);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile: join(site, `${name}.js`),
    jsx: 'automatic', plugins: [sameRuntime], logLevel: 'error',
    nodePaths: [join(here, '../../node_modules')],
    define: {
      'process.env.NODE_ENV': '"development"',
      __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
}

before(async () => {
  await bundle('nav-react', REACT_APP);
  await bundle('nav-vue', VUE_APP);
});

// A marker on the window: gone if the page reloaded.
const mark = (page) => page.evaluate(() => { window.marker = 'kept'; });
const kept = (page) => page.evaluate(() => window.marker === 'kept');
const path = (page) => page.evaluate(() => location.pathname + location.search + location.hash);
// What a click would have done, without leaving the page: the default not prevented.
const leftAlone = (page, selector, init = {}) => page.evaluate(([selector, init]) => {
  let prevented = null;
  const look = (event) => { prevented = event.defaultPrevented; event.preventDefault(); };
  window.addEventListener('click', look, { once: true });
  const link = document.querySelector(selector);
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0, ...init }));
  return prevented;
}, [selector, init]);

test('plain HTML: routeLinks hands the router the path; the links it must leave alone are left alone', async () => {
  const { page, messages } = await open('<zb-nav-links></zb-nav-links><a class="app" href="/d">D</a>', {
    modules: ['nav-links'],
    beforeModules: `
      const { routeLinks } = await import('@zubra/runtime/navigation');
      window.routed = [];
      window.stop = routeLinks((to, { anchor }) => { window.routed.push([to, anchor.className]); history.pushState(null, '', to); });`,
  });
  await mark(page);
  await page.click('zb-nav-links .go');
  assert.deepEqual(await page.evaluate(() => window.routed), [['/b?x=1#top', 'go']]);
  assert.equal(await path(page), '/b?x=1#top');
  assert.ok(await kept(page), 'no reload');

  for (const name of ['hash', 'blank', 'download', 'external', 'away']) {
    assert.equal(await leftAlone(page, `zb-nav-links .${name}`), false, `.${name} is left to the browser`);
  }
  assert.equal(await leftAlone(page, 'a.app'), false, 'a link outside any component is the app\'s business');
  assert.equal(await leftAlone(page, 'zb-nav-links .handled'), true, 'a click already handled stays handled');
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(await leftAlone(page, 'zb-nav-links .plain', init), false, `a click with ${JSON.stringify(init)} is left alone`);
  }
  assert.equal((await page.evaluate(() => window.routed)).length, 1);
  await page.evaluate(() => history.replaceState(null, '', '/b?x=1'));

  assert.equal(await leftAlone(page, 'zb-nav-links .plain'), true, 'routed while on');
  await page.evaluate(() => window.stop());
  assert.equal(await leftAlone(page, 'zb-nav-links .plain'), false, 'stopped: links are links again');
  assert.deepEqual(messages, []);
});

test('React Router: useRouteLinks routes links inside components; framework links keep their own handling', async () => {
  const { page, messages } = await open('<div id="root"></div>', { modules: ['nav-react'] });
  await page.waitForSelector('zb-nav-links .go');
  await mark(page);
  await page.click('zb-nav-links .go');
  await page.waitForFunction(() => document.getElementById('route').textContent === '/b?x=1#top');
  assert.ok(await kept(page), 'no reload');
  await page.click('zb-nav-links .framework');
  await page.waitForFunction(() => document.getElementById('route').textContent === '/c');
  assert.deepEqual(await page.evaluate(() => window.routed), ['/b', '/c'], 'one navigation each: a slotted <Link> isn\'t routed twice');
  assert.equal(await leftAlone(page, 'a.app'), false, 'the app\'s own plain link is left alone');
  assert.ok(await kept(page));
  assert.deepEqual(messages.filter((m) => !m.includes('React DevTools')), []);
});

test('Vue Router: useRouteLinks routes links inside components', async () => {
  const { page, messages } = await open('<div id="root"></div>', { modules: ['nav-vue'] });
  await page.waitForSelector('zb-nav-links .go');
  await mark(page);
  await page.click('zb-nav-links .go');
  await page.waitForFunction(() => document.getElementById('route').textContent === '/b?x=1#top');
  assert.ok(await kept(page), 'no reload');
  assert.equal(await leftAlone(page, 'a.app'), false);
  assert.deepEqual(messages.filter((m) => !/Vue Router warn/.test(m)), []);
});
