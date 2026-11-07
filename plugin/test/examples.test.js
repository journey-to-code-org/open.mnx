// The example projects in examples/, built the way their READMEs say and used in Chromium, so
// they keep working as mnx changes. Each is copied inside plugin/ to resolve its packages from
// here (their own package.json points at the repository's packages). `npm test` in plugin/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const work = join(here, '.tmp-examples');
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;
const servers = [];

before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  // The CLI, unless the WebAssembly build is there.
  process.env.MNX_COMPILER ??= join(repo, 'target/debug/mnx');
  rmSync(work, { recursive: true, force: true });
  // What `npm install` gives an example: the plugin itself, next to the packages it uses.
  mkdirSync(join(work, 'node_modules/@mnx'), { recursive: true });
  symlinkSync(join(here, '..'), join(work, 'node_modules/@mnx/unplugin'), 'dir');
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.close();
  rmSync(work, { recursive: true, force: true });
});

function copy(name) {
  const root = join(work, name);
  cpSync(join(repo, 'examples', name), root, { recursive: true, filter: (path) => !/node_modules|dist|\.astro/.test(path) });
  return root;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function serve(dir) {
  const server = createServer((request, response) => {
    let path = join(dir, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    try {
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain' }).end(readFileSync(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function open(url) {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto(url);
  return { page, messages };
}

const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const all = (root) => [...root.querySelectorAll('*')].flatMap((el) => [el, ...(el.shadowRoot ? all(el.shadowRoot) : [])]);
  await Promise.all(all(document).filter((el) => el.localName.includes('-') && el.updateComplete).map((el) => el.updateComplete));
});

test('todo: add, complete, edit, filter, clear, and keep the list across reloads', async () => {
  const { build } = await import('vite');
  const root = copy('todo');
  await build({ root, configFile: join(root, 'vite.config.js'), configLoader: 'native', logLevel: 'silent' });
  const { page, messages } = await open(await serve(join(root, 'dist')));
  await page.waitForFunction(() => window.ready);
  await settle(page);
  const items = () => page.$$eval('todo-app todo-item', (els) => els.map((el) => `${el.done ? 'x' : ' '} ${el.text}`));
  const count = () => page.textContent('todo-app .count');
  assert.deepEqual(await items(), ['x Try mnx 2.0', '  Write a component']);
  assert.equal(await count(), '1 left');

  await page.fill('todo-app form input', 'Ship it');
  await page.press('todo-app form input', 'Enter');
  await settle(page);
  assert.deepEqual(await items(), ['x Try mnx 2.0', '  Write a component', '  Ship it']);
  assert.equal(await page.inputValue('todo-app form input'), '', 'the field cleared');
  assert.equal(await count(), '2 left');

  await page.locator('todo-item').nth(1).locator('input[type=checkbox]').click();
  await settle(page);
  assert.equal(await count(), '1 left');

  await page.locator('todo-item').nth(2).locator('span').dblclick();
  await settle(page);
  const edit = page.locator('todo-item').nth(2).locator('input.edit, input[aria-label="Edit item"]');
  await edit.fill('Ship 2.0');
  await edit.press('Enter');
  await settle(page);
  assert.deepEqual(await items(), ['x Try mnx 2.0', 'x Write a component', '  Ship 2.0']);

  await page.click('todo-app footer button:has-text("Open")');
  await settle(page);
  assert.deepEqual(await items(), ['  Ship 2.0']);
  await page.click('todo-app footer button:has-text("All")');
  await page.click('todo-app footer button:has-text("Clear done")');
  await settle(page);
  assert.deepEqual(await items(), ['  Ship 2.0']);

  await page.reload();
  await page.waitForFunction(() => window.ready);
  await settle(page);
  assert.deepEqual(await items(), ['  Ship 2.0'], 'saved in localStorage');
  assert.deepEqual(messages, []);
  await page.close();
});
