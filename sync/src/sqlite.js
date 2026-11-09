// A sync log that survives a restart: one SQLite table, through the runtime's own SQLite (Node's
// `node:sqlite`, Bun's `bun:sqlite`), so there's nothing to install.
//
//   import { createSyncServer } from '@zubra/sync/server';
//   import { sqliteLog } from '@zubra/sync/sqlite';
//   const sync = createSyncServer({ log: await sqliteLog('sync.db') });
//
// The cursor is the row id. Rows are only ever appended.
export async function sqliteLog(path = ':memory:') {
  const db = await open(path);
  db.exec(`CREATE TABLE IF NOT EXISTS changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT,
    clock TEXT NOT NULL
  )`);
  const insert = db.prepare('INSERT INTO changes (collection, key, field, value, clock) VALUES (?, ?, ?, ?, ?)');
  const select = db.prepare('SELECT seq, collection, key, field, value, clock FROM changes WHERE seq > ? ORDER BY seq LIMIT ?');
  const last = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes');
  return {
    async append(changes) {
      db.exec('BEGIN');
      try {
        for (const { collection, key, field, value, clock } of changes) {
          insert.run(collection, key, field, JSON.stringify(value ?? null), clock);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return Number(last.get().seq);
    },
    async after(cursor, limit = 1000) {
      const rows = select.all(Number(cursor) || 0, limit);
      const changes = rows.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value: JSON.parse(value), clock }));
      const cursorNow = rows.length ? Number(rows[rows.length - 1].seq) : Number(cursor) || 0;
      return { changes, cursor: cursorNow };
    },
    close: () => db.close(),
  };
}

async function open(path) {
  if (typeof globalThis.Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite');
    return new Database(path);
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path);
}
