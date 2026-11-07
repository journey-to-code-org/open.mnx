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

const plugins = { react: () => [react()], vue: () => [vue()], plain: () => [], tailwind: () => [tailwindcss()] };

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
