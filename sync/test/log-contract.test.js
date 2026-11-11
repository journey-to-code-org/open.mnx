// Every log Sync ships keeps the same promises (log-contract.js).
import { test } from 'node:test';
import { memoryLog } from '../src/server.js';
import { sqliteLog } from '../src/sqlite.js';
import { durableObjectLog } from '../src/durable-log.js';
import { durableStorage } from './durable-storage.js';
import { logContract } from './log-contract.js';

const logs = {
  memoryLog: { transactional: false, make: async () => ({ log: memoryLog(), done() {} }) },
  sqliteLog: { transactional: true, make: async () => { const log = await sqliteLog(); return { log, done: () => log.close() }; } },
  durableObjectLog: { transactional: true, make: async () => { const storage = durableStorage(); return { log: durableObjectLog(storage), done: () => storage.close() }; } },
};

for (const [name, { transactional, make }] of Object.entries(logs)) {
  for (const contract of logContract) {
    test(`${name}: ${contract.name}`, { skip: contract.transactional && !transactional && 'not transactional' }, async () => {
      const { log, done } = await make();
      try {
        await contract.run(log);
      } finally {
        done();
      }
    });
  }
}
