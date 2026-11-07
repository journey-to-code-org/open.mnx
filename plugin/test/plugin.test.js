// The plugin in real Vite builds: a React app, a Vue app (single-file components with v-model
// and named slots) and an app with no framework, each run in Chromium; the typings it writes,
// checked with TypeScript; and compile errors. Needs a Rust toolchain and Playwright.
// `npm test` in plugin/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import solid from 'vite-plugin-solid';
import mnx from '../src/vite.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const fixtures = join(repo, 'runtime/test/browser/fixtures');
const compiler = join(repo, 'target/debug/mnix');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

// Inside plugin/, so the apps resolve the plugin's node_modules.
const work = join(here, '.tmp');
let browser;
const servers = [];

/** Copy an app and the components it uses into the work directory. */
function app(name) {
  const root = join(work, name);
  cpSync(join(here, 'apps', name), root, { recursive: true });
  mkdirSync(join(root, 'components'), { recursive: true });
  for (const component of ['rating', 'card', 'inbox', 'badge']) {
    cpSync(join(fixtures, `${component}.mnx`), join(root, 'components', `${component}.mnx`));
  }
  return root;
}

const plugins = { jsx: () => [react()], react: () => [react()], vue: () => [vue()], plain: () => [], tailwind: () => [tailwindcss()], svelte: () => [svelte()], solid: () => [solid()], lit: () => [] };

async function bundle(name, root = app(name)) {
  await build({
    root, configFile: false, logLevel: 'silent',
    plugins: [mnx({ compiler }), ...plugins[name]()],
    build: { outDir: join(root, 'dist'), minify: false },
  });
  return root;
}

async function serve(dir) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    try {
      const body = readFileSync(join(dir, path === '/' ? 'index.html' : path));
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path) || '.html'] ?? 'text/plain';
      response.writeHead(200, { 'content-type': type }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}

async function visit(root) {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto(await serve(join(root, 'dist')));
  await page.waitForFunction(() => window.ready === true);
  return { page, messages };
}

const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve));
  await Promise.all([...document.querySelectorAll('*')].filter((el) => el.localName.startsWith('mnx-')).map((el) => el.updateComplete));
});

const strip = (html) => html.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim();

before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.close();
  rmSync(work, { recursive: true, force: true });
});

test('React: .mnx imports are React components, with props, events, children and nested components', async () => {
  const root = await bundle('react');
  const { page, messages } = await visit(root);
  await settle(page);
  assert.deepEqual(await page.evaluate(() => window.kinds), { plain: 'react', element: 'mnx-card' });

  await page.click('mnx-rating .two');
  await settle(page);
  assert.equal(await page.textContent('#stars'), '2', 'onValueChange');

  const card = () => page.$eval('mnx-card:not(#from-html)', (el) => [el.querySelector('header').innerHTML, el.querySelector('section').innerHTML]);
  assert.deepEqual((await card()).map(strip), ['<h2 slot="title">Custom</h2>', '<p>a</p><p>b</p>']);
  await page.evaluate(() => window.setItems(['b', 'c', 'a']));
  await settle(page);
  assert.equal(strip((await card())[1]), '<p>b</p><p>c</p><p>a</p>');

  assert.deepEqual(await page.$$eval('mnx-inbox mnx-badge b', (bs) => bs.map((b) => b.textContent)), ['Ada', 'Linus'],
    'a component using a component, both compiled by the plugin');
  assert.equal(await page.$eval('#from-html h2', (h2) => h2.textContent), 'HTML', 'the element works in plain HTML too');
  assert.deepEqual(messages, []);
  await page.close();
});

test('Vue: .mnx imports are Vue components, with v-model, events and named slots', async () => {
  const root = await bundle('vue');
  const { page, messages } = await visit(root);
  await settle(page);
  await page.click('mnx-rating .two');
  await settle(page);
  assert.equal(await page.textContent('#stars'), '2', 'v-model');
  assert.equal(await page.textContent('#log'), 'change', '@change');
  const card = () => page.$eval('mnx-card', (el) => [el.querySelector('header').innerHTML, el.querySelector('section').innerHTML]);
  assert.deepEqual((await card()).map(strip), ['<h2 slot="title">Custom</h2>', '<p>a</p><p>b</p>']);
  await page.evaluate(() => window.setItems(['c', 'a']));
  await settle(page);
  assert.equal(strip((await card())[1]), '<p>c</p><p>a</p>');
  assert.deepEqual(messages.filter((message) => !/development build of Vue|Vue Devtools/.test(message)), []);
  await page.close();
});

test('no framework: the import is the element class', async () => {
  const root = await bundle('plain');
  const { page, messages } = await visit(root);
  assert.equal(await page.evaluate(() => window.kind), 'function mnx-card mnx-card');
  assert.equal(await page.$eval('mnx-card h2', (h2) => h2.textContent), 'Plain');
  assert.equal(strip(await page.$eval('mnx-card section', (s) => s.innerHTML)), '<p>from html</p>');
  assert.deepEqual(messages, []);
  await page.close();
});

function typecheck(root, files) {
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', target: 'es2022',
      lib: ['es2022', 'dom'], allowArbitraryExtensions: true, skipLibCheck: true, types: [],
    },
    files,
  }));
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { encoding: 'utf8', cwd: root });
  return (result.stdout + result.stderr).trim();
}

test('the typings it writes type the React components', async () => {
  const root = join(work, 'react');
  assert.ok(existsSync(join(root, 'components/rating.d.mnx.ts')), 'written next to the component');
  writeFileSync(join(root, 'src/bad.tsx'), `
    import Rating from '../components/rating.mnx';
    export const a = <Rating value="2" />;
    export const b = <Rating onValueChange={(event: number) => event} />;
    export const c = <Rating nope />;
  `);
  writeFileSync(join(root, 'src/client.d.ts'), "/// <reference path=\"../../../../client.d.ts\" />\n");
  assert.equal(typecheck(root, ['src/client.d.ts', 'src/App.tsx', 'src/kinds.ts']), '');
  const output = typecheck(root, ['src/client.d.ts', 'src/bad.tsx']);
  const errors = output.split('\n').filter((line) => /error TS\d+/.test(line));
  assert.equal(errors.length, 3, output);
  assert.match(output, /bad\.tsx\(3,.*Type 'string' is not assignable to type 'number'/);
  assert.match(output, /bad\.tsx\(5,[\s\S]*Property 'nope' does not exist/);
});

test('the typings it writes type the Vue components', async () => {
  const root = join(work, 'vue');
  writeFileSync(join(root, 'src/check.ts'), `
    import { h } from 'vue';
    import Rating from '../components/rating.mnx';
    import Card from '../components/card.mnx';
    export const ok = [
      h(Rating, { modelValue: 2, 'onUpdate:modelValue': (value: number) => value, onValuechange: (event: CustomEvent<unknown>) => event }),
      h(Card, { heading: 'x', open: true }),
    ];
    // @ts-expect-error a number prop
    export const bad = h(Rating, { value: 'two' });
  `);
  assert.equal(typecheck(root, ['src/check.ts']), '');
});

test('compile errors fail the build with the source line', async () => {
  const root = app('plain');
  writeFileSync(join(root, 'components/card.mnx'), '<mnx-card heading="x">\n  <h2>{headng}</h2>\n</mnx-card>\n');
  await assert.rejects(bundle('plain', root), (error) => {
    assert.match(error.message, /unknown reference `headng`/);
    assert.match(error.message, /2 \|   <h2>\{headng\}<\/h2>/);
    assert.match(error.message, /did you mean `heading`\?/);
    return true;
  });
});

test('a missing compiler is explained', async () => {
  const root = app('plain');
  await assert.rejects(build({
    root, configFile: false, logLevel: 'silent', plugins: [mnx({ compiler: join(work, 'no-such-mnix') })],
    build: { outDir: join(root, 'dist') },
  }), /couldn't run the compiler/);
});

test('dev server: components compile on demand; editing one reloads the page and recompiles its importers', async () => {
  const { createServer: createViteServer } = await import('vite');
  const root = app('react');
  const server = await createViteServer({
    root, configFile: false, logLevel: 'silent', plugins: [mnx({ compiler }), react()],
    server: { port: 0, host: '127.0.0.1' },
  });
  await server.listen();
  try {
    const url = server.resolvedUrls.local[0];
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.ready === true);
    assert.equal(await page.$eval('mnx-card:not(#from-html) footer', (footer) => footer.textContent), 'React footer');

    const inbox = async () => (await fetch(`${url}components/inbox.mnx?mnx=element&import`)).text();
    const before = (await inbox()).match(/hydrate: \[[\d, ]+\]/)?.[0];
    assert.ok(before, 'the parent has a hydrate path into the child');

    // Edit the card: the page reloads with the new template.
    await page.evaluate(() => { window.stale = true; });
    const card = join(root, 'components/card.mnx');
    writeFileSync(card, readFileSync(card, 'utf8').replace('{heading} footer', '{heading} footer, edited'));
    await page.waitForFunction(() => window.stale !== true && window.ready === true, null, { timeout: 15000 });
    assert.equal(await page.$eval('mnx-card:not(#from-html) footer', (footer) => footer.textContent), 'React footer, edited');

    // Edit the badge (a child of the inbox) so its slot moves: the inbox is recompiled too.
    const badge = join(root, 'components/badge.mnx');
    writeFileSync(badge, readFileSync(badge, 'utf8').replace('<span class="badge"', '<div class="wrap"></div><span class="badge"'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = (await inbox()).match(/hydrate: \[[\d, ]+\]/)?.[0];
    assert.notEqual(after, before);
    await page.close();
  } finally {
    await server.close();
  }
});

test('build --watch: editing a child component rebuilds the components that use it', async () => {
  const root = app('plain');
  writeFileSync(join(root, 'src/main.js'), "import '../components/inbox.mnx';\nwindow.ready = true;\n");
  const outDir = join(root, 'dist');
  const watcher = await build({
    root, configFile: false, logLevel: 'silent', plugins: [mnx({ compiler })],
    build: { outDir, minify: false, watch: {} },
  });
  const built = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no rebuild within 20s')), 20000);
    const listener = (event) => {
      if (event.code === 'END' || event.code === 'ERROR') clearTimeout(timer);
      if (event.code === 'END') { watcher.off('event', listener); resolve(); }
      if (event.code === 'ERROR') { watcher.off('event', listener); reject(event.error); }
    };
    watcher.on('event', listener);
  });
  const hydratePath = () => {
    const { readdirSync } = require('node:fs');
    const assets = join(outDir, 'assets');
    const code = readdirSync(assets).filter((name) => name.endsWith('.js')).map((name) => readFileSync(join(assets, name), 'utf8')).join('\n');
    // The bundler reprints the arrays across lines.
    return code.match(/hydrate: \[[\d,\s]+\]/g)?.map((path) => path.replace(/\s+/g, ' ')).join(' ');
  };
  try {
    await built();
    const before = hydratePath();
    assert.ok(before);
    const badge = join(root, 'components/badge.mnx');
    const next = built();
    writeFileSync(badge, readFileSync(badge, 'utf8').replace('<span class="badge"', '<div class="wrap"></div><span class="badge"'));
    await next;
    assert.notEqual(hydratePath(), before, "the inbox's compiled code follows the badge's new template");
  } finally {
    await watcher.close();
  }
});

test('compiler warnings reach the bundler', async () => {
  const root = app('plain');
  writeFileSync(join(root, 'components/card.mnx'), '<mnx-card hidden={false}>\n  <p>x</p>\n</mnx-card>\n');
  const warnings = [];
  await build({
    root, configFile: false, logLevel: 'silent', plugins: [mnx({ compiler })],
    build: { outDir: join(root, 'dist'), rollupOptions: { onwarn: (warning) => warnings.push(warning.message) } },
  });
  assert.ok(warnings.some((message) => message.includes('prop `hidden` is also every element')), warnings.join('\n'));
});

test('styles go through the bundler: Tailwind (@apply, utilities, layer order) and Sass', async () => {
  const root = await bundle('tailwind');
  const { page, messages } = await visit(root);
  const style = (selector, property) => page.$eval(selector, (el, property) => getComputedStyle(el)[property], property);
  assert.equal(await style('#own', 'paddingTop'), '16px', '@apply p-4 in the component\'s <style>');
  assert.equal(await style('#own', 'color'), 'rgb(255, 0, 0)');
  assert.equal(await style('#util', 'paddingTop'), '32px', 'a utility class beats the component\'s own padding');
  assert.notEqual(await style('#util', 'color'), 'rgb(255, 0, 0)', 'and its color');
  assert.equal(await style('#heading', 'marginTop'), '7px', "the component's styles beat Tailwind's base (preflight), wherever they load");
  assert.equal(await style('h2.caller', 'color'), 'rgb(0, 0, 0)', "the caller's slotted heading isn't styled by the component");
  assert.equal(await style('h2.caller', 'paddingTop'), '0px');
  assert.equal(await style('mnx-sass-note p', 'color'), 'rgb(0, 128, 0)', '<style lang="scss">');
  assert.notEqual(await style('mnx-sass-note strong', 'color'), 'rgb(0, 128, 0)', 'nested Sass rules');
  const sheets = await page.evaluate(() => document.adoptedStyleSheets.length);
  assert.equal(sheets, 0, 'the CSS is in the page bundle, not inlined in the modules');
  assert.deepEqual(messages, []);
  await page.close();
});

test('without a CLI, the WebAssembly compiler (@mnx/compiler) builds the app', async (t) => {
  const { available } = await import('@mnx/compiler').catch(() => ({ available: () => false }));
  if (!available()) {
    if (process.env.MNX_REQUIRE_WASM) throw new Error('MNX_REQUIRE_WASM is set but @mnx/compiler has no mnx.wasm');
    return t.skip('@mnx/compiler has no mnx.wasm (npm run build in compiler/)');
  }
  const saved = process.env.MNX_COMPILER;
  delete process.env.MNX_COMPILER;
  try {
    const root = app('react');
    await build({ root, configFile: false, logLevel: 'silent', plugins: [mnx(), react()], build: { outDir: join(root, 'dist'), minify: false } });
    const { page, messages } = await visit(root);
    await settle(page);
    await page.click('mnx-rating .two');
    await settle(page);
    assert.equal(await page.textContent('#stars'), '2');
    assert.deepEqual(messages, []);
    await page.close();
  } finally {
    if (saved !== undefined) process.env.MNX_COMPILER = saved;
  }
});

// Frameworks that use custom elements directly: the same component, the same checks.
for (const name of ['svelte', 'solid', 'lit']) {
  test(`${name}: props as properties, events, two-way updates and framework-managed slot content`, async () => {
    const root = await bundle(name);
    const { page, messages } = await visit(root);
    await settle(page);
    const card = () => page.$eval('mnx-card', (el) => [el.querySelector('header').innerHTML, el.querySelector('section').innerHTML].map((html) => html.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim()));
    assert.deepEqual(await card(), ['<h2 slot="title">Custom</h2>', '<p>a</p><p>b</p>']);
    assert.equal(await page.$eval('mnx-badge .badge', (el) => el.dataset.color), 'red', 'objects arrive as properties');

    await page.click('mnx-rating .two');
    await settle(page);
    assert.equal(await page.textContent('#stars'), '2', 'the event updated the app, which set the prop back');
    assert.equal(await page.$eval('mnx-rating', (el) => el.value), 2);
    assert.equal(await page.textContent('#log'), 'change');

    await page.evaluate(() => window.app.setItems(['c', 'a', 'b']));
    await settle(page);
    assert.equal((await card())[1], '<p>c</p><p>a</p><p>b</p>', 'a keyed reorder by the framework');
    await page.evaluate(() => { window.app.setItems(['b']); window.app.setTitle(false); window.app.setInfo({ color: 'blue' }); });
    await settle(page);
    const heading = { svelte: 'Svelte', solid: 'Solid', lit: 'Lit' }[name];
    assert.deepEqual(await card(), [`<h2>${heading}</h2>`, '<p>b</p>'], 'removals, and the fallback comes back');
    assert.equal(await page.$eval('mnx-badge .badge', (el) => el.dataset.color), 'blue');
    await page.evaluate(() => { window.app.setItems([]); window.app.setTitle(true); });
    await settle(page);
    assert.deepEqual(await card(), ['<h2 slot="title">Custom</h2>', '<p>No content</p>']);
    assert.deepEqual(messages.filter((message) => !/Download the|development build/.test(message)), []);
    await page.close();
  });
}

// The other bundlers unplugin supports: the same app, built by each, run in the browser.
const BUNDLER_ENTRY = `import '../components/inbox.mnx';\nimport '../components/styled-card.mnx';\nwindow.ready = true;\n`;
const BUNDLER_PAGE = '<!doctype html><meta charset="utf-8"><mnx-inbox></mnx-inbox><mnx-styled-card><p class="mine">mine</p></mnx-styled-card><script type="module" src="/bundle.js"></script>';

async function checkBundle(root) {
  writeFileSync(join(root, 'dist/index.html'), BUNDLER_PAGE);
  const { page, messages } = await visit(root);
  await settle(page);
  assert.deepEqual(await page.$$eval('mnx-inbox mnx-badge b', (bs) => bs.map((b) => b.textContent)), ['Ada', 'Linus'], 'nested components');
  assert.equal(await page.$eval('mnx-styled-card h2', (h2) => getComputedStyle(h2).color), 'rgb(255, 0, 0)', 'inlined styles, scoped');
  assert.equal(await page.$eval('.mine', (p) => getComputedStyle(p).color), 'rgb(0, 0, 0)', 'slotted content is not the card\'s to style');
  assert.deepEqual(messages, []);
  await page.close();
}

function bundlerApp(name) {
  const root = app('plain');
  cpSync(join(fixtures, 'styled-card.mnx'), join(root, 'components/styled-card.mnx'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'src/entry.js'), BUNDLER_ENTRY);
  return root;
}

test('rollup builds the app', async () => {
  const { rollup } = await import('rollup');
  const { nodeResolve } = await import('@rollup/plugin-node-resolve');
  const { default: mnxRollup } = await import('../src/rollup.js');
  const root = bundlerApp('rollup');
  const bundle = await rollup({ input: join(root, 'src/entry.js'), plugins: [mnxRollup({ compiler }), nodeResolve()], onwarn: () => {} });
  await bundle.write({ file: join(root, 'dist/bundle.js'), format: 'es' });
  await checkBundle(root);
});

test('webpack builds the app', async () => {
  const { default: webpack } = await import('webpack');
  const { default: mnxWebpack } = await import('../src/webpack.js');
  const root = bundlerApp('webpack');
  const stats = await new Promise((resolve, reject) => webpack({
    mode: 'development', devtool: false, context: root, entry: join(root, 'src/entry.js'),
    output: { path: join(root, 'dist'), filename: 'bundle.js', module: true },
    experiments: { outputModule: true },
    resolve: { modules: [join(here, '../node_modules'), 'node_modules'] },
    plugins: [mnxWebpack({ compiler })],
  }, (error, result) => (error ? reject(error) : resolve(result))));
  assert.equal(stats.hasErrors(), false, stats.toString('errors-only'));
  await checkBundle(root);
});

test('esbuild builds the app', async () => {
  const { build: esbuild } = await import('esbuild');
  const { default: mnxEsbuild } = await import('../src/esbuild.js');
  const root = bundlerApp('esbuild');
  await esbuild({ entryPoints: [join(root, 'src/entry.js')], bundle: true, format: 'esm', outfile: join(root, 'dist/bundle.js'), plugins: [mnxEsbuild({ compiler })], logLevel: 'silent' });
  await checkBundle(root);
});

// Astro: components server-rendered at build time through the renderer (with @mnx/compiler,
// or the native CLI standing in for its WebAssembly), hydrated on the client with client:load.
test('astro: server-rendered pages, hydrated with a client directive', async () => {
  const { available } = await import('@mnx/compiler');
  const saved = process.env.MNX_COMPILER;
  if (!available()) process.env.MNX_COMPILER = compiler;
  try {
    const { build: astroBuild } = await import('astro');
    const { default: mnxAstro } = await import('../src/astro.js');
    const root = app('astro');
    await astroBuild({ root, configFile: false, logLevel: 'error', integrations: [mnxAstro({ compiler })], outDir: join(root, 'dist') });
    const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
    // Static components are HTML only, with props, host attributes and slot content.
    assert.match(html, /<mnx-card data-kind="static" heading="Astro">/);
    // (Astro takes the `slot` attribute off what it passes.)
    assert.match(html, /<header><!--\[!--><h2>Custom \{braces\}<\/h2><!--\]--><\/header>[^]*<section><!--\[!--><p>Body<\/p><!--\]--><\/section>/);
    assert.match(html, /<mnx-badge class="row" data-who="Ada" label="Ada" count="3"/, 'nested components render too');
    assert.match(html, /<astro-island[^>]*><mnx-rating id="r" class="big" value="1">[^]*<output>1<\/output>/);

    const { page, messages } = await visit(root);
    await settle(page);
    assert.equal(await page.$eval('mnx-card', (card) => card.matches(':defined')), false, 'no JavaScript for static components');
    await page.click('mnx-rating .two');
    await settle(page);
    assert.equal(await page.textContent('mnx-rating output'), '2', 'the island hydrated');
    assert.deepEqual(messages, []);
    await page.close();
  } finally {
    if (saved === undefined) delete process.env.MNX_COMPILER;
    else process.env.MNX_COMPILER = saved;
  }
});

// JSX components (`.mnx.tsx`) in a React app: the React wrapper from a React file, the element
// with `?element`, an .mnx child inside, and the same element in the page's HTML.
test('JSX components: imported from React as React components, and as elements', async () => {
  const root = await bundle('jsx');
  const { page, messages } = await visit(root);
  await settle(page);
  assert.equal(await page.evaluate(() => window.kind), 'mnx-counter');
  const read = (id) => page.$eval(`#${id}`, (el) => [el.querySelector('mnx-badge i').textContent, el.querySelector('.doubled').textContent]);
  assert.deepEqual(await read('react'), ['1', '2']);
  assert.deepEqual(await read('plain'), ['5', '10'], 'the element in plain HTML');
  await page.click('#react button');
  await settle(page);
  assert.equal(await page.textContent('#count'), '3', 'onCountChange through the React wrapper');
  assert.deepEqual(await read('react'), ['3', '6']);
  await page.click('#plain button');
  await settle(page);
  assert.deepEqual(await read('plain'), ['6', '12']);
  assert.deepEqual(messages, []);
  await page.close();
});
