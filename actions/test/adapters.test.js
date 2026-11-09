import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import express from 'express';
import Fastify from 'fastify';
import { actions as honoActions } from '../src/hono.js';
import { actions as expressActions } from '../src/express.js';
import { actions as fastifyActions } from '../src/fastify.js';

const components = fileURLToPath(new URL('./components', import.meta.url));
const body = () => new URLSearchParams({ email: 'b@example.com' });

/** Post without JavaScript, then load the page with the cookie: the page sees the result once. */
async function roundTrip(base) {
  const posted = await fetch(`${base}/_zb/action/login-form/login`, { method: 'POST', body: body(), redirect: 'manual', headers: { referer: `${base}/page` } });
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.get('location'), '/page');
  const cookie = posted.headers.getSetCookie()[0].split(';')[0];
  const page = await fetch(`${base}/page`, { headers: { cookie } });
  assert.equal(await page.text(), '{"error":"Invalid login"}');
  assert.match(page.headers.getSetCookie()[0], /Max-Age=0/);
  const json = await fetch(`${base}/_zb/action/login-form/login`, { method: 'POST', body: body(), headers: { accept: 'application/json' } });
  assert.deepEqual(await json.json(), { error: 'Invalid login' });
}

const listen = (server) => new Promise((done) => server.listen(0, () => done(`http://localhost:${server.address().port}`)));

test('Hono', async () => {
  const app = new Hono();
  app.use(await honoActions({ components }));
  app.get('/page', (c) => c.text(JSON.stringify(c.get('zubraAction')?.value ?? null)));
  const { createServer } = await import('node:http');
  const { send, toRequest } = await import('../src/index.js');
  const server = createServer(async (req, res) => send(await app.fetch(toRequest(req)), res));
  try {
    await roundTrip(await listen(server));
  } finally {
    server.close();
  }
});

test('Express (mounted before the body parsers)', async () => {
  const app = express();
  app.use(await expressActions({ components }));
  app.use(express.urlencoded({ extended: false }));
  app.get('/page', (req, res) => res.send(JSON.stringify(res.locals.zubraAction?.value ?? null)));
  const server = app.listen(0);
  await new Promise((done) => server.once('listening', done));
  try {
    await roundTrip(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
});

test('Fastify', async () => {
  const app = Fastify();
  await app.register(fastifyActions, { components });
  app.get('/page', (request) => JSON.stringify(request.zubraAction?.value ?? null));
  const base = await app.listen({ port: 0 });
  try {
    await roundTrip(base.replace('127.0.0.1', 'localhost').replace('[::1]', 'localhost'));
  } finally {
    await app.close();
  }
});
