// The server taking part, two ways: the sync server in this process, and a Durable Object
// through the Worker's stub (on Node; the edge example runs the object in workerd).
import { test } from 'node:test';
import { createSyncServer, memoryLog } from '../src/server.js';
import { syncStub } from '../src/durable-stub.js';
import { namespace } from './durable-harness.js';
import { documentsContract } from './documents-contract.js';

const request = (path, init) => new Request(`http://shop/_zb/sync${path}`, init);
const pushRequest = (changes) => request('/push', { method: 'POST', body: JSON.stringify({ changes }), headers: { 'content-type': 'application/json' } });

const harnesses = {
  'createSyncServer': () => {
    const log = memoryLog();
    let sync = createSyncServer({ log });
    return {
      push: (changes) => sync.fetch(pushRequest(changes)),
      pull: async (since = 0) => (await sync.fetch(request(`/pull?since=${since}`))).json(),
      live: (peer) => sync.fetch(request(`/live?since=0&peer=${peer}`)),
      documents: () => sync.documents(),
      write: (...args) => sync.write(...args),
      restart: async () => { sync = createSyncServer({ log }); },
    };
  },
  'a SyncObject, through syncStub': () => {
    const ns = namespace();
    const sync = syncStub(ns);
    return {
      push: (changes) => sync.fetch(pushRequest(changes)),
      pull: async (since = 0) => (await sync.fetch(request(`/pull?since=${since}`))).json(),
      live: (peer) => sync.fetch(request(`/live?since=0&peer=${peer}`)),
      documents: (...collections) => sync.documents(...collections),
      write: (...args) => sync.write(...args),
      restart: async () => ns.evict(),
    };
  },
};

for (const [name, make] of Object.entries(harnesses)) {
  for (const contract of documentsContract) {
    test(`${name}: ${contract.name}`, { timeout: 5000 }, () => contract.run(make()));
  }
}
