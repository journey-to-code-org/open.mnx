// The store contract, for each store: in memory always, and MongoDB when MONGODB_URI is set
// (CI runs a MongoDB service).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store/memory.js';

const stores = [['memory', async () => memoryStore()]];
if (process.env.MONGODB_URI) {
  stores.push(['mongodb', async () => {
    const { mongoStore } = await import('../src/store/mongo.js');
    const store = await mongoStore(process.env.MONGODB_URI, { database: 'helpdesk-store-test' });
    await store.reset();
    return store;
  }]);
}

for (const [kind, open] of stores) {
  test(`${kind}: users, filters, search, new tickets, messages and stats`, async () => {
    const store = await open();
    try {
      assert.equal(store.kind, kind);
      assert.equal((await store.listUsers()).length, 5);
      assert.equal((await store.getUser('u-ada')).role, 'agent');
      assert.equal(await store.getUser('nobody'), null);

      const all = await store.listTickets();
      assert.equal(all.length, 12);
      assert.ok(all.every((ticket, i) => i === 0 || all[i - 1].updatedAt >= ticket.updatedAt), 'newest activity first');
      assert.deepEqual((await store.listTickets({ priority: 'urgent' })).map((ticket) => ticket.id).sort(), [1001, 1009, 1011]);
      assert.ok((await store.listTickets({ requester: 'u-lena' })).every((ticket) => ticket.requester === 'u-lena'));
      assert.deepEqual((await store.listTickets({ q: 'SAFARI' })).map((ticket) => ticket.id), [1001], 'search ignores case');
      assert.deepEqual((await store.listTickets({ q: 'Zoë' })).map((ticket) => ticket.id), [1004], 'and finds message bodies');
      assert.deepEqual(await store.listTickets({ q: '.*' }), [], 'and takes the text literally');

      const now = Date.now();
      const id = await store.createTicket({ subject: 'New one', requester: 'u-tom', assignee: null, priority: 'low', status: 'open', createdAt: now, updatedAt: now, dueAt: now + 1, messages: [{ id: 'x1', author: 'u-tom', body: 'Hi', at: now, internal: false }] });
      assert.equal(id, 1013, 'ids are sequential');
      assert.equal(await store.createTicket({ subject: 'Another', requester: 'u-tom', assignee: null, priority: 'low', status: 'open', createdAt: now, updatedAt: now, dueAt: now, messages: [] }), 1014);

      assert.equal(await store.addMessage(id, { id: 'x2', author: 'u-ada', body: 'secret plan', at: now + 5, internal: true }, { status: 'open' }), true);
      const ticket = await store.getTicket(id);
      assert.equal(ticket.messages.length, 2);
      assert.equal(ticket.updatedAt, now + 5);
      assert.deepEqual(await store.listTickets({ q: 'secret plan' }), [], 'internal notes are not searched');

      assert.equal(await store.updateTicket(id, { status: 'solved', assignee: 'u-sam' }), true);
      assert.equal((await store.getTicket(id)).status, 'solved');
      assert.equal(await store.updateTicket(9999, { status: 'solved' }), false);

      const stats = await store.stats(now);
      assert.equal(stats.total, 14);
      assert.equal(stats.byStatus.open + stats.byStatus.pending + stats.byStatus.solved, 14);
      assert.equal(stats.perDay.length, 14);
      assert.equal(stats.perDay.at(-1) >= 2, true, 'today has the two new tickets');
    } finally {
      await store.close();
    }
  });
}
