// The log that 'use collection' devices share (tier 1). A fetch handler, so it runs on Node
// (through `node(req, res)`), Bun, Deno and workers; the log itself is pluggable, and in memory
// by default. It keeps changes in order and hands them out after a cursor; it doesn't merge:
// every device applies the same last-writer-wins rule to the same changes, so they converge.
//
//   import { createSyncServer } from '@zubra/sync/server';
//   const sync = createSyncServer();
//   const response = await sync.fetch(request);   // a Response, or null if not ours
//
// `authorize({ request, collection, key, write })` may refuse a change or hide one (return false).
const MOUNT = '/_zb/sync';

/** A log in memory: `append(changes)` and `after(cursor)`. */
export function memoryLog() {
  const changes = [];
  return {
    async append(more) {
      for (const change of more) changes.push(change);
      return changes.length;
    },
    async after(cursor, limit = 1000) {
      const from = Number(cursor) || 0;
      return { changes: changes.slice(from, from + limit), cursor: Math.min(changes.length, from + limit) };
    },
  };
}

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const valid = (change) =>
  change && typeof change.collection === 'string' && typeof change.key === 'string' && typeof change.field === 'string' &&
  typeof change.clock === 'string' && /^\d{15}-\d{5}-[\w-]+$/.test(change.clock) && change.field !== '$clocks';

export function createSyncServer({ log = memoryLog(), mount = MOUNT, authorize = () => true, origins = [] } = {}) {
  const base = mount.replace(/\/$/, '');
  const sameOrigin = (request) => {
    const site = request.headers.get('sec-fetch-site');
    if (site) return site === 'same-origin' || site === 'none';
    const origin = request.headers.get('origin');
    return !origin || origin === new URL(request.url).origin || origins.includes(origin);
  };

  async function fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `${base}/push` && request.method === 'POST') {
      if (!sameOrigin(request)) return json(403, { error: 'Cross-site writes are refused' });
      let body;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: 'Expected JSON' });
      }
      const changes = Array.isArray(body?.changes) ? body.changes : null;
      if (!changes || !changes.every(valid)) return json(400, { error: 'Expected { changes: [{ collection, key, field, value, clock }] }' });
      for (const change of changes) {
        if (!(await authorize({ request, collection: change.collection, key: change.key, write: true }))) return json(403, { error: 'Not yours to change' });
      }
      await log.append(changes.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value, clock })));
      return json(200, { ok: true });
    }
    if (url.pathname === `${base}/pull` && request.method === 'GET') {
      const { changes, cursor } = await log.after(url.searchParams.get('since') ?? '0');
      const visible = [];
      for (const change of changes) {
        if (await authorize({ request, collection: change.collection, key: change.key, write: false })) visible.push(change);
      }
      return json(200, { changes: visible, cursor });
    }
    if (url.pathname.startsWith(`${base}/`)) return json(404, { error: 'Not found' });
    return null;
  }

  return { fetch };
}
