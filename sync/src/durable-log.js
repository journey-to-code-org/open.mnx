// A sync log in a Cloudflare Durable Object's own SQLite (`ctx.storage.sql`): the same tables and
// cursors as `sqliteLog`, so a log can move between Node and a Durable Object. It runs anywhere a
// Durable Object's storage is passed in; nothing here imports Workers' modules.
//
//   import { createSyncServer } from '@zubra/sync/server';
//   import { durableObjectLog } from '@zubra/sync/durable';
//   const sync = createSyncServer({ log: durableObjectLog(ctx.storage, { keep: 'latest' }) });
//
// `keep: 'latest'` keeps each field's latest value only (see sql-log.js); by default every change
// is kept. `table` names the table, if the object keeps tables of its own (default `changes`, or
// `latest`). Appends are one transaction (`transactionSync`): a batch is written whole or not at all.
import { sqlLog } from './sql-log.js';

export function durableObjectLog(storage, { table, keep = 'all' } = {}) {
  if (!storage?.sql || typeof storage.transactionSync !== 'function') {
    throw new TypeError("durableObjectLog(storage): pass a Durable Object's `ctx.storage` (SQLite-backed)");
  }
  const { sql } = storage;
  return sqlLog(
    {
      exec: (query) => sql.exec(query),
      run: (query, ...args) => sql.exec(query, ...args),
      all: (query, ...args) => sql.exec(query, ...args).toArray(),
      transaction: (fn) => storage.transactionSync(fn),
    },
    { keep, table, label: 'durableObjectLog' },
  );
}
