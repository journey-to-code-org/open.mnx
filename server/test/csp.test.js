// @zubra/server under a Content-Security-Policy without 'unsafe-inline' (issue #216): a nonce on
// what the page writes inline (`page({ nonce })`), or nothing inline at all (`inline: false`),
// each checked in a browser that enforces the policy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createZubra } from '../src/index.js';
import { nonceAttribute, resolveImports } from '../src/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, 'components');
// The policy of the site the issue came from, and the same with a nonce.
const STRICT = "default-src 'self'; style-src 'self'; script-src 'self'";
const withNonce = (nonce) => `default-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
const NONCE = 'c29tZSByYW5kb20gYnl0ZXM=';

let browser;
const servers = [];
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.close();
});

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function open(url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  await page.goto(url);
  page.errors = errors;
  page.done = () => context.close();
  return page;
}
const layout = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
const hello = (page) => page.render('hello-there', { name: 'Ada', items: [{ label: 'a', on: true }] });
/** hello-there's paragraph: hydrated (the "!"), and green by the component's CSS. */
const greeted = async (page) => {
  await page.waitForFunction(() => document.querySelector('hello-there p')?.textContent.startsWith('Hello Ada!'), null, { timeout: 5000 });
  return page.$eval('hello-there p', (p) => getComputedStyle(p).color);
};
/** The inline `<style>` and `<script>` elements in a page (a script with `src` isn't inline). */
const inlineElements = (html) => [...html.matchAll(/<style\b[^>]*>|<script\b(?![^>]*\bsrc=)[^>]*>/g)].map((match) => match[0]);

test('the policy bites: without a nonce or inline: false, the page neither styles nor starts', async () => {
  const zubra = createZubra({ components });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': STRICT }).end(page.finish(layout(hello(page))));
  });
  const page = await open(url);
  await page.waitForTimeout(300);
  assert.equal(await page.$eval('hello-there p', (p) => p.textContent.trim()), 'Hello Ada. a', 'not hydrated');
  assert.notEqual(await page.$eval('hello-there p', (p) => getComputedStyle(p).color), 'rgb(0, 128, 0)');
  assert.ok(page.errors.some((error) => /Content Security Policy/.test(error)), page.errors.join('\n'));
  await page.done();
});

test('page({ nonce }): every inline style and script the page writes carries the nonce, and the page runs under the policy', async () => {
  const zubra = createZubra({ components });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page({ nonce: NONCE });
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': withNonce(NONCE) }).end(page.finish(layout(hello(page))));
  });
  const html = await (await fetch(url)).text();
  const inline = inlineElements(html);
  assert.equal(inline.length, 3, 'the CSS, the import map and the module script');
  for (const element of inline) assert.ok(element.includes(` nonce="${NONCE}"`), element);
  assert.match(html, new RegExp(`<script type="importmap" nonce="${NONCE.replace(/[+=/]/g, '\\$&')}">`));
  const page = await open(url);
  assert.equal(await greeted(page), 'rgb(0, 128, 0)');
  assert.deepEqual(page.errors, []);
  await page.done();

  // The same pieces one by one, and for all the components.
  assert.ok(zubra.importMap({ nonce: NONCE }).startsWith(`<script type="importmap" nonce="${NONCE}">`));
  for (const element of inlineElements(zubra.head(undefined, { nonce: NONCE }) + zubra.scripts(undefined, { nonce: NONCE }))) assert.ok(element.includes(` nonce="${NONCE}"`), element);
  // And none where none was asked for.
  const plain = zubra.page();
  assert.doesNotMatch(plain.finish(layout(hello(plain))), /nonce/);
});

test('page({ nonce }): a streamed prop\'s scripts carry it too', async () => {
  const zubra = createZubra({ components });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page({ nonce: NONCE });
    const body = page.render('review-list', { heading: 'Said', reviews: new Promise((done) => setTimeout(() => done([{ id: 1, name: 'Ada', stars: 5 }]), 50)) });
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': withNonce(NONCE) });
    page.stream(layout(body)).pipe(res);
  });
  const html = await (await fetch(url)).text();
  const inline = inlineElements(html);
  assert.equal(inline.length, 4, 'the import map, the script that holds the promise, the module script and the swap');
  for (const element of inline) assert.ok(element.includes(` nonce="${NONCE}"`), element);
  const page = await open(url);
  await page.waitForFunction(() => document.querySelector('review-list li')?.textContent === 'Ada: 5', null, { timeout: 5000 });
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('a nonce that could close its attribute is refused', () => {
  const zubra = createZubra({ components });
  for (const bad of ['a" onload="x', 'a b', '', '<', 5, {}]) {
    assert.throws(() => zubra.page({ nonce: bad }), /nonce is the base64 value/, String(bad));
    assert.throws(() => zubra.head(undefined, { nonce: bad }), /nonce is the base64 value/, String(bad));
  }
  assert.equal(nonceAttribute({ nonce: 'ab-_+/09==' }), ' nonce="ab-_+/09=="');
  assert.equal(nonceAttribute({}), '');
  assert.equal(nonceAttribute(undefined), '');
});

test('inline: false: stylesheet links, module scripts by src, no import map, and the page runs under the strict policy', async () => {
  assert.throws(() => createZubra({ components, inline: 'no' }), /inline is true or false/);
  const zubra = createZubra({ components, inline: false });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const body = hello(page) + page.render('count-stepper', { value: 2 });
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': STRICT }).end(page.finish(layout(body)));
  });
  const html = await (await fetch(url)).text();
  // (count-stepper is shadow DOM: its declarative root has the compiler's own <style>, which
  // isn't the page's to write. Everything the head and scripts add is external.)
  assert.deepEqual(inlineElements(html.replace(/<template shadowrootmode[^]*?<\/template>/g, '')), []);
  assert.match(html, /<link rel="stylesheet" href="\/_zubra\/components\/hello-there\.css" data-zb-components>\n?[^]*<\/head>/);
  assert.match(html, /<script type="module" src="\/_zubra\/components\/hello-there\.js"><\/script><script type="module" src="\/_zubra\/components\/count-stepper\.js"><\/script>\n?<\/body>/);
  assert.doesNotMatch(html, /importmap/);
  assert.equal(zubra.importMap(), '');

  // The stylesheet is served, and only a component's.
  const css = await fetch(`${url}/_zubra/components/hello-there.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /color: rgb\(0, 128, 0\)/);
  assert.equal((await fetch(`${url}/_zubra/components/nope.css`)).status, 404);
  // With inline elements, the CSS is in the page and there's no such file.
  const inlined = createZubra({ components });
  assert.equal(await inlined.fetch(new Request('http://localhost/_zubra/components/hello-there.css')), null);

  // The module's imports are resolved: the compiler's, and the script's own `@zubra/runtime`.
  const module = await (await fetch(`${url}/_zubra/components/hello-there.js`)).text();
  assert.match(module, /import \{ hydrated \} from ['"]\/_zubra\/runtime\/index\.js['"]/);
  assert.doesNotMatch(module, /from ['"]@zubra\//);
  assert.match(inlined.module('hello-there'), /from ['"]@zubra\/runtime['"]/, 'left for the import map otherwise');

  const page = await open(url);
  assert.equal(await greeted(page), 'rgb(0, 128, 0)');
  await page.click('count-stepper >> button.more');
  assert.equal(await page.$eval('count-stepper', (el) => el.value), 3, 'the shadow component started too');
  assert.deepEqual(page.errors.filter((error) => !/inline style/.test(error)), []);
  await page.done();
});

test('inline: false: `imports` and @zubra/sync resolve in the modules, the runtime\'s own included', async () => {
  const app = mkdtempSync(join(tmpdir(), 'zubra-csp-sync-'));
  after(() => rmSync(app, { recursive: true, force: true }));
  mkdirSync(join(app, 'node_modules', '@zubra'), { recursive: true });
  symlinkSync(join(here, '../../sync'), join(app, 'node_modules', '@zubra', 'sync'), 'dir');
  mkdirSync(join(app, 'components'));
  writeFileSync(join(app, 'components', 'note-card.zb'), "<script>'use collection notes'; import { tint } from './tint.js'; import { shade } from '@acme/color/shade.js'; let text = ''</script>\n<note-card doc=\"\">{text}{tint}{shade}</note-card>\n");
  writeFileSync(join(app, 'components', 'tint.js'), "import { signal } from '@zubra/runtime';\nexport const tint = signal('x');\n");
  const zubra = createZubra({ components: join(app, 'components'), inline: false, imports: { '@acme/color/': '/vendor/color/' } });
  const text = async (path) => (await zubra.fetch(new Request(`http://localhost${path}`))).text();
  const module = await text('/_zubra/components/note-card.js');
  assert.match(module, /from "\/_zubra\/sync\/index\.js"/);
  assert.match(module, /from '\/vendor\/color\/shade\.js'/);
  assert.match(module, /from '\.\/tint\.js'/, 'relative imports stay');
  assert.match(await text('/_zubra/components/tint.js'), /from '\/_zubra\/runtime\/index\.js'/, 'a plain module the component imports');
  assert.match(await text('/_zubra/sync/index.js'), /from '\/_zubra\/runtime\/index\.js'/, "@zubra/sync's import of the runtime");
  assert.doesNotMatch(await text('/_zubra/sync/index.js'), /from ['"]@zubra\/runtime['"]/);
});

test('inline: false: a prop given as a promise needs the nonce, and streams with it', async () => {
  const zubra = createZubra({ components, inline: false });
  const pending = () => new Promise(() => {});
  assert.throws(() => zubra.page().render('review-list', { reviews: pending() }), /with inline: false, a prop given as a promise needs a nonce/);
  const page = zubra.page({ nonce: NONCE });
  const html = page.render('review-list', { reviews: pending() });
  assert.match(html, new RegExp(`<script nonce="${NONCE}">`));
});

test('inline: false: writeAssets() writes the stylesheets and resolved modules, and the static site runs under the strict policy', async () => {
  const zubra = createZubra({ components, inline: false, production: true, devtools: false });
  const site = mkdtempSync(join(tmpdir(), 'zubra-csp-static-'));
  after(() => rmSync(site, { recursive: true, force: true }));
  zubra.writeAssets(site);
  const page = zubra.page();
  writeFileSync(join(site, 'index.html'), page.finish(layout(hello(page))));
  assert.match(readFileSync(join(site, '_zubra/components/hello-there.css'), 'utf8'), /color: rgb\(0, 128, 0\)/);
  assert.equal(existsSync(join(site, '_zubra/components/review-list.css')), false, 'a component without CSS has no file');
  // No module that was written still names a package: nothing is left for an import map.
  const bare = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (extname(path) === '.js' && /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]@zubra\//.test(readFileSync(path, 'utf8'))) bare.push(path.slice(site.length));
    }
  })(join(site, '_zubra'));
  assert.deepEqual(bare, []);
  // Without the option, nothing changes: no stylesheets, and the runtime as it is.
  const plain = mkdtempSync(join(tmpdir(), 'zubra-csp-plain-'));
  after(() => rmSync(plain, { recursive: true, force: true }));
  createZubra({ components, production: true, devtools: false }).writeAssets(plain);
  assert.equal(existsSync(join(plain, '_zubra/components/hello-there.css')), false);
  assert.match(readFileSync(join(plain, '_zubra/components/hello-there.js'), 'utf8'), /from ['"]@zubra\/runtime['"]/);

  // Any static file server, with the policy.
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const url = await listen((req, res) => {
    const file = resolve(site, `.${new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')}`);
    if (!file.startsWith(site + sep) || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'content-security-policy': STRICT }).end(readFileSync(file));
  });
  const opened = await open(url);
  assert.equal(await greeted(opened), 'rgb(0, 128, 0)');
  assert.deepEqual(opened.errors, []);
  await opened.done();
});

test('resolveImports: as an import map would, and nothing else', () => {
  const imports = { '@zubra/runtime': '/z/runtime/index.js', '@zubra/runtime/spread': '/z/runtime/spread.js', '@acme/': '/vendor/acme/', '@acme/kit/': '/kit/' };
  const code = [
    "import { a } from '@zubra/runtime';",
    'import { b } from "@zubra/runtime/spread";',
    "import '@acme/kit/panel.js';",
    "import x from '@acme/other/x.js';",
    "const later = import('@zubra/runtime');",
    "export { c } from '@zubra/runtime'",
    "import './local.js'; import d from '../up.js'; import e from '/abs.js'; import f from 'https://cdn.example/f.js';",
    "import g from '@zubra/runtime/unknown'; import h from 'lit';",
  ].join('\n');
  assert.equal(resolveImports(code, imports), [
    "import { a } from '/z/runtime/index.js';",
    'import { b } from "/z/runtime/spread.js";',
    "import '/kit/panel.js';",
    "import x from '/vendor/acme/other/x.js';",
    "const later = import('/z/runtime/index.js');",
    "export { c } from '/z/runtime/index.js'",
    "import './local.js'; import d from '../up.js'; import e from '/abs.js'; import f from 'https://cdn.example/f.js';",
    "import g from '@zubra/runtime/unknown'; import h from 'lit';",
  ].join('\n'));
});
