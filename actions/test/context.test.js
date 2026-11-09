import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createActions } from '../src/index.js';

const components = fileURLToPath(new URL('./context', import.meta.url));
const body = () => new URLSearchParams({ note: 'hi' });

test('context() adds per-request values to what a server function gets', async () => {
  const actions = await createActions({
    components,
    context: async ({ request }) => ({ user: request.headers.get('x-user'), request: 'not this one' }),
  });
  const response = await actions.fetch(new Request('http://localhost/_zb/action/whoami-box/whoami', {
    method: 'POST', body: body(), headers: { accept: 'application/json', 'x-user': 'ada' },
  }));
  // `request` is always the real one.
  assert.deepEqual(await response.json(), { user: 'ada', note: 'hi', method: 'POST' });
});

test('on Node, context() gets the Node request (what an auth middleware decorated)', async () => {
  const actions = await createActions({ components, context: ({ req }) => ({ user: req.user }) });
  const server = createServer(async (req, res) => {
    req.user = 'grace'; // an auth middleware ran first
    if (!(await actions.handle(req, res))) res.end('page');
  });
  await new Promise((done) => server.listen(0, done));
  try {
    const response = await fetch(`http://localhost:${server.address().port}/_zb/action/whoami-box/whoami`, {
      method: 'POST', body: body(), headers: { accept: 'application/json' },
    });
    assert.deepEqual(await response.json(), { user: 'grace', note: 'hi', method: 'POST' });
  } finally {
    server.close();
  }
});

test('a context() that throws is a generic 500, like the function throwing', async () => {
  const actions = await createActions({ components, onError: () => {}, context: () => { throw new Error('no session store'); } });
  const response = await actions.fetch(new Request('http://localhost/_zb/action/whoami-box/whoami', {
    method: 'POST', body: body(), headers: { accept: 'application/json' },
  }));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /session store/);
});
