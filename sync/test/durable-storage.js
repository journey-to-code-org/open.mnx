// A stand-in for a Durable Object's `ctx.storage` on Node: `sql.exec(query, ...bindings)` with a
// cursor (`toArray()`, `one()`) and `transactionSync(fn)`, over node:sqlite, so the log's SQL runs
// against a real SQLite here. The edge example runs the same contract on workerd's own storage.
import { DatabaseSync } from 'node:sqlite';

export function durableStorage() {
  const db = new DatabaseSync(':memory:');
  const cursor = (rows) => ({
    toArray: () => rows,
    one() {
      if (rows.length !== 1) throw new Error(`Expected exactly one result from SQL query, but got ${rows.length}.`);
      return rows[0];
    },
  });
  let depth = 0;
  return {
    sql: {
      exec(query, ...bindings) {
        const statement = db.prepare(query);
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return cursor(statement.all(...bindings));
        statement.run(...bindings);
        return cursor([]);
      },
    },
    transactionSync(fn) {
      if (depth) return fn();
      depth++;
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}
