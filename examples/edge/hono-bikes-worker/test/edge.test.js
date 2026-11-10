// The bike shop on a Cloudflare Worker, run in workerd (Wrangler's local runtime), against the same
// shop on Node.js: the same requests must get the same status, redirect and HTML, byte for byte.
// What differs is only the host: sources and a WebAssembly module instead of a components folder,
// static assets instead of a disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../hypermedia/hono-bikes/src/app.js';
import { createStore } from '../../../hypermedia/hono-bikes/src/store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let worker; // { child, url }
let node; // the Node.js app

const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

before(async () => {
  node = createApp({ store: createStore() });
  const port = await freePort();
  const child = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1'], {
    cwd: root,
    detached: true, // its own process group, so the whole tree (npx, wrangler, workerd) can be stopped
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  worker = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not become ready in 90s:\n${log}`)), 90_000);
    const seen = (data) => {
      log += data;
      if (/Ready on/.test(log)) {
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${port}` });
      }
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.once('exit', (code) => reject(new Error(`wrangler dev exited with ${code}:\n${log}`)));
  });
}, { timeout: 120_000 });

after(() => {
  if (worker) try { process.kill(-worker.child.pid, 'SIGTERM'); } catch {}
});

const HTMX = { 'HX-Request': 'true' };
const form = (values) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });

/** What the Worker and the Node.js app each answer to the same request. */
async function both(path, init = {}) {
  const [fromWorker, fromNode] = await Promise.all([
    fetch(worker.url + path, { redirect: 'manual', ...init }),
    node.request(path, init),
  ]);
  const summary = async (response) => ({
    status: response.status,
    type: response.headers.get('content-type'),
    location: response.headers.get('location'),
    body: await response.text(),
  });
  return { worker: await summary(fromWorker), node: await summary(fromNode) };
}

async function same(path, init) {
  const { worker: a, node: b } = await both(path, init);
  assert.deepEqual(a, b, `${init?.method ?? 'GET'} ${path}`);
  return a;
}

test('whole pages: the list, a search, a category, the second page, an empty result, the edit page', async () => {
  const home = await same('/');
  assert.equal(home.status, 200);
  assert.match(home.body, /<price-tag cents="129900">/);
  assert.match(home.body, /\$1,299\.00/, 'the price is complete in the server HTML');
  for (const path of ['/?q=chain', '/?category=parts', '/?page=2', '/?q=zzzz', '/items/3/edit']) await same(path);
});

test('htmx fragments: more rows, the edit form, one row', async () => {
  for (const path of ['/items?page=2', '/items?q=tube', '/items/3/edit', '/items/3']) {
    const result = await same(path, { headers: HTMX });
    assert.equal(result.status, 200, path);
    assert.doesNotMatch(result.body, /<!doctype/i, `${path} is a fragment`);
  }
});

test('redirects and missing items', async () => {
  const redirect = await same('/items?q=x');
  assert.equal(redirect.status, 303);
  assert.equal(redirect.location, '/?q=x&page=1');
  assert.equal((await same('/items/3')).status, 303);
  assert.equal((await same('/items/999')).status, 404);
  assert.equal((await same('/items/999/edit', { headers: HTMX })).status, 404);
});

test('selling, and editing with errors and without, leave both shops in the same state', async () => {
  for (const path of ['/items/1/sell', '/items/1/sell', '/items/5/sell']) {
    const sold = await same(path, { method: 'POST', headers: HTMX });
    assert.equal(sold.status, 200);
    assert.match(sold.body, /id="low-count"/, 'the low-stock count comes with the row');
  }
  const invalid = await same('/items/2', { ...form({ name: '', price: '-1', count: '1000', tags: 'a' }), headers: { ...HTMX, 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(invalid.status, 422);
  assert.match(invalid.body, /A name, please\./);
  assert.equal((await same('/items/2', form({ name: '', price: '1', count: '1', tags: '' }))).status, 422, 'a plain form post gets a whole page');
  const saved = await same('/items/2', { ...form({ name: 'City 8-speed', price: '700.50', count: '3', tags: 'Commuter, city' }), headers: { ...HTMX, 'content-type': 'application/x-www-form-urlencoded' } });
  assert.match(saved.body, /City 8-speed/);
  assert.match(saved.body, /\$700\.50/);
  await same('/'); // both lists show the edits and the sales
  assert.equal((await same('/items/1/sell', { method: 'POST' })).status, 303, 'a plain post redirects');
  assert.equal((await both('/reset', { method: 'POST' })).worker.status, 204);
  await same('/');
});

test('the browser modules are served by the Worker; htmx, the stylesheet and the runtime by its static assets', async () => {
  const home = await (await fetch(worker.url + '/')).text();
  const imports = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(home)[1]).imports;
  assert.equal(imports['@zubra/runtime'], '/_zubra/runtime/index.js');
  for (const path of [...Object.values(imports), '/app.css', '/vendor/htmx.js', '/_zubra/components/price-tag.js', '/_zubra/components/qty-input.js']) {
    const response = await fetch(worker.url + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /javascript|css/, path);
    await response.arrayBuffer();
  }
  const modulePath = /import '(\/_zubra\/components\/[^']+)'/.exec(home)[1];
  assert.match(await (await fetch(worker.url + modulePath)).text(), /^\/\/ Generated by zubra/);
  assert.equal((await fetch(worker.url + '/_zubra/components/nope.js')).status, 404);
});
