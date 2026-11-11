// The log that 'use collection' devices share (tier 1). A fetch handler, so it runs on Node
// (through `node(req, res)`), Bun, Deno and workers; the log itself is pluggable, and in memory
// by default. It keeps changes in order and hands them out after a cursor; it doesn't merge:
// every device applies the same last-writer-wins rule to the same changes, so they converge.
//
//   import { createSyncServer } from '@zubra/sync/server';
//   const sync = createSyncServer();
//   const response = await sync.fetch(request);   // a Response, or null if not ours
//
// `authorize({ request, collection, key, write, kind })` may refuse a change or hide one (return
// false). `kind` says what's asked: 'read' (a change being sent to this request), 'change' (one
// it pushed) or 'presence' (joining a document's room, or signaling in it: nothing is stored).
// `write` is true for the last two.
//
// The server can take part too. `await sync.documents()` is every document as the devices see
// it (last writer wins, per field), kept current; `sync.write(collection, key, fields)` writes as
// the server, to the log and to every live page:
//
//   const docs = await sync.documents();
//   const left = docs.get('stock', 'eggs')?.qty ?? 0;   // read and write with no await between,
//   if (left > 0) sync.write('stock', 'eggs', { qty: left - 1 });   // and no request interleaves
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

const pad = (number, width) => String(number).padStart(width, '0');

/** The documents a log describes, merged by each field's latest clock, as every device merges them. */
function documentsOf() {
  const docs = new Map();
  const id = (collection, key) => `${collection}\u0000${key}`;
  return {
    apply(change) {
      let doc = docs.get(id(change.collection, change.key));
      if (!doc) docs.set(id(change.collection, change.key), (doc = { collection: change.collection, key: change.key, fields: {}, clocks: {} }));
      const known = doc.clocks[change.field];
      if (known && known >= change.clock) return;
      doc.clocks[change.field] = change.clock;
      doc.fields[change.field] = change.value;
    },
    view: {
      /** A document's fields (a copy), or undefined when nothing has been written to it. */
      get(collection, key) {
        const doc = docs.get(id(collection, key));
        return doc && { ...doc.fields };
      },
      /** Every document in a collection: `[{ key, ...fields }]`. */
      all(collection) {
        return [...docs.values()].filter((doc) => doc.collection === collection).map((doc) => ({ key: doc.key, ...doc.fields }));
      },
    },
  };
}

export function createSyncServer({ log = memoryLog(), mount = MOUNT, authorize = () => true, origins = [], heartbeat = 15_000, device = 'server' } = {}) {
  if (!/^[\w-]{1,40}$/.test(device)) throw new Error('createSyncServer: `device` names the server in its clocks: letters, digits, - and _');
  const base = mount.replace(/\/$/, '');
  // The server's clock: later than any clock it has seen, so its writes win over what came
  // before them (and lose to what devices write after, as any device's would).
  let lastTime = 0;
  let counter = 0;
  const tick = (seen = 0) => {
    const now = Math.max(Date.now(), lastTime, seen);
    counter = now === lastTime ? counter + 1 : 0;
    lastTime = now;
    return `${pad(now, 15)}-${pad(counter, 5)}-${device}`;
  };
  const see = (change) => {
    const time = Number(change.clock.slice(0, 15));
    if (time > lastTime) {
      lastTime = time;
      counter = Number(change.clock.slice(16, 21));
    } else if (time === lastTime) {
      counter = Math.max(counter, Number(change.clock.slice(16, 21)));
    }
  };
  // The documents, built from the log the first time they're asked for, then kept current.
  let docs = null;
  let building = null;
  const record = (changes) => {
    for (const change of changes) {
      see(change);
      docs?.apply(change);
    }
  };
  async function documents() {
    if (docs) return docs.view;
    building ??= (async () => {
      const built = documentsOf();
      for (let cursor = 0; ; ) {
        const page = await log.after(cursor, 5000);
        for (const change of page.changes) {
          see(change);
          built.apply(change);
        }
        if (!page.changes.length || String(page.cursor) === String(cursor)) break;
        cursor = page.cursor;
      }
      // Changes recorded while the log was read are in it already, or arrive through record()
      // from now on; applying one twice changes nothing.
      docs = built;
      return built.view;
    })();
    return building;
  }
  // Appends, one after another, so the log's order is the order they were made in.
  let appending = Promise.resolve();
  const append = (changes) => (appending = appending.then(() => log.append(changes)));
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
        if (await authorize({ request: listener.request, collection: change.collection, key: change.key, write: false, kind: 'read' })) visible.push(change);
      }
      listener.send('changes', { changes: visible, cursor });
    }
  }
  async function broadcastPresence(message) {
    const { collection, key } = roomOf(message.room);
    for (const listener of listeners) {
      if (listener.peer === message.peer) continue;
      if (await authorize({ request: listener.request, collection, key, write: false, kind: 'read' })) listener.send('presence', message);
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
        if (!(await authorize({ request, collection: change.collection, key: change.key, write: true, kind: 'change' }))) return json(403, { error: 'Not yours to change' });
      }
      const appended = changes.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value, clock }));
      record(appended);
      const cursor = await append(appended);
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
      if (!(await authorize({ request, ...room, write: true, kind: 'presence' }))) return json(403, { error: 'Not yours to join' });
      const clean = { room: message.room, peer: message.peer, state: message.state };
      for (const listener of listeners) if (listener.peer === clean.peer) {
        if (clean.state === null) listener.rooms.delete(clean.room);
        else listener.rooms.add(clean.room);
      }
      await broadcastPresence(clean);
      return json(200, { ok: true });
    }
    if (url.pathname === `${base}/signal` && request.method === 'POST') {
      // WebRTC signaling: an offer, answer or ICE candidate for one peer in a room, delivered on
      // that peer's live stream. The server only passes it on.
      if (!sameOrigin(request)) return json(403, { error: 'Cross-site writes are refused' });
      let message;
      try {
        message = await request.json();
      } catch {
        return json(400, { error: 'Expected JSON' });
      }
      const room = typeof message?.room === 'string' ? roomOf(message.room) : null;
      const peerOk = (peer) => typeof peer === 'string' && /^[\w-]{1,40}$/.test(peer);
      const dataOk = message?.data && typeof message.data === 'object' && !Array.isArray(message.data) && JSON.stringify(message.data).length <= 16384;
      if (!room || !peerOk(message.from) || !peerOk(message.to) || !dataOk) {
        return json(400, { error: 'Expected { room, from, to, data: {…} }' });
      }
      if (!(await authorize({ request, ...room, write: true, kind: 'presence' }))) return json(403, { error: 'Not yours to join' });
      const clean = { room: message.room, from: message.from, to: message.to, data: message.data };
      for (const listener of listeners) if (listener.peer === clean.to) listener.send('signal', clean);
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
          // Page by page: a log longer than one page is sent whole before anything live.
          // (One event even when there's nothing, so the client learns the cursor; no empty event
          // after the last full page.)
          let from = since;
          for (let first = true; ; first = false) {
            const backlog = await log.after(from);
            if (!backlog.changes.length && !first) break;
            const visible = [];
            for (const change of backlog.changes) {
              if (await authorize({ request, collection: change.collection, key: change.key, write: false, kind: 'read' })) visible.push(change);
            }
            listener.send('changes', { changes: visible, cursor: backlog.cursor });
            if (!backlog.changes.length || String(backlog.cursor) === String(from)) break;
            from = backlog.cursor;
          }
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
        if (await authorize({ request, collection: change.collection, key: change.key, write: false, kind: 'read' })) visible.push(change);
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

  /**
   * Write `fields` to a document as the server: to the documents view at once (so a check
   * before it, with no await between, can't be interleaved), then to the log and every live
   * page. Resolves to the changes written.
   */
  async function write(collection, key, fields) {
    if (typeof collection !== 'string' || typeof key !== 'string' || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError('sync.write(collection, key, { field: value, … })');
    }
    const changes = Object.entries(fields).map(([field, value]) => {
      if (field === '$clocks') throw new TypeError('sync.write: `$clocks` is not a field');
      return { collection, key, field, value, clock: tick() };
    });
    if (!changes.length) return [];
    record(changes);
    const cursor = await append(changes);
    await broadcastChanges(changes, cursor);
    return changes;
  }

  return { fetch, handle, documents, write };
}
