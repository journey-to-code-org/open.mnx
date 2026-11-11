// A sync log that survives a restart: SQLite, through the runtime's own (Node's `node:sqlite`,
// Bun's `bun:sqlite`), so there's nothing to install.
//
//   import { createSyncServer } from '@zubra/sync/server';
//   import { sqliteLog } from '@zubra/sync/sqlite';
//   const sync = createSyncServer({ log: await sqliteLog('sync.db') });
//
// `keep: 'latest'` keeps each field's latest value only, so the log doesn't grow with every
// change and a new device reads what's there now (see sql-log.js). By default it keeps every
// change, in a table `changes` that the zubra-sync binary reads too.
import { sqlLog } from './sql-log.js';

export async function sqliteLog(path = ':memory:', { keep = 'all' } = {}) {
  const db = await open(path);
  const statements = new Map();
  const statement = (sql) => statements.get(sql) ?? statements.set(sql, db.prepare(sql)).get(sql);
  const log = sqlLog(
    {
      exec: (sql) => db.exec(sql),
      run: (sql, ...args) => statement(sql).run(...args),
      all: (sql, ...args) => statement(sql).all(...args),
      transaction(fn) {
        db.exec('BEGIN');
        try {
          const result = fn();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
    { keep, label: 'sqliteLog' },
  );
  return { ...log, close: () => db.close() };
}

async function open(path) {
  if (typeof globalThis.Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite');
    return new Database(path);
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path);
}
