// A sync log in a Cloudflare Durable Object's own SQLite (`ctx.storage.sql`): the same table and
// the same cursors as `sqliteLog`, so a log can move between Node and a Durable Object. It runs
// anywhere a Durable Object's storage is passed in; nothing here imports Workers' modules.
//
//   import { createSyncServer } from '@zubra/sync/server';
//   import { durableObjectLog } from '@zubra/sync/durable';
//   const sync = createSyncServer({ log: durableObjectLog(ctx.storage) });
//
// `table` names the table, if the object keeps tables of its own (default `changes`). Appends are
// one transaction (`transactionSync`): a batch is written whole or not at all.
const NAME = /^[A-Za-z_][\w]{0,62}$/;

export function durableObjectLog(storage, { table = 'changes' } = {}) {
  if (!storage?.sql || typeof storage.transactionSync !== 'function') {
    throw new TypeError("durableObjectLog(storage): pass a Durable Object's `ctx.storage` (SQLite-backed)");
  }
  if (!NAME.test(table)) throw new TypeError('durableObjectLog: `table` is a plain SQL name (letters, digits, _)');
  const { sql } = storage;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT,
    clock TEXT NOT NULL
  )`);
  const last = () => Number(sql.exec(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${table}`).one().seq);
  return {
    async append(changes) {
      return storage.transactionSync(() => {
        for (const { collection, key, field, value, clock } of changes) {
          sql.exec(`INSERT INTO ${table} (collection, key, field, value, clock) VALUES (?, ?, ?, ?, ?)`, collection, key, field, JSON.stringify(value ?? null), clock);
        }
        return last();
      });
    },
    async after(cursor, limit = 1000) {
      const from = Number(cursor) || 0;
      const rows = sql.exec(`SELECT seq, collection, key, field, value, clock FROM ${table} WHERE seq > ? ORDER BY seq LIMIT ?`, from, limit).toArray();
      const changes = rows.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value: JSON.parse(value), clock }));
      return { changes, cursor: rows.length ? Number(rows[rows.length - 1].seq) : from };
    },
  };
}
