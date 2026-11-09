// 'use collection' in Chromium: state survives a reload, stays out of what's ephemeral, keeps
// documents apart, and follows across elements and tabs. No server holds any of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findCompiler } from '@zubra/server';
import { createSyncServer } from '../src/server.js';

findCompiler();
const compiler = await import('@zubra/compiler');
const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = dirname(fileURLToPath(import.meta.resolve('@zubra/runtime')));
const syncDir = join(here, '../src');

const module = (name) => {
  const path = join(here, 'components', `${name}.zb`);
  const response = compiler.request({ emit: 'js', path, files: compiler.sources(path), runtime: '@zubra/runtime' });
  if (!response.ok) throw new Error(response.error);
  return response.output;
};
const page = (body, connected = false) => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: { '@zubra/runtime': '/runtime/index.js', '@zubra/sync': '/sync/index.js' } })}</script>
</head><body>${body}<script type="module">import '/components/task-item.js';</script>${connected ? `<script type="module">import { connect } from '/sync/connect.js'; window.link = connect({ interval: 100 });</script>` : ''}</body></html>`;

let server;
let browser;
let base;
const sync = createSyncServer();
/** A Node request as a fetch Request (enough for the tests). */
const toRequest = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = req.method === 'GET' ? undefined : Buffer.concat(chunks);
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body });
};
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/_zb/sync/')) {
      const response = await sync.fetch(await toRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(await response.text());
    }
    const js = (text) => { res.setHeader('content-type', 'text/javascript'); res.end(text); };
    const file = (dir, rest) => {
      const path = normalize(join(dir, rest));
      if (!path.startsWith(dir)) return res.writeHead(404).end();
      try { js(readFileSync(path, 'utf8')); } catch { res.writeHead(404).end(); }
    };
    if (url.pathname.startsWith('/runtime/')) return file(runtimeDir, url.pathname.slice('/runtime/'.length));
    if (url.pathname.startsWith('/sync/')) return file(syncDir, url.pathname.slice('/sync/'.length));
    if (url.pathname === '/components/task-item.js') return js(module('task-item'));
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/two') return res.end(page('<task-item doc="a"></task-item><task-item doc="b"></task-item>'));
    if (url.pathname === '/connected') return res.end(page(`<task-item doc="${url.searchParams.get('doc').replace(/\W/g, '')}"></task-item>`, true));
    if (url.pathname === '/same') return res.end(page('<task-item doc="a" class="first"></task-item><task-item doc="a" class="second"></task-item>'));
    res.end(page('<task-item doc="a"></task-item>'));
  });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

const ready = (page) => page.waitForFunction(() => customElements.get('task-item'));
/** Wait for IndexedDB's write to land (the store writes behind the UI). */
const stored = (page) => page.evaluate(() => new Promise((done) => setTimeout(done, 100)));

test('state survives a reload; ephemeral state and the defaults don\'t overwrite it', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.goto(`${base}/`);
  await ready(tab);
  await tab.check('input[type=checkbox]');
  await tab.fill('.title', 'Buy milk');
  await tab.click('.tag');
  await tab.click('.tag');
  await tab.click('.edit');
  assert.equal(await tab.textContent('.editing'), 'editing');
  await stored(tab);
  await tab.reload();
  await ready(tab);
  await tab.waitForSelector('.state:has-text("done")');
  assert.equal(await tab.inputValue('.title'), 'Buy milk');
  assert.equal(await tab.textContent('.tags'), 't0,t1'); // a mutated array is stored too
  assert.equal(await tab.isChecked('input[type=checkbox]'), true);
  assert.equal(await tab.textContent('.editing'), 'viewing'); // ephemeral: back to its default
  const raw = await tab.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').get(['tasks', 'a']);
      request.onsuccess = () => done(request.result);
    };
  }));
  assert.deepEqual(raw, { completed: true, title: 'Buy milk', tags: ['t0', 't1'] });
  assert.deepEqual(errors, []);
  await context.close();
});

test('each document is its own; elements showing the same one follow each other', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/two`);
  await ready(tab);
  await tab.fill('task-item[doc=a] .title', 'Only A');
  await stored(tab);
  await tab.reload();
  await ready(tab);
  await tab.waitForFunction(() => document.querySelector('task-item[doc=a] .title').value === 'Only A');
  assert.equal(await tab.inputValue('task-item[doc=b] .title'), 'Untitled');

  await tab.goto(`${base}/same`);
  await ready(tab);
  await tab.waitForFunction(() => document.querySelector('.second .title').value === 'Only A');
  await tab.fill('.first .title', 'Both');
  await tab.waitForFunction(() => document.querySelector('.second .title').value === 'Both');
  await context.close();
});

test('another tab follows, with no server involved', async () => {
  const context = await browser.newContext();
  const one = await context.newPage();
  const two = await context.newPage();
  await one.goto(`${base}/`);
  await two.goto(`${base}/`);
  await ready(one);
  await ready(two);
  await one.check('input[type=checkbox]');
  await one.fill('.title', 'From tab one');
  await two.waitForSelector('.state:has-text("done")');
  await two.waitForFunction(() => document.querySelector('.title').value === 'From tab one');
  await context.close();
});

// Two browser contexts have separate storage: two devices.
async function device(doc) {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/connected?doc=${doc}`);
  await ready(tab);
  return { context, tab };
}
const title = (tab, value) => tab.waitForFunction((value) => document.querySelector('.title').value === value, value, { timeout: 5000 });

test('connected: another device gets the change through the log', async () => {
  const a = await device('first');
  const b = await device('first');
  await a.tab.fill('.title', 'Written on A');
  await a.tab.check('input[type=checkbox]');
  await title(b.tab, 'Written on A');
  await b.tab.waitForSelector('.state:has-text("done")');
  // And it's in B's own store, with the clock it won by.
  const stored = await b.tab.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').get(['tasks', 'first']);
      request.onsuccess = () => done(request.result);
    };
  }));
  assert.equal(stored.title, 'Written on A');
  assert.match(stored.$clocks.title, /^\d{15}-\d{5}-\w+$/);
  await a.context.close();
  await b.context.close();
});

test('connected: a device that was offline catches up both ways, and concurrent edits converge', async () => {
  const a = await device('second');
  const b = await device('second');
  await a.context.setOffline(true);
  await a.tab.fill('.title', 'A, offline');
  await a.tab.waitForTimeout(30);
  await b.tab.fill('.title', 'B, later');
  await b.tab.waitForTimeout(300);
  assert.equal(await a.tab.inputValue('.title'), 'A, offline'); // still offline: nothing came in
  await a.context.setOffline(false);
  // B's write is later, so both end on it, whichever reached the log first: B must not take
  // A's older write when it pulls it.
  await title(a.tab, 'B, later');
  await b.tab.waitForTimeout(600);
  assert.equal(await b.tab.inputValue('.title'), 'B, later');
  assert.equal(await a.tab.inputValue('.title'), 'B, later');
  // A field only A touched while offline reaches B.
  await a.context.setOffline(true);
  await a.tab.check('input[type=checkbox]');
  await a.tab.waitForTimeout(300); // its pushes fail meanwhile; the write waits in the outbox
  await a.context.setOffline(false);
  await b.tab.waitForSelector('.state:has-text("done")', { timeout: 5000 });
  await a.context.close();
  await b.context.close();
});
