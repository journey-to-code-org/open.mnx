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

let store = null;
/** Use another store (`{ get(collection, key), set(collection, key, fields) }`), before elements start. */
export function configure(options = {}) {
  if (options.store) store = options.store;
}
const theStore = () => (store ??= typeof indexedDB === 'undefined' ? memoryStore() : indexedDBStore());

// Every bound element, by document, so a write reaches the others (this tab and, below, others).
const bound = new Map();
const docId = (collection, key) => `${collection}\u0000${key}`;
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('zubra-sync');
channel?.addEventListener('message', ({ data }) => deliver(data.collection, data.key, data.fields, null));
function deliver(collection, key, fields, from) {
  for (const apply of bound.get(docId(collection, key)) ?? []) if (apply !== from) apply(fields);
}

/** Plain JSON of a state value; reading it all also subscribes to every nested change. */
const snapshot = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/**
 * Bind `fields` (the component's state signals, by name) to the document keyed by the `keys`
 * props in `collection`. Called by compiled components.
 */
export function collection(name, keys, props, fields) {
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
    theStore()
      .get(name, key)
      .then((doc) => {
        if (cancelled) return;
        onRemote(doc ?? {});
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
    last = text;
    theStore()
      .set(name, key, doc)
      .catch((error) => console.error(`@zubra/sync: couldn't save ${name}/${key}`, error));
    deliver(name, key, doc, onRemote);
    channel?.postMessage({ collection: name, key, fields: doc });
  });

  onUnmount(() => current !== null && leave(current));
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
