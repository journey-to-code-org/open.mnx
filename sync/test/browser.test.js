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
import { request as forward } from 'node:http';
import { createSyncServer } from '../src/server.js';
import { startBinary } from './backends.js';

// ZUBRA_SYNC_BACKEND=binary serves /_zb/sync from the zubra-sync binary instead, behind this
// server as a reverse proxy (the deployment the binary's docs describe), so the same tests check
// that the binary and @zubra/sync/server behave alike for real clients.
const viaBinary = process.env.ZUBRA_SYNC_BACKEND === 'binary';
let binary = null;
let presencePosts = 0;
let dropSignals = 0; // a test can lose the next few signaling messages on purpose

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
const page = (body, connected = false, component = 'task-item') => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: { '@zubra/runtime': '/runtime/index.js', '@zubra/sync': '/sync/index.js' } })}</script>
</head><body>${body}<script type="module">import '/components/${component}.js';</script>${connected ? `<script type="module">import { connect } from '/sync/connect.js'; window.link = connect(${JSON.stringify(connected === true ? { interval: 100, live: false } : connected)});</script>` : ''}</body></html>`;

let server;
let browser;
let base;
const sync = createSyncServer();
before(async () => {
  if (viaBinary) binary = await startBinary(['--keep-alive', '200']);
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.url.startsWith('/_zb/sync/presence')) presencePosts += 1;
    if (req.url.startsWith('/_zb/sync/signal') && dropSignals > 0) {
      dropSignals -= 1;
      req.resume();
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    }
    if (viaBinary && req.url.startsWith('/_zb/sync/')) {
      const target = new URL(binary.base);
      const upstream = forward({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        res.flushHeaders();
        answer.pipe(res);
      });
      res.on('close', () => upstream.destroy());
      return req.pipe(upstream);
    }
    if (await sync.handle(req, res)) return;
    const js = (text) => { res.setHeader('content-type', 'text/javascript'); res.end(text); };
    const file = (dir, rest) => {
      const path = normalize(join(dir, rest));
      if (!path.startsWith(dir)) return res.writeHead(404).end();
      try { js(readFileSync(path, 'utf8')); } catch { res.writeHead(404).end(); }
    };
    if (url.pathname.startsWith('/runtime/')) return file(runtimeDir, url.pathname.slice('/runtime/'.length));
    if (url.pathname.startsWith('/sync/')) return file(syncDir, url.pathname.slice('/sync/'.length));
    if (url.pathname.startsWith('/components/')) return js(module(url.pathname.slice('/components/'.length).replace(/\.js$/, '')));
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/two') return res.end(page('<task-item doc="a"></task-item><task-item doc="b"></task-item>'));
    const doc = (url.searchParams.get('doc') ?? 'a').replace(/\W/g, '');
    // A store that takes a while to answer, set up before the element starts.
    if (url.pathname === '/slow') return res.end(page(`<script type="module">import { configure, indexedDBStore } from '/sync/index.js'; const store = indexedDBStore(); configure({ store: { get: (c, k) => new Promise((done) => setTimeout(done, 800)).then(() => store.get(c, k)), set: (c, k, f) => store.set(c, k, f) } });</script><task-item doc="${doc}"></task-item>`));
    // Live only: polling every minute, so anything sooner came over the event stream.
    if (url.pathname === '/live') return res.end(page(`<task-item doc="${doc}"></task-item>`, { interval: 60_000 }));
    const connectTo = url.searchParams.has('rtc') ? { interval: 60_000, webrtc: true } : url.searchParams.has('connect') ? { interval: 60_000 } : false;
    if (url.pathname === '/board') return res.end(page(`<board-view doc="${doc}"></board-view>`, connectTo, 'board-view'));
    if (url.pathname === '/connected') return res.end(page(`<task-item doc="${url.searchParams.get('doc').replace(/\W/g, '')}"></task-item>`, true));
    if (url.pathname === '/same') return res.end(page('<task-item doc="a" class="first"></task-item><task-item doc="a" class="second"></task-item>'));
    res.end(page('<task-item doc="a"></task-item>'));
  });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
  // Real local addresses in ICE candidates (Chromium hides them behind mDNS names by default,
  // which a test machine may not resolve).
  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  server?.close();
  binary?.close();
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
  try {
    await b.tab.waitForSelector('.state:has-text("done")', { timeout: 5000 });
  } catch (error) {
    const log = await (await fetch(`${base}/_zb/sync/pull?since=0`)).json();
    console.log('DEBUG log', JSON.stringify(log.changes.filter((c) => c.key === 'first')));
    console.log('DEBUG A outbox', await a.tab.evaluate(() => localStorage.getItem('zubra-sync:outbox')), 'B cursor', await b.tab.evaluate(() => localStorage.getItem('zubra-sync:cursor')));
    console.log('DEBUG A state', await a.tab.textContent('.state'));
    throw error;
  }
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

test('live: a change arrives over the event stream, without waiting for a poll', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await a.newPage();
  const two = await b.newPage();
  await one.goto(`${base}/live?doc=third`);
  await two.goto(`${base}/live?doc=third`);
  await ready(one);
  await ready(two);
  await two.waitForTimeout(300); // let both streams open
  await one.fill('.title', 'Over the stream');
  await title(two, 'Over the stream');
  await a.close();
  await b.close();
});

const board = async (context, doc, connect = false) => {
  const tab = await context.newPage();
  await tab.goto(`${base}/board?doc=${doc}${connect === 'rtc' ? '&rtc' : connect ? '&connect' : ''}`);
  await tab.waitForFunction(() => customElements.get('board-view'));
  return tab;
};
const point = async (tab, x, y) => {
  const box = await tab.locator('.pad').boundingBox();
  await tab.mouse.move(box.x + x, box.y + y);
};

test('presence: other tabs see where you are, and see you leave; nothing is stored', async () => {
  const context = await browser.newContext();
  const one = await board(context, 'b1');
  const two = await board(context, 'b1');
  await point(one, 40, 30);
  await two.waitForSelector('.other:has-text("40,30")');
  assert.equal(await two.textContent('.count'), '1');
  await point(two, 10, 20);
  await one.waitForSelector('.other:has-text("10,20")');
  assert.equal(await one.textContent('.count'), '1'); // itself isn't a peer
  // Another document's room is another room.
  const elsewhere = await board(context, 'b2');
  await elsewhere.waitForTimeout(200);
  assert.equal(await elsewhere.textContent('.count'), '0');
  await two.click('.stroke');
  await two.waitForTimeout(150);
  await one.close();
  await two.waitForSelector('.count:has-text("0")');
  const stored = await two.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').get(['boards', 'b1']);
      request.onsuccess = () => done(request.result);
    };
  }));
  assert.deepEqual(Object.keys(stored ?? {}).sort(), ['strokes']);
  await context.close();
});

test('presence: other devices too, through the server, and a closed tab leaves', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await board(a, 'b3', true);
  const two = await board(b, 'b3', true);
  await one.waitForTimeout(300);
  await point(one, 55, 66);
  await two.waitForSelector('.other:has-text("55,66")', { timeout: 5000 });
  await one.close();
  await two.waitForSelector('.count:has-text("0")', { timeout: 5000 });
  await a.close();
  await b.close();
});

test('webrtc: once two devices have a data channel, presence stops going through the server', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await board(a, 'b5', 'rtc');
  const two = await board(b, 'b5', 'rtc');
  await one.waitForTimeout(300);
  await point(one, 10, 10); // the introduction goes through the server, and starts the channel
  await two.waitForSelector('.other:has-text("10,10")', { timeout: 5000 });
  await point(two, 5, 5);
  await one.waitForSelector('.other:has-text("5,5")', { timeout: 5000 });
  // The channel opens (both ends).
  for (const tab of [one, two]) await tab.waitForFunction(() => window.link.direct().length === 1, null, { timeout: 30_000 });
  presencePosts = 0;
  for (let step = 1; step <= 20; step += 1) {
    await point(one, 20 + step * 2, 30 + step * 2);
    await one.waitForTimeout(20);
  }
  await two.waitForSelector('.other:has-text("60,70")', { timeout: 5000 });
  assert.ok(presencePosts <= 1, `${presencePosts} presence posts went through the server`);
  // A goodbye still goes through the server.
  await one.close();
  await two.waitForSelector('.count:has-text("0")', { timeout: 5000 });
  await a.close();
  await b.close();
});

test('webrtc: a lost signal doesn\'t strand the pair; they start again', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  dropSignals = 1; // the first signal (the offer) never arrives
  const one = await board(a, 'b6', 'rtc');
  const two = await board(b, 'b6', 'rtc');
  // Keep moving (presence through the server is what brings each side back to the pair).
  let moving = true;
  const wiggle = (async () => {
    for (let step = 0; moving; step += 1) {
      await point(one, 10 + (step % 50), 10);
      await point(two, 10, 10 + (step % 50));
      await one.waitForTimeout(150);
    }
  })();
  for (const tab of [one, two]) await tab.waitForFunction(() => window.link.direct().length === 1, null, { timeout: 30_000 });
  moving = false;
  await wiggle;
  assert.equal(dropSignals, 0);
  await a.close();
  await b.close();
});

test('an edit made while the document is still loading is kept, and saved', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/slow?doc=early`);
  await ready(tab);
  await tab.fill('.title', 'Typed before it loaded'); // the store answers 800 ms later
  await tab.waitForTimeout(1200);
  assert.equal(await tab.inputValue('.title'), 'Typed before it loaded');
  await tab.goto(`${base}/slow?doc=early`);
  await ready(tab);
  await tab.waitForFunction(() => document.querySelector('.title').value === 'Typed before it loaded', null, { timeout: 5000 });
  await context.close();
});

