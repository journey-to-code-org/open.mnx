// A sync log in SQL, over any SQLite: Node's and Bun's (sqliteLog) and a Durable Object's
// (durableObjectLog) hand it the same three calls. Two ways to keep it:
//
// - `keep: 'all'` (the default): every change, in the order it came. A table `changes`, cursor =
//   row id. What `sqliteLog()` has always written; the zubra-sync binary reads the same table.
// - `keep: 'latest'`: each field's latest value only. A table `latest`, one row per field: a
//   change with a newer clock replaces the row and takes the next cursor, an older one is dropped.
//   `after(cursor)` hands out each field's latest value once, so a new device reads what's there
//   now, not the whole evening's history. Opening it over a database that has a `changes` table
//   and no `latest` one carries each field's latest value across, numbered after the old log's
//   last cursor, so a device that had read the old log reads the carried values again and misses
//   nothing.
//
// `db` is `{ exec(sql), run(sql, ...args), all(sql, ...args), transaction(fn) }`.
const NAME = /^[A-Za-z_][\w]{0,62}$/;

export function sqlLog(db, { keep = 'all', table, from = 'changes', label = 'log' } = {}) {
  if (keep !== 'all' && keep !== 'latest') throw new TypeError(`${label}: \`keep\` is 'all' or 'latest'`);
  table ??= keep === 'all' ? 'changes' : 'latest';
  for (const name of [table, from]) if (!NAME.test(name)) throw new TypeError(`${label}: a table is a plain SQL name (letters, digits, _)`);
  const json = (value) => JSON.stringify(value ?? null);
  const read = (rows) => rows.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value: JSON.parse(value), clock }));
  const last = () => Number(db.all(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${table}`)[0].seq);

  if (keep === 'all') {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      key TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT,
      clock TEXT NOT NULL
    )`);
  } else {
    const exists = (name) => db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;
    const fresh = !exists(table);
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      collection TEXT NOT NULL,
      key TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT,
      clock TEXT NOT NULL,
      seq INTEGER NOT NULL UNIQUE,
      PRIMARY KEY (collection, key, field)
    )`);
    if (fresh && from !== table && exists(from)) {
      // Each field's latest change (the later clock; the later row if two share one), in log
      // order, numbered after the old log's last cursor.
      db.transaction(() =>
        db.run(`INSERT INTO ${table} (collection, key, field, value, clock, seq)
          SELECT collection, key, field, value, clock,
                 (SELECT COALESCE(MAX(seq), 0) FROM ${from}) + ROW_NUMBER() OVER (ORDER BY seq)
          FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY collection, key, field ORDER BY clock DESC, seq DESC) AS rank FROM ${from})
          WHERE rank = 1`),
      );
    }
  }

  return {
    async append(changes) {
      return db.transaction(() => {
        for (const { collection, key, field, value, clock } of changes) {
          if (keep === 'all') {
            db.run(`INSERT INTO ${table} (collection, key, field, value, clock) VALUES (?, ?, ?, ?, ?)`, collection, key, field, json(value), clock);
          } else {
            // A newer clock takes the row and the next cursor; an older or equal one changes nothing.
            db.run(
              `INSERT INTO ${table} (collection, key, field, value, clock, seq) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${table}))
               ON CONFLICT (collection, key, field) DO UPDATE SET value = excluded.value, clock = excluded.clock, seq = excluded.seq
               WHERE excluded.clock > ${table}.clock`,
              collection, key, field, json(value), clock,
            );
          }
        }
        return last();
      });
    },
    async after(cursor, limit = 1000) {
      const from = Number(cursor) || 0;
      const rows = db.all(`SELECT seq, collection, key, field, value, clock FROM ${table} WHERE seq > ? ORDER BY seq LIMIT ?`, from, limit);
      return { changes: read(rows), cursor: rows.length ? Number(rows[rows.length - 1].seq) : from };
    },
  };
}
