// Measures the order desk built with each tool, for README.md:
//
//   1. what was written: lines of component source, of support code a tool needed, of framework
//      bindings written by hand, of build configuration and of the server page;
//   2. what each host sends: the JavaScript of its production build (Vite, minified, gzip level
//      9), less the same host built with no design system (impl/none), which leaves what the
//      components and their runtime add in that host;
//   3. the server page: the HTML and the JavaScript it loads (gzip level 9), how long the page
//      takes to render in this Node.js process, and what works with JavaScript off.
//
//   npm install && npm run build:stencil && node measure.mjs [--renders 2000] [--json results.json]
//
// Every tool runs at the version pinned in package.json.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { HOSTS, IMPLS } from './hosts/config.mjs';
import { start } from './hosts/server/server.mjs';
import { seed } from './shared/data.js';
import { build, here, launchBrowser } from './test/harness.js';
import { probes } from './test/probes.js';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const RENDERS = Number(option('--renders', 2000));
const gz = (data) => gzipSync(Buffer.from(data), { level: 9 }).length;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const versions = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).devDependencies;
const results = { versions: { zubra: versions['@zubra/compiler'], lit: versions.lit, stencil: versions['@stencil/core'], enhance: versions['@enhance/ssr'] }, node: process.version, renders: RENDERS };

function table(title, head, rows) {
  console.log(`\n${title}\n\n| ${head.join(' | ')} |\n|${head.map((_, i) => (i ? '---:' : '---')).join('|')}|`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
}

// --------------------------------------------------------------------------------- what was written
// A line counts if it isn't blank and isn't only a comment (`//`, `/* */`, `<!-- -->`).
function lines(path) {
  const text = readFileSync(join(here, path), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//')).length;
}
const files = (dir, test) => readdirSync(join(here, dir), { recursive: true }).map((name) => join(dir, String(name))).filter((path) => statSync(join(here, path)).isFile() && test.test(path));
const count = (paths) => paths.reduce((sum, path) => sum + lines(path), 0);

const WRITTEN = {
  zubra: {
    components: files('impl/zubra/components', /\.zb$/),
    support: [],
    bindings: ['impl/zubra/react.js', 'impl/zubra/vue.js', 'impl/zubra/elements.js'],
    config: [], // one line in hosts/config.mjs: the build plugin
    configLines: 1,
    server: ['impl/zubra/server.mjs'],
  },
  lit: {
    components: files('impl/lit/components', /\.js$/),
    support: [],
    bindings: ['impl/lit/react.js', 'impl/lit/vue.js', 'impl/lit/elements.js', 'impl/vue-wrap.js'],
    config: [],
    server: ['impl/lit/server.mjs', 'impl/lit/hydrate.js'],
  },
  stencil: {
    components: files('impl/stencil/src/components', /\.(tsx|css)$/),
    support: [],
    bindings: ['impl/stencil/react.jsx', 'impl/stencil/vue.js', 'impl/stencil/elements.js'],
    config: ['impl/stencil/stencil.config.ts', 'impl/stencil/tsconfig.json', 'impl/stencil/package.json'],
    configLines: 1, // and one alias in hosts/config.mjs, for the generated components' imports
    server: ['impl/stencil/server.mjs'],
  },
  enhance: {
    // An Enhance element is its element function and what it does in the browser (elements.js).
    components: [...files('impl/enhance/elements', /\.mjs$/), 'impl/enhance/elements.js'],
    support: ['impl/enhance/element.mjs', 'impl/enhance/read.mjs'],
    bindings: ['impl/enhance/react.jsx', 'impl/enhance/vue.js', 'impl/vue-wrap.js'],
    config: [],
    server: ['impl/enhance/server.mjs'],
  },
};
results.written = {};
for (const impl of IMPLS) {
  const w = WRITTEN[impl];
  results.written[impl] = {
    components: count(w.components),
    perComponent: Object.fromEntries(['badge', 'field', 'quantity', 'tabs', 'dialog', 'table'].map((name) => [name, count(w.components.filter((path) => path.includes(`ds-${name}`)))])),
    support: count(w.support),
    bindings: count(w.bindings),
    config: count(w.config) + (w.configLines ?? 0),
    server: count(w.server),
  };
  results.written[impl].total = ['components', 'support', 'bindings', 'config', 'server'].reduce((sum, key) => sum + results.written[impl][key], 0);
}
table('Lines written (not blank, not comments)', ['', ...IMPLS], [
  ...['components', 'support', 'bindings', 'config', 'server', 'total'].map((key) => [key, ...IMPLS.map((impl) => results.written[impl][key])]),
]);

// ------------------------------------------------------------------------------ what each host sends
/** The JavaScript a built host loads at start (index.html's scripts and what they import statically), and the rest. */
function javascript(dir) {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const assets = join(dir, 'assets');
  const all = readdirSync(assets).filter((name) => name.endsWith('.js'));
  const initial = new Set();
  const visit = (name) => {
    if (initial.has(name) || !all.includes(name)) return;
    initial.add(name);
    const text = readFileSync(join(assets, name), 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) visit(match[1]);
  };
  for (const match of html.matchAll(/(?:src|href)="\.\/assets\/([^"]+\.js)"/g)) visit(match[1]);
  const size = (names) => names.reduce((sum, name) => sum + gz(readFileSync(join(assets, name))), 0);
  return { initial: size([...initial]), lazy: size(all.filter((name) => !initial.has(name))) };
}
results.hosts = {};
for (const host of HOSTS) {
  results.hosts[host] = {};
  const baseline = javascript(await build(host, 'none')).initial;
  results.hosts[host].none = baseline;
  for (const impl of IMPLS) {
    const { initial, lazy } = javascript(await build(host, impl));
    results.hosts[host][impl] = { total: initial, added: initial - baseline, lazy };
  }
}
table('JavaScript the design system adds to each host (gzip), over the host with none', ['host (alone)', ...IMPLS], HOSTS.map((host) => [
  `${host} (${kb(results.hosts[host].none)})`,
  ...IMPLS.map((impl) => kb(results.hosts[host][impl].added) + (results.hosts[host][impl].lazy ? ` (+${kb(results.hosts[host][impl].lazy)} loaded on demand)` : '')),
]));

// ------------------------------------------------------------------------------------ the server page
const browser = await launchBrowser();
const open = async (url, options = {}) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(url);
  return { page, close: () => context.close() };
};
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const many = (n) => Array.from({ length: n }, (_, i) => ({ id: 1001 + i, customer: `Customer ${i}`, quantity: (i % 10) + 1, total: ((i % 10) + 1) * 12.5, status: ['pending', 'shipped', 'cancelled'][i % 3] }));

results.server = {};
for (const impl of IMPLS) {
  const server = await start(impl);
  const state = { orders: seed(), error: '', message: '' };
  const html = await server.renderer.page(state);

  // The JavaScript the page loads, as the browser asked for it.
  const context = await browser.newContext();
  const page = await context.newPage();
  const scripts = [];
  page.on('response', async (response) => {
    if (/javascript/.test(response.headers()['content-type'] ?? '')) scripts.push(response.body().then((body) => gz(body)));
  });
  await page.goto(server.url, { waitUntil: 'networkidle' });
  const js = (await Promise.all(scripts)).reduce((sum, bytes) => sum + bytes, 0);
  const requests = scripts.length;
  await context.close();

  const time = async (pageState) => {
    for (let i = 0; i < Math.max(50, RENDERS / 10); i++) await server.renderer.page(pageState);
    const batches = [];
    for (let batch = 0; batch < 5; batch++) {
      const started = performance.now();
      for (let i = 0; i < RENDERS / 5; i++) await server.renderer.page(pageState);
      batches.push(((performance.now() - started) / (RENDERS / 5)) * 1000);
    }
    return Math.round(median(batches));
  };
  results.server[impl] = {
    html: gz(html),
    js,
    requests,
    render3: await time(state),
    render100: await time({ orders: many(100), error: '', message: '' }),
    beforeJavaScript: await probes(open, server.url),
  };
  server.close();
}
await browser.close();
const yes = (value) => (value ? 'yes' : 'no');
table(`The server page (render: median of 5 batches, ${RENDERS} renders in all, Node ${process.version})`, ['', ...IMPLS], [
  ['HTML, 3 orders (gzip)', ...IMPLS.map((impl) => kb(results.server[impl].html))],
  ['JavaScript loaded (gzip)', ...IMPLS.map((impl) => `${kb(results.server[impl].js)} in ${results.server[impl].requests} request${results.server[impl].requests === 1 ? '' : 's'}`)],
  ['render, 3 orders', ...IMPLS.map((impl) => `${results.server[impl].render3} µs`)],
  ['render, 100 orders', ...IMPLS.map((impl) => `${results.server[impl].render100} µs`)],
  ['JS off: orders readable', ...IMPLS.map((impl) => yes(results.server[impl].beforeJavaScript.rows))],
  ['JS off: label names input', ...IMPLS.map((impl) => yes(results.server[impl].beforeJavaScript.label))],
  ['JS off: form adds the order', ...IMPLS.map((impl) => yes(results.server[impl].beforeJavaScript.post))],
]);

if (args.includes('--json')) writeFileSync(option('--json'), `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);
