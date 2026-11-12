// @zubra/server/edge: the server without a disk. It must do what the Node entry does, output for
// output, and must not depend on anything a Worker lacks.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { createZubra as createNode } from '../src/index.js';
import { createZubra as createEdge } from '../src/edge.js';
import { zubra as honoEdge } from '../src/hono-edge.js';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = fileURLToPath(import.meta.resolve('@zubra/compiler/zubra.wasm'));
if (process.env.ZUBRA_REQUIRE_WASM && !existsSync(wasmPath)) throw new Error('ZUBRA_REQUIRE_WASM is set but @zubra/compiler has no zubra.wasm');
const skip = existsSync(wasmPath) ? false : 'zubra.wasm is not built (npm run build in compiler)';
const wasm = () => new WebAssembly.Module(readFileSync(wasmPath));

// The test components, plus some that import each other by relative path, nested and upwards.
const extra = {
  'forms/page.zb': `<script>
  import '../ui/badge.zb'
  import './row.zb'
</script>
<form-page label="x">
  <ui-badge text={label}></ui-badge>
  <form-row n={1}></form-row>
</form-page>
`,
  'forms/row.zb': '<form-row n={0}><i>{n}</i></form-row>\n',
  'ui/badge.zb': '<style>span { font-weight: 700; }</style>\n<ui-badge text=""><span>{text}</span></ui-badge>\n',
};
let dir;
let sources; // name → source, the same components as `dir` holds
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'zb-edge-'));
  sources = {};
  const add = (name, source) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), source);
    sources[name.replace(/\.zb$/, '')] = source;
  };
  for (const entry of readdirSync(join(here, 'components'))) add(entry, readFileSync(join(here, 'components', entry), 'utf8'));
  for (const [name, source] of Object.entries(extra)) add(name, source);
});
const both = (options = {}) => ({
  node: createNode({ components: dir, devtools: false, ...options }),
  edge: createEdge({ wasm: wasm(), components: sources, ...options }),
});

test('the edge entry depends on nothing a Worker lacks', () => {
  for (const file of ['core.js', 'edge.js', 'hono-edge.js', 'hono-middleware.js']) {
    const code = readFileSync(join(here, '../src', file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(code, /from\s+['"]node:/, `${file}: no Node built-in imports`);
    assert.doesNotMatch(code, /\bimport\.meta\b/, `${file}: no import.meta`);
    assert.doesNotMatch(code, /\bprocess\b|\brequire\(|\bBuffer\b|\b__dirname\b/, `${file}: no Node globals`);
    assert.doesNotMatch(code, /from\s+['"]\.\/(index|compiler)\.js['"]/, `${file}: doesn't import the Node entry`);
  }
});

test('names, interfaces, renders, modules, head and scripts are the Node entry\'s', { skip }, () => {
  const { node, edge } = both();
  assert.deepEqual([...edge.names].sort(), [...node.names].sort());
  assert.equal(edge.names.length, Object.keys(sources).length, 'every component it was given');
  for (const name of node.names) {
    assert.deepEqual(edge.describe(name), node.describe(name), `describe ${name}`);
    assert.equal(edge.render(name), node.render(name), `render ${name}`);
    assert.equal(edge.module(name), node.module(name), `module ${name}`);
  }
  const props = { name: 'Ada', items: [{ label: 'a', on: true }, { label: 'b' }, { label: 'c', on: true }] };
  assert.equal(edge.render('hello-there', props), node.render('hello-there', props));
  assert.equal(edge.render('book-card', { book: { title: 'Dune', price: 1299 }, featured: true }), node.render('book-card', { book: { title: 'Dune', price: 1299 }, featured: true }));
  assert.equal(edge.head(), node.head());
  assert.equal(edge.scripts(), node.scripts());
  assert.equal(edge.importMap(), node.importMap());
  // By tag as well as by name.
  assert.equal(edge.render('hello-there', props), edge.render('hello-there', props));
  assert.equal(edge.describe('book-card').tag, 'book-card');
});

test('components import each other by relative path, nested and upwards', { skip }, () => {
  const { node, edge } = both();
  const html = edge.render('forms/page');
  assert.match(html, /<ui-badge[^>]*>.*<span>x<\/span>/s, 'the imported badge rendered with the label');
  assert.match(html, /<form-row[^>]*><i>1<\/i>/, 'the sibling row rendered');
  assert.equal(html, node.render('forms/page'));
  assert.equal(edge.module('forms/page'), node.module('forms/page'));
  assert.match(edge.head(['forms/page']), /font-weight: ?700/, "the imported component's CSS reaches the head");
});

test('a page, and the modules fetch() serves; the runtime is the host\'s to serve', { skip }, async () => {
  const { node, edge } = both();
  const render = (zubra) => {
    const page = zubra.page();
    const body = page.render('hello-there', { name: 'Ada' }) + page.render('forms/page');
    return { used: page.used, html: page.finish(`<!doctype html><html><head></head><body>${body}</body></html>`) };
  };
  assert.deepEqual(render(edge), render(node));

  const served = await edge.fetch(new Request('https://x.test/_zubra/components/hello-there.js'));
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /javascript/);
  assert.equal(await served.text(), node.module('hello-there'));
  assert.equal((await edge.fetch(new Request('https://x.test/_zubra/components/nope.js'))).status, 404);
  assert.equal(await edge.fetch(new Request('https://x.test/_zubra/runtime/index.js')), null, 'the runtime is not served from here');
  assert.equal(await edge.fetch(new Request('https://x.test/somewhere/else')), null);
  // A prefix of its own.
  const moved = createEdge({ wasm: wasm(), components: sources, prefix: '/assets/zb/' });
  assert.match(moved.importMap(), /"@zubra\/runtime":"\/assets\/zb\/runtime\/index\.js"/);
  assert.equal((await moved.fetch(new Request('https://x.test/assets/zb/components/hello-there.js'))).status, 200);
});

test('imports points the runtime elsewhere (a CDN, or static assets)', { skip }, () => {
  const edge = createEdge({ wasm: wasm(), components: sources, imports: { '@zubra/runtime': 'https://cdn.example/runtime/index.js' } });
  assert.match(edge.importMap(), /"@zubra\/runtime":"https:\/\/cdn\.example\/runtime\/index\.js"/);
});

test('injectShadowRoots gives framework HTML its shadow roots, as on Node', { skip }, () => {
  const { node, edge } = both();
  const html = `<main><book-card zb-props='{"book":{"title":"Dune","price":1299},"featured":true}'></book-card><count-stepper name="qty" value="3"></count-stepper><hello-there></hello-there></main>`;
  const injected = edge.injectShadowRoots(html);
  assert.match(injected, /<template shadowrootmode="open">/);
  assert.match(injected, /<\/template><input type="hidden" name="qty" value="3" data-zb-fallback>/);
  assert.equal(injected, node.injectShadowRoots(html));
  assert.equal(edge.injectShadowRoots(html, { lightDom: true }), node.injectShadowRoots(html, { lightDom: true }));
});

test('streamResponse sends the shell, then the resolved region, as Node does', { skip }, async () => {
  const { node, edge } = both();
  const stream = async (zubra) => {
    const page = zubra.page();
    const body = page.render('review-list', { reviews: Promise.resolve([{ id: 1, name: 'Ada', stars: 5 }]) });
    assert.equal(page.pending, true);
    const response = page.streamResponse(`<!doctype html><html><head></head><body>${body}</body></html>`, { status: 200 });
    assert.match(response.headers.get('content-type'), /text\/html/);
    return await response.text();
  };
  const fromEdge = await stream(edge);
  assert.match(fromEdge, /Loading…/);
  assert.match(fromEdge, /<template for="zb-0-0">/);
  assert.match(fromEdge, /Ada: 5/);
  assert.equal(fromEdge, await stream(node));
  assert.equal('stream' in edge.page(), false, 'the Node Readable stays on the Node entry');
});

// A Worker's bundler rewrites the server's code. Wrangler builds with esbuild's keep-names, which
// wraps `var kind = function…` in a `__name()` helper that exists only in the bundle; a page whose
// inline scripts were this code's functions, stringified, then threw in the browser.
test('bundled the way Wrangler bundles, a streamed page\'s inline scripts are the same text', { skip }, async () => {
  const { build } = await import('esbuild');
  const out = join(mkdtempSync(join(tmpdir(), 'zb-bundle-')), 'edge.mjs');
  await build({ entryPoints: [join(here, '../src/edge.js')], bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], keepNames: true, minify: true, outfile: out, logLevel: 'silent' });
  const bundled = (await import(out)).createZubra({ wasm: wasm(), components: sources });
  const { edge } = both();
  const stream = async (zubra) => {
    const page = zubra.page();
    const body = page.render('review-list', { reviews: Promise.resolve([{ id: 1, name: 'Ada', stars: 5 }]) });
    return await page.streamResponse(`<!doctype html><html><head></head><body>${body}</body></html>`).text();
  };
  const html = await stream(bundled);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 2, 'the hold script and the swap script');
  for (const script of scripts) {
    assert.doesNotMatch(script, /__name\b/, 'no helper from the bundle');
    // Every name it reads is its own, a parameter, or the browser's.
    const free = new Function('document', 'window', 'NodeFilter', `"use strict"; return ${script.replace(/\)\(("[^"]*"),[\s\S]*\)$/, ')')}`);
    assert.equal(typeof free({}, {}, {}), 'function');
  }
  assert.equal(html, await stream(edge), 'the bundle writes the page the source does');
});

// The import map names every runtime entry a compiled module can import on its own (the compiler
// writes `@zubra/runtime/spread`, `/primitives`, `/motion` and `/track` only into components that
// use them).
// One missing, and the first component to need it fails in the browser with a bare-specifier error.
test('the import map has every runtime entry a compiled module imports, on both entries', { skip }, () => {
  const { node, edge } = both();
  const runtime = JSON.parse(readFileSync(join(here, '../../runtime/package.json'), 'utf8'));
  for (const [name, zubra] of [['node', node], ['edge', edge]]) {
    const map = JSON.parse(zubra.head().match(/<script type="importmap">(.*?)<\/script>/s)[1]).imports;
    for (const entry of ['', '/spread', '/primitives', '/motion', '/track']) {
      const specifier = `@zubra/runtime${entry}`;
      assert.equal(map[specifier], `/_zubra/runtime/${entry ? entry.slice(1) : 'index'}.js`, `${name}: ${specifier}`);
      assert.ok(runtime.exports[entry ? `.${entry}` : '.'], `${specifier} is an entry of @zubra/runtime`);
    }
  }
  assert.equal(edge.head(), node.head());
});

test('the Hono middleware serves modules and hands each request a page', { skip }, async () => {
  const middleware = honoEdge({ wasm: wasm(), components: sources });
  const app = new Hono();
  app.use(middleware);
  app.get('/', (c) => c.html(c.get('zubra').finish(`<html><head></head><body>${c.get('zubra').render('hello-there', { name: 'Ada' })}</body></html>`)));
  const home = await app.request('/');
  assert.equal(home.status, 200);
  const text = await home.text();
  assert.match(text, /Hello Ada/);
  assert.match(text, /<script type="module">import '\/_zubra\/components\/hello-there\.js';<\/script>/);
  const module = await app.request('/_zubra/components/hello-there.js');
  assert.equal(module.status, 200);
  assert.match(await module.text(), /hello-there/);
  assert.ok(middleware.zubra.names.includes('hello-there'));
});

test('the cache option keeps or drops compiled output', { skip }, () => {
  const edge = createEdge({ wasm: wasm(), components: { ...sources }, cache: false });
  const before = edge.module('hello-there');
  assert.equal(edge.module('hello-there'), before);
});

test('mistakes say what to do', { skip }, () => {
  assert.throws(() => createEdge({ components: sources }), /needs the compiler's WebAssembly module/);
  const edge = createEdge({ wasm: wasm(), components: { 'a.zb': '<x-a>hi</x-a>', 'forms/b.zb': '<x-b>b</x-b>' } });
  assert.deepEqual(edge.names.sort(), ['a', 'forms/b'], 'a key may carry its extension');
  assert.throws(() => edge.render('nope'), /no component "nope" in the components given to createZubra\(\) \(have: a, forms\/b\)/);
  const broken = createEdge({ wasm: wasm(), components: { bad: '<x-bad><p></x-bad>' } });
  assert.throws(() => broken.render('bad'), /closing tag <\/x-bad> does not match <p>/);
});

test('components are in the order a folder walk finds them, a folder where its name falls', { skip }, () => {
  const layout = { 'a/x.zb': '<a-x>x</a-x>', 'a-b.zb': '<a-b>b</a-b>', 'a.zb': '<a-a>a</a-a>', 'b/y.zb': '<b-y>y</b-y>', 'c.zb': '<c-c>c</c-c>' };
  const folder = mkdtempSync(join(tmpdir(), 'zb-order-'));
  for (const [name, source] of Object.entries(layout)) {
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), source);
  }
  const components = Object.fromEntries(Object.entries(layout).reverse().map(([name, source]) => [name, source]));
  const edge = createEdge({ wasm: wasm(), components });
  const node = createNode({ components: folder, devtools: false });
  assert.deepEqual(edge.names, node.names);
  assert.deepEqual(edge.names, ['a/x', 'a-b', 'a', 'b/y', 'c']);
  assert.equal(edge.head(), node.head());
});
