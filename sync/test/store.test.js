// The sync server as a synchronous store (store-contract.js), on each log and inside a Durable
// Object. What a library of server-side rules needs: reads with no await, and a write that's in
// the documents before it returns.
import { test } from 'node:test';
import { createSyncServer, memoryLog, allowAnyone } from '../src/server.js';
import { sqliteLog } from '../src/sqlite.js';
import { syncStub } from '../src/durable-stub.js';
import { namespace } from './durable-harness.js';
import { checkStore, oneWinner, storeOver } from './store-contract.js';

const logs = {
  memoryLog: async () => ({ log: memoryLog() }),
  "memoryLog({ keep: 'latest' })": async () => ({ log: memoryLog({ keep: 'latest' }) }),
  sqliteLog: async () => {
    const log = await sqliteLog();
    return { log, done: () => log.close() };
  },
  "sqliteLog(…, { keep: 'latest' })": async () => {
    const log = await sqliteLog(':memory:', { keep: 'latest' });
    return { log, done: () => log.close() };
  },
};

for (const [name, make] of Object.entries(logs)) {
  test(`${name}: documents() and write() keep a synchronous store's contract`, async () => {
    const { log, done } = await make();
    try {
      const sync = createSyncServer({ authorize: allowAnyone, log });
      const store = storeOver(await sync.documents(), sync.write);
      await checkStore(store);
      await oneWinner(store);
    } finally {
      await done?.();
    }
  });
}

test('inside a Durable Object, the same store keeps the contract, after an eviction too', async () => {
  const ns = namespace();
  const sync = syncStub(ns);
  await sync.stub.checkStore();
  ns.evict();
  await sync.stub.oneWinner();
});
