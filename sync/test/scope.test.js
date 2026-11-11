// Scope: a page asks only for what it shows, and the server can impose one (tenancy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer, inScope, parseScope } from '../src/server.js';
import { backends } from './backends.js';

let n = 0;
const at = () => `${String(++n).padStart(15, '0')}-00000-dev1`;
const change = (collection, key, value) => ({ collection, key, field: 'v', value, clock: at() });
const url = (path, scope) => `http://shop/_zb/sync${path}${scope === undefined ? '' : `${path.includes('?') ? '&' : '?'}scope=${encodeURIComponent(JSON.stringify(scope))}`}`;
const push = (sync, changes, headers = {}) => sync.fetch(new Request(url('/push'), { method: 'POST', body: JSON.stringify({ changes }), headers: { 'content-type': 'application/json', ...headers } }));
const pull = async (sync, scope, headers = {}) => (await sync.fetch(new Request(url('/pull?since=0', scope), { headers }))).json();
const join = (sync, room, peer, headers = {}) => sync.fetch(new Request(url('/presence'), { method: 'POST', body: JSON.stringify({ room, peer, state: { here: true } }), headers: { 'content-type': 'application/json', ...headers } }));
async function* events(response) {
  const reader = response.body.getReader();
  let text = '';
  for (;;) {
    let end;
    while ((end = text.indexOf('\n\n')) < 0) text += new TextDecoder().decode((await reader.read()).value);
    const block = text.slice(0, end);
    text = text.slice(end + 2);
    const event = /^event: (\w+)/m.exec(block)?.[1];
    if (event) yield { event, data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) };
  }
}
const live = async (sync, peer, scope, headers = {}) => events(await sync.fetch(new Request(url(`/live?since=0&peer=${peer}`, scope), { headers })));
const values = (body) => body.changes.map((c) => c.value);

async function seeded(backend) {
  const sync = await backend.start();
  await push(sync, [
    change('seats', 'showing-12/A1', 'a1'),
    change('seats', 'showing-12/A2', 'a2'),
    change('seats', 'showing-13/A1', 'other showing'),
    change('holds', 'showing-12/guest', 'hold'),
    change('brands', 'garrett-8', 'brand'),
  ]);
  return sync;
}

for (const backend of backends) {
  test(`${backend.name}: pull: a scope by collection and key prefix`, async () => {
  const sync = await seeded(backend);
  assert.deepEqual(values(await pull(sync)), ['a1', 'a2', 'other showing', 'hold', 'brand'], 'no scope: everything');
  assert.deepEqual(values(await pull(sync, { seats: 'showing-12/' })), ['a1', 'a2']);
  assert.deepEqual(values(await pull(sync, { seats: 'showing-12/', holds: 'showing-12/', brands: true })), ['a1', 'a2', 'hold', 'brand']);
  assert.deepEqual(values(await pull(sync, { seats: ['showing-13/', 'showing-12/A2'] })), ['a2', 'other showing'], 'a list of prefixes');
  assert.deepEqual(values(await pull(sync, {})), [], 'an empty scope: nothing');
  // The cursor is the log's, wherever the scope stops: the next pull starts after all of it.
  assert.equal((await pull(sync, { brands: true })).cursor, 5);
  sync.close();
});

  test(`${backend.name}: live: the backlog, new changes and presence, each within the page's scope`, { timeout: 5000 }, async () => {
  const sync = await seeded(backend);
  const twelve = await live(sync, 'p12', { seats: 'showing-12/', holds: 'showing-12/' });
  const thirteen = await live(sync, 'p13', { seats: 'showing-13/' });
  assert.deepEqual(values((await twelve.next()).value.data), ['a1', 'a2', 'hold']);
  assert.deepEqual(values((await thirteen.next()).value.data), ['other showing']);
  await push(sync, [change('seats', 'showing-13/B4', 'taken in 13'), change('seats', 'showing-12/B4', 'taken in 12')]);
  assert.deepEqual(values((await twelve.next()).value.data), ['taken in 12']);
  assert.deepEqual(values((await thirteen.next()).value.data), ['taken in 13']);
  // Someone looking at showing 13's seat: only showing 13's page hears of it.
  await join(sync, 'seats/showing-13/B4', 'p13b');
  assert.deepEqual((await thirteen.next()).value, { event: 'presence', data: { room: 'seats/showing-13/B4', peer: 'p13b', state: { here: true } } });
  await push(sync, [change('seats', 'showing-12/C1', 'after')]);
  const next = (await twelve.next()).value;
  assert.equal(next.event, 'changes', "showing 12's page got no presence from 13; its next event is its own change");
  assert.deepEqual(values(next.data), ['after']);
  await twelve.return();
  await thirteen.return();
  sync.close();
});

  test(`${backend.name}: a scope that isn’t one is refused`, async () => {
  const sync = await backend.start();
  for (const bad of ['[1]', '{"seats":5}', '{"seats":[1]}', 'not json', 'null']) {
    const response = await sync.fetch(new Request(`http://shop/_zb/sync/pull?since=0&scope=${encodeURIComponent(bad)}`));
    assert.equal(response.status, bad === 'null' ? 200 : 400, bad);
  }
  const tooLong = '{"a":"' + 'x'.repeat(201) + '"}';
  assert.equal((await sync.fetch(new Request(`http://shop/_zb/sync/pull?since=0&scope=${encodeURIComponent(tooLong)}`))).status, 400);
  const live = await sync.fetch(new Request(`http://shop/_zb/sync/live?since=0&peer=p&scope=${encodeURIComponent('[1]')}`));
  assert.equal(live.status, 400, 'the live stream too');
  sync.close();
});

}

test("the server's scope: two businesses on one log, each seeing and writing only its own", { timeout: 5000 }, async () => {
  const business = (request) => request.headers.get('x-business');
  const sync = createSyncServer({ scope: ({ request }) => ({ seats: `${business(request)}/`, brands: [`${business(request)}`] }) });
  const garrett = { 'x-business': 'garrett-8' };
  const cumberland = { 'x-business': 'cumberland' };
  assert.equal((await push(sync, [change('seats', 'garrett-8/s12/A1', 'g')], garrett)).status, 200);
  assert.equal((await push(sync, [change('seats', 'cumberland/s1/A1', 'c')], cumberland)).status, 200);
  assert.equal((await push(sync, [change('seats', 'cumberland/s1/A2', 'sneaky')], garrett)).status, 403, 'a write outside its scope');
  assert.equal((await join(sync, 'seats/cumberland/s1/A1', 'spy', garrett)).status, 403, 'a join outside its scope');
  assert.deepEqual(values(await pull(sync, undefined, garrett)), ['g']);
  assert.deepEqual(values(await pull(sync, undefined, cumberland)), ['c']);
  // The page's scope narrows the server's; it can't widen it.
  assert.deepEqual(values(await pull(sync, { seats: 'cumberland/' }, garrett)), []);
  assert.deepEqual(values(await pull(sync, { seats: true }, garrett)), ['g']);
  const stream = await live(sync, 'g1', undefined, garrett);
  assert.deepEqual(values((await stream.next()).value.data), ['g']);
  await push(sync, [change('seats', 'cumberland/s1/B1', 'c2')], cumberland);
  await push(sync, [change('seats', 'garrett-8/s12/B1', 'g2')], garrett);
  const got = [];
  while (!got.includes('g2')) got.push(...values((await stream.next()).value.data));
  assert.deepEqual(got, ['g2'], "Garrett's page never saw Cumberland's change (an empty batch, at most)");
  await stream.return();
});

test('inScope: true, a prefix, a list, and a collection not named', () => {
  assert.equal(inScope(null, 'any', 'thing'), true);
  assert.equal(inScope({ seats: true }, 'seats', 'x'), true);
  assert.equal(inScope({ seats: '' }, 'seats', 'x'), true, 'an empty prefix is every key');
  assert.equal(inScope({ seats: 'a/' }, 'seats', 'a/b'), true);
  assert.equal(inScope({ seats: 'a/' }, 'seats', 'ab'), false);
  assert.equal(inScope({ seats: ['x', 'a/'] }, 'seats', 'a/1'), true);
  assert.equal(inScope({ seats: true }, 'holds', 'x'), false);
  assert.equal(inScope({ seats: true }, 'constructor', 'x'), false, "only the scope's own collections");
  assert.equal(inScope({ seats: true }, 'toString', 'x'), false);
});
