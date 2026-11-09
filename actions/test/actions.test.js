import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createActions } from '../src/index.js';

const components = fileURLToPath(new URL('./components', import.meta.url));
const actions = await createActions({ components, onError: () => {} });
const URL_LOGIN = 'http://localhost/_zb/action/login-form/login';

const post = (url, fields, headers = {}) => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return actions.fetch(new Request(url, { method: 'POST', body, headers }));
};

test('every component\'s server functions are routed, and only those', () => {
  assert.deepEqual(actions.routes().sort(), [
    '/_zb/action/login-form/away',
    '/_zb/action/login-form/crash',
    '/_zb/action/login-form/login',
  ]);
});

test('the enhanced path gets the return value as JSON', async () => {
  const response = await post(URL_LOGIN, { email: 'a@example.com' }, { accept: 'application/json' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, email: 'a@example.com' });
  const refused = await post(URL_LOGIN, { email: 'b@example.com' }, { accept: 'application/json' });
  assert.deepEqual(await refused.json(), { error: 'Invalid login' });
});

test('the browser\'s own post goes back to the page, with the result in a one-use cookie', async () => {
  const response = await post(URL_LOGIN, { email: 'b@example.com' }, { referer: 'http://localhost/login?next=1' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/login?next=1');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__zb_result=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60$/);
  const next = new Request('http://localhost/login', { headers: { cookie: cookie.split(';')[0] } });
  const cleared = [];
  assert.deepEqual(actions.result(next, (name, value) => cleared.push([name, value])), {
    action: '/_zb/action/login-form/login',
    value: { error: 'Invalid login' },
  });
  assert.match(cleared[0][1], /Max-Age=0/);
  assert.equal(actions.result(new Request('http://localhost/login')), null);
});

test('a referer on another site never becomes the redirect', async () => {
  const response = await post(URL_LOGIN, { email: 'a@example.com' }, { referer: 'https://evil.example/x' });
  assert.equal(response.headers.get('location'), '/');
});

test('cross-site posts are refused', async () => {
  assert.equal((await post(URL_LOGIN, { email: 'a@example.com' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(URL_LOGIN, { email: 'a@example.com' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(URL_LOGIN, { email: 'a@example.com' }, { origin: 'http://localhost', accept: 'application/json' })).status, 200);
  assert.equal((await post(URL_LOGIN, { email: 'a@example.com' }, { 'sec-fetch-site': 'same-origin', accept: 'application/json' })).status, 200);
});

test('unknown actions are 404, other methods 405, other paths not ours', async () => {
  assert.equal((await post('http://localhost/_zb/action/login-form/nope', {})).status, 404);
  assert.equal((await actions.fetch(new Request(URL_LOGIN))).status, 405);
  assert.equal(await actions.fetch(new Request('http://localhost/login', { method: 'POST', body: '' })), null);
});

test('a thrown error is a generic 500, never the message', async () => {
  const response = await post('http://localhost/_zb/action/login-form/crash', {}, { accept: 'application/json' });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.doesNotMatch(body, /secret detail/);
});

test('a returned Response passes through', async () => {
  const response = await post('http://localhost/_zb/action/login-form/away', {});
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'http://localhost/elsewhere');
});

test('the client script is served, and the page gets a tag for it', async () => {
  const response = await actions.fetch(new Request('http://localhost/_zb/actions.js'));
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /beforeaction/);
  assert.equal(actions.script(), '<script type="module" src="/_zb/actions.js"></script>');
});

test('Node\'s http: answers ours, leaves the rest (and their bodies) alone', async () => {
  const server = createServer(async (req, res) => {
    if (await actions.handle(req, res)) return;
    res.end(`page ${JSON.stringify(actions.result(req))}`);
  });
  await new Promise((done) => server.listen(0, done));
  const base = `http://localhost:${server.address().port}`;
  try {
    const body = new URLSearchParams({ email: 'a@example.com' });
    const json = await fetch(`${base}/_zb/action/login-form/login`, { method: 'POST', body, headers: { accept: 'application/json' } });
    assert.deepEqual(await json.json(), { ok: true, email: 'a@example.com' });
    const plain = await fetch(`${base}/_zb/action/login-form/login`, { method: 'POST', body, redirect: 'manual' });
    assert.equal(plain.status, 303);
    const page = await fetch(`${base}/`, { headers: { cookie: plain.headers.getSetCookie()[0].split(';')[0] } });
    assert.match(await page.text(), /"email":"a@example.com"/);
  } finally {
    server.close();
  }
});

test('the server halves are not in the browser modules', async () => {
  const compiler = await import('@zubra/compiler');
  const path = `${components}/login-form.zb`;
  const js = compiler.request({ emit: 'js', path, files: compiler.sources(path), runtime: '@zubra/runtime' });
  assert.ok(js.ok, js.error);
  assert.doesNotMatch(js.output, /users\.js|secret detail|Invalid login/);
});
