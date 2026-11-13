// What the server taking part promises (documents() and write()), however it's reached: the
// sync server in this process, or a Durable Object through the Worker's stub. Each case gets a
// harness: push(changes), pull(since), live(peer), documents(...collections) (as they are now),
// write(collection, key, fields), and restart() (a new server or object on the same log).
import assert from 'node:assert/strict';

const change = (field, value, clock, key = 'o1') => ({ collection: 'orders', key, field, value, clock });
/** A device whose clock runs 30 s ahead of the server's: inside maxSkew, so its changes are taken. */
const AHEAD = `${String(Date.now() + 30_000).padStart(15, '0')}-00003-fast`;

async function* events(response) {
  const reader = response.body.getReader();
  let text = '';
  for (;;) {
    let at;
    while ((at = text.indexOf('\n\n')) < 0) text += new TextDecoder().decode((await reader.read()).value);
    const block = text.slice(0, at);
    text = text.slice(at + 2);
    const event = /^event: (\w+)/m.exec(block)?.[1];
    if (event) yield { event, data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) };
    if (event === undefined && block.startsWith(':')) continue;
  }
}

export const documentsContract = [
  ['documents are what the devices merge: the latest clock per field wins', async (h) => {
    await h.push([change('status', 'placed', '000000000000002-00000-dev1'), change('qty', 2, '000000000000002-00001-dev1')]);
    await h.push([change('status', 'stale', '000000000000001-00000-dev2')]);
    assert.deepEqual((await h.documents()).get('orders', 'o1'), { status: 'placed', qty: 2 });
    await h.push([change('qty', 3, '000000000000009-00000-dev2')]);
    assert.deepEqual((await h.documents()).get('orders', 'o1'), { status: 'placed', qty: 3 });
    assert.deepEqual((await h.documents()).all('orders'), [{ key: 'o1', status: 'placed', qty: 3 }]);
    assert.equal((await h.documents()).get('orders', 'nope'), undefined);
  }],
  ['all() takes a key prefix: the documents under it, in the order they were first written to', async (h) => {
    await h.write('seats', 'show-12/B4', { state: 'held' });
    await h.write('seats', 'show-13/A1', { state: 'free' });
    await h.write('seats', 'show-12/A2', { state: 'taken' });
    const docs = await h.documents();
    assert.deepEqual(docs.all('seats', 'show-12/'), [{ key: 'show-12/B4', state: 'held' }, { key: 'show-12/A2', state: 'taken' }]);
    assert.deepEqual(docs.all('seats', 'show-14/'), []);
    assert.equal(docs.all('seats').length, 3);
    assert.equal(docs.all('seats', '').length, 3);
  }],
  ["the server's write comes after a device clock that runs ahead, reaches a live page, and is logged", async (h) => {
    await h.push([change('status', 'placed', AHEAD)]);
    const stream = events(await h.live('p1'));
    await stream.next(); // the backlog
    const written = await h.write('orders', 'o1', { status: 'claimed', driver: 'jules' });
    assert.ok(written.every((c) => c.clock > AHEAD), written[0].clock);
    const next = (await stream.next()).value;
    assert.deepEqual(next.data.changes.map((c) => [c.field, c.value]), [['status', 'claimed'], ['driver', 'jules']]);
    await stream.return();
    assert.deepEqual((await h.documents()).get('orders', 'o1'), { status: 'claimed', driver: 'jules' });
    // The log has all three, or (keeping each field's latest) the two that stand.
    assert.deepEqual((await h.pull()).changes.map((c) => c.value), h.latest ? ['claimed', 'jules'] : ['placed', 'claimed', 'jules']);
  }],
  ['write refuses what isn’t fields', async (h) => {
    await assert.rejects(() => h.write('orders', 'o1', { $clocks: {} }), /can't be a field name/);
    await assert.rejects(() => h.write('orders', 'o1', { key: 'o2' }), /`key` can't be a field name/);
    await assert.rejects(() => h.write('orders', 'o1', null), /sync\.write/);
  }],
  ['documents are built from a log that already has changes', async (h) => {
    for (let i = 0; i < 7; i++) await h.push([change('n', i, `00000000000001${i}-00000-dev1`)]);
    assert.equal((await h.documents()).get('orders', 'o1').n, 6);
  }],
  ['after a restart, the documents come back and a write comes after every clock in the log', async (h) => {
    await h.push([change('status', 'placed', AHEAD)]);
    await h.write('orders', 'o2', { status: 'placed' });
    await h.restart();
    const [written] = await h.write('orders', 'o1', { status: 'claimed' }); // before any documents()
    assert.ok(written.clock > AHEAD, written.clock);
    assert.deepEqual((await h.documents()).get('orders', 'o1'), { status: 'claimed' });
    assert.deepEqual((await h.documents()).get('orders', 'o2'), { status: 'placed' });
  }],
  ['what a reader changes is its own', async (h) => {
    await h.write('orders', 'o1', { items: [{ sku: 'eggs', qty: 1 }] });
    const docs = await h.documents();
    docs.get('orders', 'o1').items[0].qty = 99;
    docs.all('orders')[0].items[0].qty = 98;
    assert.equal((await h.documents()).get('orders', 'o1').items[0].qty, 1);
  }],
].map(([name, run]) => ({ name, run }));
