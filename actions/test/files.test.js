// Files in an action: a file field reaches the function as a File, on both paths, and a post over
// `maxBytes` is refused before the function runs, whether or not it says how big it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createActions } from '../src/index.js';
import { createServer, get, request } from 'node:http';

const components = fileURLToPath(new URL('./files', import.meta.url));
const URL_UPLOAD = 'http://localhost/_zb/action/photo-form/upload';
const ran = [];
const make = (options) => createActions({ components, onError: () => {}, context: () => (ran.push(1), {}), ...options });

const photo = (size, name = 'barn.png') => new File([new Uint8Array(size).fill(7)], name, { type: 'image/png' });
const form = (file, caption = 'Red barn') => {
  const body = new FormData();
  body.append('caption', caption);
  body.append('photo', file);
  return body;
};
const post = (actions, body, headers = {}) => actions.fetch(new Request(URL_UPLOAD, { method: 'POST', body, headers }));
/** The same post sent in chunks, with no content-length: the size is only found by reading it. */
const streamed = async (body) => {
  const encoded = new Response(body);
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const stream = new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 1000) controller.enqueue(bytes.slice(at, at + 1000));
      controller.close();
    },
  });
  return new Request(URL_UPLOAD, { method: 'POST', body: stream, duplex: 'half', headers: { 'content-type': encoded.headers.get('content-type'), accept: 'application/json' } });
};

test('a file field reaches the function as a File: name, type, size and bytes', async () => {
  const actions = await make();
  const response = await post(actions, form(photo(2048)), { accept: 'application/json' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: 'barn.png', type: 'image/png', size: 2048, first: 7, caption: 'Red barn' });
});

test('without JavaScript too: the result comes back to the page in the cookie', async () => {
  const actions = await make();
  const response = await post(actions, form(photo(10)), { referer: 'http://localhost/listing' });
  assert.equal(response.status, 303);
  const next = new Request('http://localhost/listing', { headers: { cookie: response.headers.get('set-cookie').split(';')[0] } });
  assert.equal(actions.result(next).value.size, 10);
});

test('a post over maxBytes is refused with 413 before the function runs', async () => {
  const actions = await make({ maxBytes: 4096 });
  ran.length = 0;
  const response = await post(actions, form(photo(5000)), { accept: 'application/json' });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Too large' });
  assert.equal(ran.length, 0, 'not even context() ran');
  const fits = await post(actions, form(photo(3000)), { accept: 'application/json' });
  assert.equal((await fits.json()).size, 3000);
});

test('a post that says it is over the limit is refused unread', { timeout: 3000 }, async () => {
  const actions = await make({ maxBytes: 4096 });
  ran.length = 0;
  let pulled = 0;
  const body = new ReadableStream({ pull: () => void pulled++ });
  const request = new Request(URL_UPLOAD, { method: 'POST', body, duplex: 'half', headers: { 'content-length': '999999', 'content-type': 'multipart/form-data; boundary=x', accept: 'application/json' } });
  assert.equal((await actions.fetch(request)).status, 413);
  assert.equal(ran.length, 0);
  assert.equal(pulled <= 1, true, 'not read');
});

test("a post that doesn't say its size is counted as it's read", async () => {
  const actions = await make({ maxBytes: 4096 });
  ran.length = 0;
  const big = await actions.fetch(await streamed(form(photo(5000))));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'Too large' });
  assert.equal(ran.length, 0);
  const small = await actions.fetch(await streamed(form(photo(3000))));
  assert.equal((await small.json()).size, 3000);
});

test('without JavaScript, a post over the limit goes back to the page with the error', async () => {
  const actions = await make({ maxBytes: 4096 });
  const response = await post(actions, form(photo(5000)), { referer: 'http://localhost/listing' });
  assert.equal(response.status, 303);
  const next = new Request('http://localhost/listing', { headers: { cookie: response.headers.get('set-cookie').split(';')[0] } });
  assert.deepEqual(actions.result(next).value, { error: 'Too large' });
});

test('10 MB by default; Infinity for no limit; anything else is refused', async () => {
  const actions = await make();
  const big = await post(actions, form(photo(10 * 1024 * 1024 + 1)), { accept: 'application/json' });
  assert.equal(big.status, 413);
  const unlimited = await make({ maxBytes: Infinity });
  assert.equal((await (await post(unlimited, form(photo(10 * 1024 * 1024 + 1)), { accept: 'application/json' })).json()).size, 10 * 1024 * 1024 + 1);
  for (const maxBytes of [0, -1, 'big', null]) await assert.rejects(() => make({ maxBytes }), /maxBytes/);
});

test("Node's http: a refused upload is answered without reading it all, and the server keeps serving", async () => {
  const actions = await make({ maxBytes: 4096 });
  const server = createServer(async (req, res) => {
    if (!(await actions.handle(req, res))) res.end('page');
  });
  await new Promise((done) => server.listen(0, done));
  const base = `http://localhost:${server.address().port}`;
  try {
    const refused = await fetch(`${base}/_zb/action/photo-form/upload`, { method: 'POST', body: form(photo(1024 * 1024)), headers: { accept: 'application/json' } });
    assert.equal(refused.status, 413);
    assert.equal(await (await fetch(`${base}/`)).text(), 'page');
    // Sent in chunks with no declared size: counted, and still answered rather than cut off.
    // (Node's http client: fetch gives up on a streamed upload that's answered before it ends.)
    const { status, text } = await new Promise((done, fail) => {
      const sending = request(`${base}/_zb/action/photo-form/upload`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'multipart/form-data; boundary=zz', 'transfer-encoding': 'chunked' } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => done({ status: res.statusCode, text }));
      });
      sending.on('error', fail);
      const chunk = Buffer.alloc(16384, 97);
      let sent = 0;
      (function write() {
        while (sent < 1024 * 1024) {
          sent += chunk.length;
          if (!sending.write(chunk)) return sending.once('drain', write);
        }
        sending.end();
      })();
    });
    assert.equal(status, 413);
    assert.deepEqual(JSON.parse(text), { error: 'Too large' });
    // On a new connection: fetch's pool may hand back the one it gave up on mid-upload.
    const page = await new Promise((done, fail) => get(`${base}/`, { agent: false }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => done(text));
    }).on('error', fail));
    assert.equal(page, 'page', 'and it keeps serving');
  } finally {
    server.close();
  }
});
