import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer, memoryLog, allowAnyone } from '../src/server.js';
import { backends } from './backends.js';

const change = (field, value, clock = '000000000000001-00000-dev1') => ({ collection: 'tasks', key: 't1', field, value, clock });
const push = (sync, changes, headers = {}) =>
  sync.fetch(new Request('http://localhost/_zb/sync/push', { method: 'POST', body: JSON.stringify({ changes }), headers: { 'content-type': 'application/json', ...headers } }));
const pull = async (sync, since = 0) => (await sync.fetch(new Request(`http://localhost/_zb/sync/pull?since=${since}`))).json();

for (const backend of backends) {
test(`${backend.name}: changes come back out in order, after a cursor`, async () => {
  const sync = await backend.start();
  assert.equal((await push(sync, [change('title', 'a'), change('done', true)])).status, 200);
  assert.equal((await push(sync, [change('title', 'b', '000000000000002-00000-dev2')])).status, 200);
  const all = await pull(sync);
  assert.deepEqual(all.changes.map((c) => c.value), ['a', true, 'b']);
  assert.equal(all.cursor, 3);
  assert.deepEqual((await pull(sync, 2)).changes.map((c) => c.value), ['b']);
  sync.close();
});

test(`${backend.name}: malformed changes, cross-site writes and other paths are refused`, async () => {
  const sync = await backend.start();
  assert.equal((await push(sync, [{ collection: 'tasks' }])).status, 400);
  assert.equal((await push(sync, [change('$clocks', {})])).status, 400);
  assert.equal((await push(sync, [change('title', 'x')], { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).status, 403);
  assert.equal((await sync.fetch(new Request('http://localhost/_zb/sync/nope'))).status, 404);
  assert.deepEqual((await pull(sync)).changes, []);
  sync.close();
});
}

test('requests outside the mount are not the JavaScript server\'s', async () => {
  assert.equal(await createSyncServer({ authorize: allowAnyone }).fetch(new Request('http://localhost/elsewhere')), null);
});

test('authorize() decides who writes and who sees what', async () => {
  const sync = createSyncServer({ authorize: ({ request, key, write }) => (write ? request.headers.get('x-user') === 'ada' : key !== 'secret') });
  assert.equal((await push(sync, [change('title', 'x')])).status, 403);
  assert.equal((await push(sync, [change('title', 'x')], { 'x-user': 'ada' })).status, 200);
  assert.equal((await push(sync, [{ ...change('title', 'y'), key: 'secret' }], { 'x-user': 'ada' })).status, 200);
  assert.deepEqual((await pull(sync)).changes.map((c) => c.key), ['t1']);
});

/** Read server-sent events from a live response, as `{ event, data }`. */
async function* events(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event) yield { event, data: JSON.parse(data) };
    }
  }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
const live = (sync, peer, since = 0, signal) => sync.fetch(new Request(`http://localhost/_zb/sync/live?since=${since}&peer=${peer}`, { signal }));
const say = (sync, message, headers = {}) => sync.fetch(new Request('http://localhost/_zb/sync/presence', { method: 'POST', body: JSON.stringify(message), headers: { 'content-type': 'application/json', ...headers } }));

for (const backend of backends) {
test(`${backend.name}: live: the backlog, then each push as it happens`, { timeout: 5000 }, async () => {
  const sync = await backend.start();
  await push(sync, [change('title', 'before')]);
  const stream = events(await live(sync, 'p1'));
  assert.deepEqual((await stream.next()).value.data.changes.map((c) => c.value), ['before']);
  await push(sync, [change('title', 'after', '000000000000002-00000-dev2')]);
  const next = (await stream.next()).value;
  assert.equal(next.event, 'changes');
  assert.deepEqual(next.data.changes.map((c) => c.value), ['after']);
  assert.equal(next.data.cursor, 2);
  await stream.return();
  sync.close();
});

test(`${backend.name}: presence: reaches the other viewers, not the sender; a dropped connection leaves`, { timeout: 5000 }, async () => {
  const sync = await backend.start();
  const leaving = new AbortController();
  const theirs = await live(sync, 'p1', 0, leaving.signal);
  const mine = events(await live(sync, 'p2'));
  await mine.next(); // the (empty) backlog
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'p1', state: { cursor: { x: 1 } } })).status, 200);
  assert.deepEqual((await mine.next()).value, { event: 'presence', data: { room: 'boards/b1', peer: 'p1', state: { cursor: { x: 1 } } } });
  // p1's connection drops (a crash, no goodbye): the others hear that it left.
  leaving.abort();
  await theirs.body.cancel().catch(() => {});
  assert.deepEqual((await mine.next()).value, { event: 'presence', data: { room: 'boards/b1', peer: 'p1', state: null } });
  await mine.return();
  sync.close();
});

test(`${backend.name}: signaling reaches only the peer it's for`, { timeout: 5000 }, async () => {
  const sync = await backend.start();
  const send = (message, headers = {}) =>
    sync.fetch(new Request('http://localhost/_zb/sync/signal', { method: 'POST', body: JSON.stringify(message), headers: { 'content-type': 'application/json', ...headers } }));
  const target = events(await live(sync, 'p2'));
  const bystander = events(await live(sync, 'p3'));
  await target.next();
  await bystander.next();
  const offer = { room: 'boards/b1', from: 'p1', to: 'p2', data: { description: { type: 'offer', sdp: 'v=0' } } };
  assert.equal((await send(offer)).status, 200);
  assert.deepEqual((await target.next()).value, { event: 'signal', data: offer });
  assert.equal((await send({ ...offer, to: 'p3' })).status, 200);
  assert.deepEqual((await bystander.next()).value.data.to, 'p3'); // p3's first event is its own, not p2's
  assert.equal((await send({ ...offer, data: 'not an object' })).status, 400);
  assert.equal((await send({ ...offer, to: 'bad peer!' })).status, 400);
  assert.equal((await send(offer, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403);
  await target.return();
  await bystander.return();
  sync.close();
});

test(`${backend.name}: presence: malformed messages are refused`, async () => {
  const sync = await backend.start();
  assert.equal((await say(sync, { room: 'nocollection', peer: 'p1', state: {} })).status, 400);
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'bad peer!', state: {} })).status, 400);
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'p1', state: [1] })).status, 400);
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'p1', state: { big: 'x'.repeat(5000) } })).status, 400);
  assert.equal((await say(sync, { room: 'boards/b1', peer: 'p1', state: {} }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403);
  sync.close();
});
}

test('presence: rooms you may not join are refused (authorize)', async () => {
  const sync = createSyncServer({ authorize: ({ key }) => key !== 'private' });
  assert.equal((await say(sync, { room: 'boards/private', peer: 'p1', state: {} })).status, 403);
});

// ---- the server taking part: authorize's kind, documents(), write() ------------------------

test('authorize() is told what kind of request it is, at every place it is asked', { timeout: 5000 }, async () => {
  let seen = [];
  const sync = createSyncServer({
    authorize: ({ kind, write, collection }) => {
      seen.push(`${kind}:${write}`);
      // Orders are the server's to write, but anyone may be in an order's room.
      return !(collection === 'orders' && kind === 'change');
    },
  });
  const step = async (what) => {
    seen = [];
    await what();
    return seen;
  };
  // A refused push: asked once, as a change.
  assert.deepEqual(await step(async () => assert.equal((await push(sync, [{ ...change('status', 'delivered'), collection: 'orders' }])).status, 403)), ['change:true']);
  // An accepted push with nobody listening: a change, and no reads.
  assert.deepEqual(await step(() => push(sync, [change('title', 'x')])), ['change:true']);
  // A live page's backlog: each change it would be sent is a read.
  let stream;
  assert.deepEqual(await step(async () => { stream = events(await live(sync, 'p1')); await stream.next(); }), ['read:false']);
  // A push with that page listening: the change, then a read for the page it's sent to.
  assert.deepEqual(await step(async () => { await push(sync, [change('title', 'y', '000000000000002-00000-dev1')]); await stream.next(); }), ['change:true', 'read:false']);
  // Joining a room: presence, then a read for the other page it's shown to.
  assert.deepEqual(await step(async () => { assert.equal((await say(sync, { room: 'orders/o1', peer: 'p2', state: { looking: 'driver' } })).status, 200); await stream.next(); }), ['presence:true', 'read:false']);
  // A pull: a read per change.
  assert.deepEqual(await step(() => pull(sync)), ['read:false', 'read:false']);
  await stream.return();
});

test('documents(): every document as the devices merge it, from the log and kept current', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  await push(sync, [change('title', 'first'), change('done', false)]);
  await push(sync, [change('title', 'stale', '000000000000000-00000-old')]); // earlier clock: loses
  const docs = await sync.documents();
  assert.deepEqual(docs.get('tasks', 't1'), { title: 'first', done: false });
  await push(sync, [change('done', true, '000000000000009-00000-dev2')]);
  assert.deepEqual(docs.get('tasks', 't1'), { title: 'first', done: true }, 'kept current');
  assert.deepEqual(docs.all('tasks'), [{ key: 't1', title: 'first', done: true }]);
  assert.equal(docs.get('tasks', 'nope'), undefined);
  // A copy: changing what it returns changes nothing.
  docs.get('tasks', 't1').title = 'mutated';
  assert.equal(docs.get('tasks', 't1').title, 'first');
});

test('write(): the server writes to the log and to every live page, and wins over what came before', { timeout: 5000 }, async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  // A device whose clock runs ahead: the server's next write still comes after it.
  await push(sync, [{ ...change('status', 'placed', '999999999999999-00003-fast'), collection: 'orders', key: 'o1' }]);
  const stream = events(await live(sync, 'p1'));
  await stream.next(); // the backlog
  const written = await sync.write('orders', 'o1', { status: 'claimed', driver: 'jules' });
  assert.equal(written.length, 2);
  assert.ok(written.every((c) => c.clock > '999999999999999-00003-fast' && c.clock.endsWith('-server')), written[0].clock);
  const next = (await stream.next()).value;
  assert.equal(next.event, 'changes');
  assert.deepEqual(next.data.changes.map((c) => [c.field, c.value]), [['status', 'claimed'], ['driver', 'jules']]);
  assert.deepEqual((await sync.documents()).get('orders', 'o1'), { status: 'claimed', driver: 'jules' });
  assert.deepEqual((await pull(sync)).changes.map((c) => c.value), ['placed', 'claimed', 'jules']);
  await stream.return();
  await assert.rejects(() => sync.write('orders', 'o1', { $clocks: {} }), /not a field/);
  await assert.rejects(() => sync.write('orders', 'o1', null), /sync\.write/);
});

test('documents() and write(): a check and a write with no await between can\'t be interleaved', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  await sync.write('stock', 'squash', { qty: 1 });
  const docs = await sync.documents();
  // Two requests for the last one, at once: each checks, then writes.
  const order = async () => {
    await Promise.resolve(); // whatever came before (parsing the request, …)
    const left = docs.get('stock', 'squash')?.qty ?? 0;
    if (left < 1) return 'sold out';
    const done = sync.write('stock', 'squash', { qty: left - 1 });
    await done;
    return 'ordered';
  };
  assert.deepEqual((await Promise.all([order(), order()])).sort(), ['ordered', 'sold out']);
  assert.equal(docs.get('stock', 'squash').qty, 0);
});

test('documents() is built from a log that already has changes, once, however many ask', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  for (let i = 0; i < 7; i++) await push(sync, [change('n', i, `00000000000001${i}-00000-dev1`)]);
  const [a, b] = await Promise.all([sync.documents(), sync.documents()]);
  assert.equal(a, b);
  assert.equal(a.get('tasks', 't1').n, 6);
});

test('the server\'s device name is checked', () => {
  assert.throws(() => createSyncServer({ authorize: allowAnyone, device: 'has space' }), /device/);
});

test('a change that comes in while documents() is first reading the log is in them', async () => {
  // A log whose reads and appends finish when the test says: each read sees the log as it was
  // when it was asked, so a push can land between the build's last read and its end.
  const log = memoryLog();
  const held = [];
  const hold = () => new Promise((release) => held.push(release));
  const gated = {
    async append(changes) { await hold(); return log.append(changes); },
    async after(...args) { const page = await log.after(...args); await hold(); return page; },
  };
  const waitFor = async (n) => { while (held.length < n) await new Promise((r) => setTimeout(r, 1)); };
  await log.append([change('title', 'before')]);
  const sync = createSyncServer({ authorize: allowAnyone, log: gated });
  const building = sync.documents();
  await waitFor(1);
  held.shift()(); // the build's first page: 'before'
  await waitFor(1); // its second read is taken (nothing new yet) and held
  const pushed = push(sync, [{ ...change('title', 'pushed', '000000000000005-00000-dev1'), key: 't2' }]);
  await waitFor(2);
  held.splice(1, 1)[0](); // the push is logged and recorded while the build still holds its last read…
  assert.equal((await pushed).status, 200);
  held.shift()(); // …which then comes back with nothing new, and the build ends
  const docs = await building;
  assert.deepEqual(docs.get('tasks', 't1'), { title: 'before' });
  assert.deepEqual(docs.get('tasks', 't2'), { title: 'pushed' }, 'the push that landed during the build');
});

test("a server that starts on a log writes after every clock in it, without documents() first", async () => {
  const log = memoryLog();
  await log.append([{ ...change('status', 'placed', '999999999999999-00003-fast'), collection: 'orders', key: 'o1' }]);
  // A restart (or an evicted Durable Object): a new server on the same log.
  const sync = createSyncServer({ authorize: allowAnyone, log });
  const [written] = await sync.write('orders', 'o1', { status: 'claimed' });
  assert.ok(written.clock > '999999999999999-00003-fast', written.clock);
  assert.deepEqual((await sync.documents()).get('orders', 'o1'), { status: 'claimed' });
});

test('one append that fails fails only its own push; the next ones are logged', async () => {
  const log = memoryLog();
  let fail = true;
  const flaky = { append: async (changes) => { if (fail) { fail = false; throw new Error('disk full'); } return log.append(changes); }, after: (...args) => log.after(...args) };
  const sync = createSyncServer({ authorize: allowAnyone, log: flaky });
  await assert.rejects(push(sync, [change('title', 'lost')]), /disk full/);
  assert.equal((await push(sync, [change('title', 'kept', '000000000000002-00000-dev1')])).status, 200);
  await sync.write('tasks', 't9', { title: 'also kept' });
  assert.deepEqual((await pull(sync)).changes.map((c) => c.value), ['kept', 'also kept']);
});

test("what the log refuses isn't in the documents: a failed push, and a failed write taken back", async () => {
  const log = memoryLog();
  let fail = 0;
  const flaky = { append: async (changes) => { if (fail) { fail--; throw new Error('disk full'); } return log.append(changes); }, after: (...args) => log.after(...args) };
  const sync = createSyncServer({ authorize: allowAnyone, log: flaky });
  await sync.write('stock', 'eggs', { qty: 3, price: 450 });
  const docs = await sync.documents();
  fail = 1;
  await assert.rejects(push(sync, [{ ...change('qty', 99, '999999999999990-00000-dev1'), collection: 'stock', key: 'eggs' }]), /disk full/);
  assert.equal(docs.get('stock', 'eggs').qty, 3, 'a push the log refused');
  fail = 1;
  await assert.rejects(sync.write('stock', 'eggs', { qty: 2 }), /disk full/);
  assert.deepEqual(docs.get('stock', 'eggs'), { qty: 3, price: 450 }, 'a write the log refused, taken back');
  fail = 1;
  await assert.rejects(sync.write('stock', 'beans', { qty: 1 }));
  assert.equal(docs.get('stock', 'beans'), undefined, 'a new document taken back entirely');
  await sync.write('stock', 'eggs', { qty: 2 });
  assert.equal(docs.get('stock', 'eggs').qty, 2);
});
