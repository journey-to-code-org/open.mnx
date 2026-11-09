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
//
// Live: `GET <mount>/live?since=<cursor>&peer=<id>` is a server-sent event stream: `changes` as
// they're pushed, and `presence` from the other viewers (POST <mount>/presence). Subscribers are
// this process's; several server processes need a shared log and a pub/sub between them.
//
// On Node, `handle(req, res)` answers sync requests (streaming the live ones) and returns true.
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

export function createSyncServer({ log = memoryLog(), mount = MOUNT, authorize = () => true, origins = [], heartbeat = 15_000 } = {}) {
  const base = mount.replace(/\/$/, '');
  // Live subscribers: { peer, request, send(event, data), rooms }.
  const listeners = new Set();
  const encoder = new TextEncoder();
  const roomOf = (room) => {
    const at = room.indexOf('/');
    return at > 0 ? { collection: room.slice(0, at), key: room.slice(at + 1) } : null;
  };
  async function broadcastChanges(changes, cursor) {
    for (const listener of listeners) {
      const visible = [];
      for (const change of changes) {
        if (await authorize({ request: listener.request, collection: change.collection, key: change.key, write: false })) visible.push(change);
      }
      listener.send('changes', { changes: visible, cursor });
    }
  }
  async function broadcastPresence(message) {
    const { collection, key } = roomOf(message.room);
    for (const listener of listeners) {
      if (listener.peer === message.peer) continue;
      if (await authorize({ request: listener.request, collection, key, write: false })) listener.send('presence', message);
    }
  }
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
      const appended = changes.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value, clock }));
      const cursor = await log.append(appended);
      await broadcastChanges(appended, cursor);
      return json(200, { ok: true });
    }
    if (url.pathname === `${base}/presence` && request.method === 'POST') {
      if (!sameOrigin(request)) return json(403, { error: 'Cross-site writes are refused' });
      let message;
      try {
        message = await request.json();
      } catch {
        return json(400, { error: 'Expected JSON' });
      }
      const room = typeof message?.room === 'string' ? roomOf(message.room) : null;
      const okPeer = typeof message?.peer === 'string' && /^[\w-]{1,40}$/.test(message.peer);
      const okState = message?.state === null || (typeof message?.state === 'object' && !Array.isArray(message.state));
      if (!room || !okPeer || !okState || JSON.stringify(message.state).length > 4096) {
        return json(400, { error: 'Expected { room: "<collection>/<key>", peer, state: {…} | null }' });
      }
      if (!(await authorize({ request, ...room, write: true }))) return json(403, { error: 'Not yours to join' });
      const clean = { room: message.room, peer: message.peer, state: message.state };
      for (const listener of listeners) if (listener.peer === clean.peer) {
        if (clean.state === null) listener.rooms.delete(clean.room);
        else listener.rooms.add(clean.room);
      }
      await broadcastPresence(clean);
      return json(200, { ok: true });
    }
    if (url.pathname === `${base}/live` && request.method === 'GET') {
      const peer = url.searchParams.get('peer') ?? '';
      if (!/^[\w-]{0,40}$/.test(peer)) return json(400, { error: 'Bad peer id' });
      const since = url.searchParams.get('since') ?? '0';
      let listener;
      let timer;
      const stream = new ReadableStream({
        start: async (controller) => {
          const write = (text) => {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              close();
            }
          };
          const close = () => {
            if (!listeners.delete(listener)) return;
            clearInterval(timer);
            // A viewer who disconnects leaves every room they were in.
            for (const room of listener.rooms) broadcastPresence({ room, peer, state: null });
            try { controller.close(); } catch {}
          };
          listener = { peer, request, rooms: new Set(), send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`), close };
          listeners.add(listener);
          request.signal?.addEventListener('abort', close);
          write('retry: 1000\n\n');
          // Read the backlog after subscribing, so nothing pushed in between is missed (a change
          // may come twice; applying one twice changes nothing).
          const backlog = await log.after(since);
          const visible = [];
          for (const change of backlog.changes) {
            if (await authorize({ request, collection: change.collection, key: change.key, write: false })) visible.push(change);
          }
          listener.send('changes', { changes: visible, cursor: backlog.cursor });
          timer = setInterval(() => write(': keep-alive\n\n'), heartbeat);
          timer.unref?.();
        },
        cancel: () => listener?.close(),
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
      });
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

  /** Node's http: answers sync requests (streaming the live ones) and returns true, else false. */
  async function handle(req, res) {
    if (!req.url.startsWith(`${base}/`)) return false;
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const chunks = [];
    if (req.method !== 'GET' && req.method !== 'HEAD') for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((each) => [name, each]) : [[name, value]])),
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      signal: controller.signal,
    });
    const response = await fetch(request);
    if (!response) return false;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.flushHeaders?.();
    if (!response.body) return res.end(), true;
    const reader = response.body.getReader();
    controller.signal.addEventListener('abort', () => reader.cancel().catch(() => {}));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {}
    res.end();
    return true;
  }

  return { fetch, handle };
}
