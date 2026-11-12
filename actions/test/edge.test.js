// The edge entry against the Node entry: the same components (built ahead of time for the edge,
// compiled at start-up on Node) must answer the same posts with the same status, headers and body.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createActions as createNode } from '../src/index.js';
import { createActions as createEdge } from '../src/edge.js';
import { buildActions } from '../src/build.js';

const components = new URL('./components', import.meta.url).pathname;
let dir;
let node;
let edge;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zubra-actions-edge-'));
  await buildActions({ components, out: join(dir, 'actions') });
  const { actions } = await import(pathToFileURL(join(dir, 'actions', 'index.js')).href);
  const options = { onError() {}, context: ({ request }) => ({ who: request.headers.get('x-user') }), maxBytes: 300 };
  node = await createNode({ components, cacheDir: join(dir, 'cache'), ...options });
  edge = createEdge({ actions, ...options });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const form = (values) => new URLSearchParams(values).toString();
const post = (path, { body = form({ email: 'a@example.com' }), headers = {} } = {}) =>
  () => new Request(`http://shop${path}`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'http://shop/login?next=1', ...headers } });

async function summary(response) {
  if (response === null) return null;
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    location: response.headers.get('location'),
    zbLocation: response.headers.get('zb-location'),
    cookies: response.headers.getSetCookie(),
    body: await response.text(),
  };
}

const cases = {
  'a plain post: 303 back to the page, the result in a cookie': post('/_zb/action/login-form/login'),
  'a plain post that fails its own check': post('/_zb/action/login-form/login', { body: form({ email: 'nobody@example.com' }) }),
  'the enhanced post: JSON': post('/_zb/action/login-form/login', { headers: { accept: 'application/json' } }),
  'a function that throws, enhanced: 500 and no detail': post('/_zb/action/login-form/crash', { headers: { accept: 'application/json' } }),
  'a function that throws, plain': post('/_zb/action/login-form/crash'),
  'a post over maxBytes, enhanced: 413': post('/_zb/action/login-form/login', { body: form({ email: 'a'.repeat(400) }), headers: { accept: 'application/json' } }),
  'a post over maxBytes, plain: back with the error': post('/_zb/action/login-form/login', { body: form({ email: 'a'.repeat(400) }) }),
  'a redirect, enhanced: 204 with zb-location': post('/_zb/action/login-form/away', { headers: { accept: 'application/json' } }),
  'a redirect, plain: followed by the browser': post('/_zb/action/login-form/away'),
  'a cross-site post is refused': post('/_zb/action/login-form/login', { headers: { origin: 'http://evil.example' } }),
  'Sec-Fetch-Site decides when sent': post('/_zb/action/login-form/login', { headers: { 'sec-fetch-site': 'cross-site' } }),
  'an action no component defines': post('/_zb/action/login-form/nope'),
  'GET on an action': () => new Request('http://shop/_zb/action/login-form/login'),
  'not ours': () => new Request('http://shop/about'),
  'a referer on another site goes back to the root': post('/_zb/action/login-form/login', { headers: { referer: 'http://evil.example/x' } }),
};

for (const [name, request] of Object.entries(cases)) {
  test(`same answer from both entries: ${name}`, async () => {
    const fromNode = await summary(await node.fetch(request()));
    const fromEdge = await summary(await edge.fetch(request()));
    assert.deepEqual(fromEdge, fromNode);
  });
}

test('both read the result cookie back the same way, once', async () => {
  const cookie = (await node.fetch(post('/_zb/action/login-form/login')())).headers.getSetCookie()[0].split(';')[0];
  const request = new Request('http://shop/login', { headers: { cookie } });
  const cleared = [];
  assert.deepEqual(edge.result(request, (...h) => cleared.push(h)), node.result(request));
  assert.deepEqual(edge.result(request), { action: '/_zb/action/login-form/login', value: { ok: true, email: 'a@example.com' } });
  assert.deepEqual(cleared, [['set-cookie', node.clearCookie]]);
  assert.deepEqual(edge.routes(), node.routes());
  assert.equal(edge.script(), node.script());
});

test("the script: the Node entry serves it; the edge entry only when given its source", async () => {
  const get = () => new Request('http://shop/_zb/actions.js');
  assert.equal(await edge.fetch(get()), null, 'left to static assets');
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  const withClient = createEdge({ actions: {}, client });
  assert.deepEqual(await summary(await withClient.fetch(get())), await summary(await node.fetch(get())));
});

test("context gets fetch's second argument: a Worker's env", async () => {
  const seen = [];
  const forms = createEdge({
    actions: { '/_zb/action/x-y/z': (data, { request, secret }) => ({ secret, name: data.get('name'), url: request.url }) },
    context: ({ request, env }) => (seen.push(request.url), { secret: env.SECRET }),
  });
  const response = await forms.fetch(new Request('http://shop/_zb/action/x-y/z', { method: 'POST', body: form({ name: 'Ada' }), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } }), { env: { SECRET: 's3' } });
  assert.deepEqual(await response.json(), { secret: 's3', name: 'Ada', url: 'http://shop/_zb/action/x-y/z' });
  assert.deepEqual(seen, ['http://shop/_zb/action/x-y/z']);
});

test('createActions refuses what is not routes', () => {
  assert.throws(() => createEdge(), /zubra-actions build/);
  assert.throws(() => createEdge({ actions: { '/elsewhere': () => {} } }), /not an action route/);
  assert.throws(() => createEdge({ actions: { '/_zb/action/a-b/c': 'nope' } }), /not an action route/);
});

test('the build: one file per component with server functions, imports that still resolve, leftovers removed', async () => {
  const out = join(dir, 'again');
  writeFileSync(join(mkdirp(out), 'gone-card.server.js'), '// Generated by `zubra-actions build` from x. stale');
  writeFileSync(join(out, 'mine.js'), '// not ours');
  const routes = await buildActions({ components, out });
  assert.deepEqual(routes, ['/_zb/action/login-form/login', '/_zb/action/login-form/crash', '/_zb/action/login-form/away']);
  assert.deepEqual(readdirSync(out).sort(), ['index.js', 'login-form.server.js', 'mine.js'], 'plain-card has no server functions; the stale file is gone; yours stays');
  const half = readFileSync(join(out, 'login-form.server.js'), 'utf8');
  assert.match(half, /^\/\/ Generated by `zubra-actions build` from .*login-form\.zb\. Don't edit it\./);
  assert.match(half, /from '\.\.\/.*test\/users\.js'/, 'the relative import points back at the source');
  const { actions } = await import(pathToFileURL(join(out, 'index.js')).href + '?again');
  assert.deepEqual(Object.keys(actions), routes);
});

test('the build reaches a component in a nested folder, its static and dynamic imports included, and both entries agree', async () => {
  const nested = new URL('./nested', import.meta.url).pathname;
  const out = join(dir, 'nested-out');
  const routes = await buildActions({ components: nested, out });
  assert.deepEqual(routes, ['/_zb/action/note-form/save']);
  assert.deepEqual(readdirSync(out).sort(), ['forms__parts__note-form.server.js', 'index.js']);
  const half = readFileSync(join(out, 'forms__parts__note-form.server.js'), 'utf8');
  assert.match(half, /import \{ tidy \} from '\.\.\/\.\.\/.*test\/nested\/lib\/tidy\.js'/);
  assert.match(half, /await import\('\.\.\/\.\.\/.*test\/nested\/lib\/stamp\.js'\)/, 'the dynamic import too');
  const { actions } = await import(pathToFileURL(join(out, 'index.js')).href);
  const fromEdge = createEdge({ actions });
  const fromNode = await createNode({ components: nested, cacheDir: join(dir, 'nested-cache') });
  const save = () => new Request('http://shop/_zb/action/note-form/save', { method: 'POST', body: form({ note: '  buy   eggs ' }), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  const [a, b] = [await (await fromEdge.fetch(save())).json(), await (await fromNode.fetch(save())).json()];
  assert.deepEqual(a, { note: 'buy eggs', at: 'now' });
  assert.deepEqual(a, b);
});

test('the build refuses two components defining one URL, and the command says how to use it', async () => {
  const src = mkdirp(join(dir, 'twice'));
  const source = readFileSync(join(components, 'login-form.zb'), 'utf8').replace("'../users.js'", `'${join(components, '..', 'users.js')}'`);
  writeFileSync(join(src, 'login-form.zb'), source);
  mkdirp(join(src, 'again'));
  writeFileSync(join(src, 'again', 'login-form.zb'), source);
  await assert.rejects(buildActions({ components: src, out: join(dir, 'twice-out') }), /two components define \/_zb\/action\/login-form\/login/);
  const bin = new URL('../bin/zubra-actions.js', import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [bin, 'build', components], { stdio: 'pipe' }), (error) => /Usage: zubra-actions build/.test(error.stderr) && error.status === 2);
  const output = execFileSync(process.execPath, [bin, 'build', components, '--out', join(dir, 'cli')], { encoding: 'utf8' });
  assert.match(output, /^3 actions → .*cli\/index\.js/);
  assert.ok(existsSync(join(dir, 'cli', 'login-form.server.js')));
});

function mkdirp(path) {
  execFileSync('mkdir', ['-p', path]);
  return path;
}

test('the edge entry takes maxBytes', async () => {
  const response = await edge.fetch(cases['a post over maxBytes, enhanced: 413']());
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Too large' });
});
