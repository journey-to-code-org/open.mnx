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
// `write` is true for the last two. A 'change' also has the `field` and `value` it sets, so an
// app can keep fields (or whole collections) for the server alone.
//
// Without `authorize`, pages may read but not write: every push, presence and signal is refused
// with a 403 saying so. Say who may change what, or, for a page everyone may edit (a shared
// board on a trusted network), `createSyncServer({ authorize: allowAnyone })`. The server's own
// `write()` is never asked.
//
// The server can take part too. `await sync.documents()` is every document as the devices see
// it (last writer wins, per field), kept current; `sync.write(collection, key, fields)` writes as
// the server, to the log and to every live page:
//
//   const docs = await sync.documents();
//   const left = docs.get('stock', 'eggs')?.qty ?? 0;   // read and write with no await between,
//   if (left > 0) sync.write('stock', 'eggs', { qty: left - 1 });   // and no request interleaves
//
// Scope: a page asks only for what it shows. `?scope=` on pull and live is JSON, per collection
// `true` or a key prefix (or a list of them): `{ "seats": "showing-12/", "brands": true }`.
// Changes and presence outside it aren't sent. `scope({ request })` imposes one from the server
// (tenancy: each business's keys under its own prefix), which the page's can only narrow; writes
// and joins outside it are refused.
//
// A cursor past the end of the log (the log was replaced, or compacted, or this device's cursor
// is from another log) starts over: pull and live answer from the beginning, with `reset: true`,
// and the device takes the new cursor. Logs that can say where they end have `head()`.
//
// Live: `GET <mount>/live?since=<cursor>&peer=<id>` is a server-sent event stream: `changes` as
// they're pushed, and `presence` from the other viewers (POST <mount>/presence). Subscribers are
// this process's; several server processes need a shared log and a pub/sub between them.
//
// On Node, `handle(req, res)` answers sync requests (streaming the live ones) and returns true.
export const MOUNT = '/_zb/sync';

/**
 * A log in memory: `append(changes)` and `after(cursor)`. `keep: 'latest'` keeps each field's
 * latest value only (a newer clock replaces it and takes the next cursor, an older one is dropped),
 * as `sqliteLog(path, { keep: 'latest' })` does.
 */
export function memoryLog({ keep = 'all' } = {}) {
  if (keep === 'latest') return latestInMemory();
  if (keep !== 'all') throw new TypeError("memoryLog: `keep` is 'all' or 'latest'");
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
    head: async () => changes.length,
  };
}

function latestInMemory() {
  const rows = new Map(); // collection, key, field → { change, seq }
  let seq = 0;
  return {
    async append(more) {
      for (const change of more) {
        const id = JSON.stringify([change.collection, change.key, change.field]);
        const had = rows.get(id);
        if (had && had.change.clock >= change.clock) continue;
        rows.set(id, { change: structuredClone(change), seq: ++seq });
      }
      return seq;
    },
    async after(cursor, limit = 1000) {
      const from = Number(cursor) || 0;
      const page = [...rows.values()].filter((row) => row.seq > from).sort((a, b) => a.seq - b.seq).slice(0, limit);
      return { changes: page.map((row) => structuredClone(row.change)), cursor: page.length ? page[page.length - 1].seq : from };
    },
    head: async () => seq,
  };
}

/**
 * A scope from a request's `?scope=`: `{ collection: true | prefix | [prefixes] }`, or null for
 * everything. Throws on anything else.
 */
export function parseScope(text) {
  if (text === null || text === undefined || text === '') return null;
  let scope;
  try {
    scope = JSON.parse(text);
  } catch {
    throw new TypeError('scope is JSON');
  }
  if (scope === null) return null;
  checkScope(scope);
  return scope;
}

function checkScope(scope) {
  const prefix = (each) => typeof each === 'string' && each.length <= 200;
  const ok =
    scope !== null && typeof scope === 'object' && !Array.isArray(scope) && Object.keys(scope).length <= 100 &&
    Object.values(scope).every((each) => each === true || prefix(each) || (Array.isArray(each) && each.length <= 50 && each.every(prefix)));
  if (!ok) throw new TypeError('scope is { collection: true | "key prefix" | ["prefixes"] }');
}

/** Whether a document is in a scope (null is everything). */
export function inScope(scope, collection, key) {
  if (!scope) return true;
  const rule = scope[collection]; // inherited properties (constructor…) are none of these
  if (rule === true) return true;
  if (typeof rule === 'string') return key.startsWith(rule);
  if (Array.isArray(rule)) return rule.some((prefix) => key.startsWith(prefix));
  return false;
}

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// A clock is `<15-digit ms>-<5-digit counter>-<device>`, so clocks compare as strings.
const CLOCK = /^(\d{15})-(\d{5})-[\w-]+$/;
const clock = {
  format: (time, counter, device) => `${String(time).padStart(15, '0')}-${String(counter).padStart(5, '0')}-${device}`,
  /** `{ time, counter }`, or null when it isn't a clock. */
  parse(text) {
    const match = typeof text === 'string' && CLOCK.exec(text);
    return match ? { time: Number(match[1]), counter: Number(match[2]) } : null;
  },
};

/**
 * Field names a change can't have: `$clocks` is where a document keeps its fields' clocks, and
 * `key` is the document's own key wherever documents are listed (`{ key, ...fields }`), so a
 * field by that name would pass one document off as another.
 */
const RESERVED = new Set(['$clocks', 'key']);

const valid = (change) =>
  change && typeof change.collection === 'string' && typeof change.key === 'string' && typeof change.field === 'string' &&
  clock.parse(change.clock) !== null && !RESERVED.has(change.field);

/** The largest counter a clock can carry; past it, the clock moves on a millisecond. */
const MAX_COUNTER = 99_999;

/**
 * How documents are read, wherever they're kept: `find(collection, key)` → fields or undefined,
 * `list(collection)` → `[{ key, fields }]`, `names()` → the collections. What a reader gets is a
 * copy, so changing it changes nothing.
 */
export function documentsView({ find, list, names }) {
  return {
    /** A document's fields (a copy), or undefined when nothing has been written to it. */
    get(collection, key) {
      const fields = find(collection, key);
      return fields && structuredClone(fields);
    },
    /**
     * Every document in a collection whose key starts with `prefix` (all of them by default):
     * `[{ key, ...fields }]`, in the order they were first written to.
     */
    all: (collection, prefix = '') =>
      list(collection)
        .filter(({ key }) => key.startsWith(prefix))
        // The key last: nothing in the fields can stand in for it.
        .map(({ key, fields }) => ({ ...structuredClone(fields), key })),
    /** The collections that have documents, in the order they were first written to. */
    collections: () => names(),
  };
}

/** The documents a log describes, merged by each field's latest clock, as every device merges them. */
function documentsOf() {
  const docs = new Map();
  const id = (collection, key) => `${collection}\u0000${key}`;
  return {
    /** Applies a change if its clock is the field's latest; returns what undoes it, if it did. */
    apply(change) {
      let doc = docs.get(id(change.collection, change.key));
      if (!doc) docs.set(id(change.collection, change.key), (doc = { collection: change.collection, key: change.key, fields: {}, clocks: {} }));
      const known = doc.clocks[change.field];
      if (known && known >= change.clock) return null;
      const had = change.field in doc.fields;
      const before = doc.fields[change.field];
      doc.clocks[change.field] = change.clock;
      doc.fields[change.field] = change.value;
      return () => {
        if (doc.clocks[change.field] !== change.clock) return; // something newer came since: it stands
        if (had) [doc.clocks[change.field], doc.fields[change.field]] = [known, before];
        else delete doc.clocks[change.field], delete doc.fields[change.field];
        if (!Object.keys(doc.fields).length) docs.delete(id(change.collection, change.key));
      };
    },
    view: documentsView({
      find: (collection, key) => docs.get(id(collection, key))?.fields,
      list: (collection) => [...docs.values()].filter((doc) => doc.collection === collection),
      names: () => [...new Set([...docs.values()].map((doc) => doc.collection))],
    }),
  };
}

/** For `createSyncServer({ authorize: allowAnyone })`: every page may read and write everything. */
export const allowAnyone = () => true;

/** The default: pages may read; writes from pages need an `authorize` that says who may make them. */
const readsOnly = ({ write }) => !write;
const NO_AUTHORIZE = 'This sync server takes no writes from pages until it is told who may make them: pass createSyncServer({ authorize }) (or authorize: allowAnyone, for a page anyone may edit). See docs/sync.md, "Who may write".';

export function createSyncServer({ log = memoryLog(), mount = MOUNT, authorize: given, scope: serverScope = () => null, origins = [], heartbeat = 15_000, device = 'server', maxSkew = 60_000 } = {}) {
  if (!/^[\w-]{1,40}$/.test(device)) throw new Error('createSyncServer: `device` names the server in its clocks: letters, digits, - and _');
  if (given !== undefined && typeof given !== 'function') throw new TypeError('createSyncServer: `authorize` is a function ({ request, collection, key, field, value, write, kind }) => boolean');
  const authorize = given ?? readsOnly;
  /** What a refused write says: why, when no authorize was given; the app's own refusal otherwise. */
  const refused = (fallback) => json(403, { error: given ? fallback : NO_AUTHORIZE });
  const base = mount.replace(/\/$/, '');
  // Appends, one after another, so the log's order is the order they were made in.
  let appending = Promise.resolve();
  // The server's clock: later than any clock it has seen, so its writes win over what came
  // before them (and lose to what devices write after, as any device's would).
  let lastTime = 0;
  let counter = 0;
  const tick = () => {
    let now = Math.max(Date.now(), lastTime);
    counter = now === lastTime ? counter + 1 : 0;
    // A counter can't outgrow its five digits (the clock would stop comparing as a string).
    if (counter > MAX_COUNTER) {
      now += 1;
      counter = 0;
    }
    lastTime = now;
    return clock.format(now, counter, device);
  };
  /** Whether a clock is further ahead of this server's than `maxSkew`: a device can't push one. */
  const ahead = (stamp) => clock.parse(stamp).time > Date.now() + maxSkew;
  const see = (change) => {
    const { time, counter: seen } = clock.parse(change.clock);
    // One already in the log from before this check (or a log written elsewhere) doesn't drag
    // this server's clock into the future with it.
    if (time > Date.now() + maxSkew) return;
    if (time > lastTime) {
      lastTime = time;
      counter = seen;
    } else if (time === lastTime) {
      counter = Math.max(counter, seen);
    }
  };
  // The documents, built from the log the first time they're asked for, then kept current.
  // While they're being built, what's recorded goes into the view being built too (applying a
  // change twice changes nothing), so nothing that arrives during the read is missed.
  let docs = null;
  let built = null;
  let building = null;
  /** Puts changes in the documents; returns what takes them back out (for a write the log refused). */
  const record = (changes) => {
    const undo = [];
    for (const change of changes) {
      see(change);
      const taken = (docs ?? built)?.apply(change);
      if (taken) undo.push(taken);
    }
    return () => undo.reverse().forEach((take) => take());
  };
  async function documents() {
    if (docs) return docs.view;
    building ??= (async () => {
      built = documentsOf();
      for (let cursor = 0; ; ) {
        const page = await log.after(cursor, 5000);
        for (const change of page.changes) {
          see(change);
          built.apply(change);
        }
        if (!page.changes.length || String(page.cursor) === String(cursor)) break;
        cursor = page.cursor;
      }
      docs = built;
      return built.view;
    })();
    return building;
  }
  // One that fails rejects for its own caller only; the next still runs.
  const append = (changes) => (appending = appending.catch(() => {}).then(() => log.append(changes)));
  // Live subscribers: { peer, request, send(event, data), rooms }.
  const listeners = new Set();
  const encoder = new TextEncoder();
  const roomOf = (room) => {
    const at = room.indexOf('/');
    return at > 0 ? { collection: room.slice(0, at), key: room.slice(at + 1) } : null;
  };
  /**
   * What a request may see: inside the server's scope for it and the page's own, and allowed by
   * authorize. `where` is `{ request, scopes: [server, page] }`.
   */
  const sees = async ({ request, scopes }, collection, key) =>
    scopes.every((scope) => inScope(scope, collection, key)) && (await authorize({ request, collection, key, write: false, kind: 'read' }));
  async function visible(where, changes) {
    const shown = [];
    for (const change of changes) if (await sees(where, change.collection, change.key)) shown.push(change);
    return shown;
  }
  /** The server's scope for a request and the page's (`?scope=`), or a Response refusing it. */
  async function scopesOf(request, url) {
    let page;
    try {
      page = parseScope(url.searchParams.get('scope'));
    } catch (error) {
      return json(400, { error: error.message });
    }
    const server = (await serverScope({ request })) ?? null;
    if (server) checkScope(server);
    return [server, page];
  }
  /** Where to read from for a device at `since`: from the start if it's past the end of the log. */
  async function startFrom(since) {
    const head = await log.head?.();
    const at = Number(since);
    if (head === undefined || !/^\d+$/.test(String(since)) || at <= Number(head)) return { since, reset: false };
    return { since: '0', reset: true };
  }
  async function broadcastChanges(changes, cursor) {
    for (const listener of listeners) listener.send('changes', { changes: await visible(listener, changes), cursor });
  }
  async function broadcastPresence(message) {
    const { collection, key } = roomOf(message.room);
    for (const listener of listeners) {
      if (listener.peer === message.peer) continue;
      if (await sees(listener, collection, key)) listener.send('presence', message);
    }
  }
  /** Whether the server's scope lets this request write to (or join) a document. */
  const mayWrite = async (request, collection, key) => inScope((await serverScope({ request })) ?? null, collection, key);
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
      if (!changes || !changes.every(valid)) return json(400, { error: 'Expected { changes: [{ collection, key, field, value, clock }] }; a field can\'t be named key or $clocks' });
      if (changes.some((change) => ahead(change.clock))) return json(400, { error: "A change's clock is ahead of the server's by more than maxSkew; check the device's time" });
      for (const change of changes) {
        if (!(await mayWrite(request, change.collection, change.key))) return json(403, { error: 'Not yours to change' });
        if (!(await authorize({ request, collection: change.collection, key: change.key, field: change.field, value: change.value, write: true, kind: 'change' }))) return refused('Not yours to change');
      }
      const appended = changes.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value, clock }));
      const cursor = await append(appended);
      record(appended); // once it's logged: the documents never hold what the log doesn't
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
      if (!(await mayWrite(request, room.collection, room.key))) return json(403, { error: 'Not yours to join' });
      if (!(await authorize({ request, ...room, write: true, kind: 'presence' }))) return refused('Not yours to join');
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
      if (!(await mayWrite(request, room.collection, room.key))) return json(403, { error: 'Not yours to join' });
      if (!(await authorize({ request, ...room, write: true, kind: 'presence' }))) return refused('Not yours to join');
      const clean = { room: message.room, from: message.from, to: message.to, data: message.data };
      for (const listener of listeners) if (listener.peer === clean.to) listener.send('signal', clean);
      return json(200, { ok: true });
    }
    if (url.pathname === `${base}/live` && request.method === 'GET') {
      const peer = url.searchParams.get('peer') ?? '';
      if (!/^[\w-]{0,40}$/.test(peer)) return json(400, { error: 'Bad peer id' });
      const scopes = await scopesOf(request, url);
      if (scopes instanceof Response) return scopes;
      const { since, reset } = await startFrom(url.searchParams.get('since') ?? '0');
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
          listener = { peer, request, scopes, rooms: new Set(), send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`), close };
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
            listener.send('changes', { changes: await visible(listener, backlog.changes), cursor: backlog.cursor, ...(reset && first ? { reset: true } : {}) });
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
      const scopes = await scopesOf(request, url);
      if (scopes instanceof Response) return scopes;
      const { since, reset } = await startFrom(url.searchParams.get('since') ?? '0');
      const { changes, cursor } = await log.after(since);
      return json(200, { changes: await visible({ request, scopes }, changes), cursor, ...(reset ? { reset: true } : {}) });
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
    for (const name of RESERVED) if (name in fields) throw new TypeError(`sync.write: \`${name}\` can't be a field name`);
    // A server that hasn't read its log yet (it just started, or a Durable Object was evicted)
    // hasn't seen the clocks in it: read it first, so this write comes after all of them. Once
    // the documents exist this doesn't wait, so a check and a write with no await between stay
    // one step.
    if (!docs) await documents();
    const changes = Object.entries(fields).map(([field, value]) => ({ collection, key, field, value, clock: tick() }));
    if (!changes.length) return [];
    // In the documents at once, so a check before this call and the write are one step; taken
    // back out if the log refuses it.
    const undo = record(changes);
    let cursor;
    try {
      cursor = await append(changes);
    } catch (error) {
      undo();
      throw error;
    }
    await broadcastChanges(changes, cursor);
    return changes;
  }

  return { fetch, handle, documents, write };
}
