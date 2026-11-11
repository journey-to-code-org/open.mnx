// @zubra/sync: a component's state as a document in a local store.
//
//   <script>
//     'use collection tasks';
//     import { ephemeral } from '@zubra/sync';
//     let completed = false;             // stored: a field of the document
//     let editing = ephemeral(false);    // not stored
//   </script>
//   <task-item doc="">…</task-item>      <!-- <task-item doc="t42"> is the document tasks/t42 -->
//
// The compiler turns the directive into one call, `collection("tasks", ["doc"], $p, { completed })`,
// at the end of the component's setup. This module does the rest, with the platform's pieces only:
//
// - a write is a signal assignment, so the UI never waits; the store catches up behind it;
// - the store is IndexedDB (in memory where there's none), so state survives reloads, offline;
// - other elements showing the same document, in this tab or another (BroadcastChannel), follow.
//
// Tier 0 of plan/sync-design.md: one device, no server. Merging is last-writer-wins per field.
import { effect, onUnmount, Signal } from '@zubra/runtime';

/** `let editing = ephemeral(false)`: state the collection doesn't store. */
export const ephemeral = (value) => value;
/**
 * `let cursor = presence({ x: 0, y: 0 })`: state shared live with the document's other viewers
 * (other tabs; other devices when connected), never stored. The compiler passes it on.
 */
export const presence = (value) => value;
/** `let others = peers()`: the document's other viewers' presence, `[{ peer, ...state }]`. */
export const peers = () => [];

let store = null;
/** Use another store (`{ get(collection, key), set(collection, key, fields) }`), before elements start. */
export function configure(options = {}) {
  if (options.store) store = options.store;
}
const theStore = () => (store ??= typeof indexedDB === 'undefined' ? memoryStore() : indexedDBStore());

// What a connection (connect.js) listens to: every local save, with the fields it changed.
const writers = new Set();
/** @internal Called with `(collection, key, fields)` on each local save. */
export const onWrite = (fn) => (writers.add(fn), () => writers.delete(fn));
/** @internal A change from elsewhere: store it, and show it in this tab and the others. */
export async function receive(collection, key, fields) {
  await theStore().set(collection, key, fields);
  deliver(collection, key, fields, null);
  channel?.postMessage({ collection, key, fields });
}
/** @internal The store in use. */
export const currentStore = () => theStore();

// Every bound element, by document, so a write reaches the others (this tab and, below, others).
const bound = new Map();
const docId = (collection, key) => `${collection}\u0000${key}`;
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('zubra-sync');
// Outside a browser (Node, a test), an open channel would keep the process from exiting.
channel?.unref?.();
channel?.addEventListener('message', ({ data }) =>
  data.kind === 'presence' ? receivePresence(data) : deliver(data.collection, data.key, data.fields, null));

// Presence: each tab is one peer per document ("room"). What it sends goes to the other tabs
// (BroadcastChannel) and, through a connection, to other devices; nothing is stored.
const tab = Math.random().toString(36).slice(2, 10);
const rooms = new Map(); // room → Set of (peer, state) handlers
const presenceSenders = new Set();
const joined = new Set(); // rooms this tab has presence in, to leave on pagehide
/** @internal Called with `{ room, peer, state }` for each presence this tab sends (state null: left). */
export const onPresence = (fn) => (presenceSenders.add(fn), () => presenceSenders.delete(fn));
/** @internal This tab's peer id. */
export const peerId = () => tab;
/** @internal Presence from elsewhere. */
export function receivePresence({ room, peer, state }) {
  if (peer === tab) return;
  for (const handler of rooms.get(room) ?? []) handler(peer, state);
}
function sendPresence(room, state) {
  const message = { room, peer: tab, state };
  if (state === null) joined.delete(room);
  else joined.add(room);
  channel?.postMessage({ kind: 'presence', ...message });
  for (const send of presenceSenders) send(message);
}
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => {
    for (const room of [...joined]) sendPresence(room, null);
  });
}
function deliver(collection, key, fields, from) {
  for (const apply of bound.get(docId(collection, key)) ?? []) if (apply !== from) apply(fields);
}

/** Plain JSON of a state value; reading it all also subscribes to every nested change. */
const snapshot = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/**
 * Bind `fields` (the component's state signals, by name) to the document keyed by the `keys`
 * props in `collection`. Called by compiled components.
 */
export function collection(name, keys, props, fields, presenceFields = null, peersSignal = null) {
  const keyOf = () => {
    const parts = keys.map((key) => props[key]);
    return parts.every((part) => part !== undefined && part !== null && part !== '') ? parts.join('/') : null;
  };
  const loaded = new Signal.State(null);
  let current = null;
  let last = null; // the JSON last loaded or saved, so a load isn't written back
  let applying = false;

  const apply = (doc) => {
    if (!doc) return;
    applying = true;
    try {
      for (const [field, signal] of Object.entries(fields)) if (field in doc) signal.set(doc[field]);
    } finally {
      applying = false;
    }
  };
  /** Each field's current value, as JSON text. */
  const values = () => Object.fromEntries(Object.entries(fields).map(([field, signal]) => [field, JSON.stringify(snapshot(signal.get()))]));
  const onRemote = (doc) => {
    apply(doc);
    last = JSON.stringify(Object.fromEntries(Object.keys(fields).map((field) => [field, snapshot(fields[field].get())])));
  };

  const join = (key) => {
    const id = docId(name, key);
    if (!bound.has(id)) bound.set(id, new Set());
    bound.get(id).add(onRemote);
  };
  const leave = (key) => {
    const id = docId(name, key);
    bound.get(id)?.delete(onRemote);
    if (bound.get(id)?.size === 0) bound.delete(id);
  };

  // Load the document whenever the key changes.
  effect(() => {
    const key = keyOf();
    if (current !== null) leave(current);
    current = key;
    if (key === null) return;
    join(key);
    let cancelled = false;
    // What the fields hold as loading starts, to tell what someone changed while it loaded.
    const before = Signal.subtle.untrack(values);
    theStore()
      .get(name, key)
      .then((doc = {}) => {
        if (cancelled) return;
        // An edit made before the document arrived is newer than it: keep the edit (and save
        // it, below); take the document's values for the rest.
        const now = values();
        const edited = new Set(Object.keys(fields).filter((field) => now[field] !== before[field]));
        apply(Object.fromEntries(Object.entries(doc).filter(([field]) => !edited.has(field))));
        // `last` is what's stored, so the save effect writes exactly the edits.
        last = JSON.stringify(Object.fromEntries(Object.keys(fields).map((field) => [field, field in doc ? snapshot(doc[field]) : JSON.parse(before[field])])));
        loaded.set(key);
      })
      .catch((error) => console.error(`@zubra/sync: couldn't load ${name}/${key}`, error));
    return () => (cancelled = true);
  });

  // Save on every change, once the document is loaded (so the defaults never overwrite it).
  effect(() => {
    const key = keyOf();
    const doc = Object.fromEntries(Object.entries(fields).map(([field, signal]) => [field, snapshot(signal.get())]));
    if (key === null || loaded.get() !== key || applying) return;
    const text = JSON.stringify(doc);
    if (text === last) return;
    const before = last === null ? {} : JSON.parse(last);
    last = text;
    const changed = Object.fromEntries(Object.entries(doc).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(before[field])));
    for (const write of writers) write(name, key, changed);
    theStore()
      .set(name, key, doc)
      .catch((error) => console.error(`@zubra/sync: couldn't save ${name}/${key}`, error));
    deliver(name, key, doc, onRemote);
    channel?.postMessage({ collection: name, key, fields: doc });
  });

  onUnmount(() => current !== null && leave(current));
  if (presenceFields || peersSignal) live(name, keyOf, presenceFields ?? {}, peersSignal);
}

const PRUNE = 30_000; // a peer not heard from for this long has gone (a crash, a closed laptop)
const HEARTBEAT = 10_000;

/** Send this element's presence to its document's room, and keep `peers` up to date. */
function live(name, keyOf, fields, peersSignal) {
  const others = new Map(); // peer → { state, seen }
  const publish = () =>
    peersSignal?.set([...others.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([peer, { state }]) => ({ ...state, peer })));
  const sending = Object.keys(fields).length > 0;
  const mine = () => Object.fromEntries(Object.entries(fields).map(([field, signal]) => [field, snapshot(signal.get())]));
  let room = null;
  let latest = null;
  let queued = false;
  const flush = () => {
    queued = false;
    if (room !== null && latest !== null) sendPresence(room, latest);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    // At most once a frame: a pointer moves far more often than anyone can see.
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16))(flush);
  };
  const onPeer = (peer, state) => {
    const known = others.has(peer);
    if (state === null) others.delete(peer);
    else others.set(peer, { state, seen: Date.now() });
    publish();
    // Someone new: tell them where we are, so they don't wait for our next move.
    if (!known && state !== null && sending) queue();
  };

  effect(() => {
    const key = keyOf();
    const next = key === null ? null : `${name}/${key}`;
    const state = sending ? mine() : null;
    if (next !== room) {
      if (room !== null) {
        rooms.get(room)?.delete(onPeer);
        if (sending) sendPresence(room, null);
        others.clear();
        publish();
      }
      room = next;
      if (room !== null) {
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(onPeer);
      }
    }
    if (room !== null && sending) {
      latest = state;
      queue();
    }
  });

  const timer = setInterval(() => {
    if (sending && room !== null && latest !== null) sendPresence(room, latest);
    const now = Date.now();
    let pruned = false;
    for (const [peer, { seen }] of others) if (now - seen > PRUNE) pruned = others.delete(peer) || pruned;
    if (pruned) publish();
  }, HEARTBEAT);

  onUnmount(() => {
    clearInterval(timer);
    if (room !== null) {
      rooms.get(room)?.delete(onPeer);
      if (sending) sendPresence(room, null);
    }
  });
}

/** A store in memory: for servers, tests, and browsers without IndexedDB. */
export function memoryStore() {
  const docs = new Map();
  return {
    async get(collection, key) {
      const doc = docs.get(docId(collection, key));
      return doc ? structuredClone(doc) : undefined;
    },
    async set(collection, key, fields) {
      const id = docId(collection, key);
      docs.set(id, { ...docs.get(id), ...structuredClone(fields) });
    },
  };
}

/** The default store: one IndexedDB database, one record per document, fields merged on write. */
export function indexedDBStore(database = 'zubra-sync') {
  let opening = null;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('docs');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  const run = async (mode, work) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('docs', mode);
      const docs = transaction.objectStore('docs');
      let result;
      work(docs, (value) => (result = value));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
    });
  };
  return {
    get: (collection, key) =>
      run('readonly', (docs, done) => {
        const request = docs.get([collection, key]);
        request.onsuccess = () => done(request.result);
      }),
    set: (collection, key, fields) =>
      run('readwrite', (docs) => {
        const request = docs.get([collection, key]);
        request.onsuccess = () => docs.put({ ...request.result, ...fields }, [collection, key]);
      }),
  };
}
