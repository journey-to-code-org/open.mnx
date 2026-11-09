// Tier 1: share 'use collection' documents through a log on a server, so other devices (and
// other people) converge. The store stays the source of truth on the device: writes land there
// first, and go out when the network allows; changes from the log come in and are merged.
//
//   import { connect } from '@zubra/sync/connect';
//   connect({ url: '/_zb/sync' });
//
// The protocol (plan/sync-design.md), plain HTTP so any server can keep the log:
//   POST <url>/push  { changes: [Change] }            → { ok: true }
//   GET  <url>/pull?since=<cursor>                     → { changes: [Change], cursor }
//   Change = { collection, key, field, value, clock }  (clock: a hybrid logical clock, a string
//   that sorts by time, then counter, then client id)
//
// Merging is last-writer-wins per field, by clock. A device that was offline pushes what it
// wrote when it's back; whichever write has the later clock wins, on every device alike.
import { onWrite, receive, currentStore, onPresence, receivePresence, peerId } from './index.js';

const CLOCKS = '$clocks';
const pad = (number, width) => String(number).padStart(width, '0');

function clock(client) {
  let last = 0;
  let counter = 0;
  const tick = (seen = 0) => {
    const now = Math.max(Date.now(), last, seen);
    counter = now === last ? counter + 1 : 0;
    last = now;
    return `${pad(now, 15)}-${pad(counter, 5)}-${client}`;
  };
  return { tick, see: (stamp) => tick(Number(stamp.slice(0, 15))) };
}

const remember = (name, fallback) => {
  try { return localStorage.getItem(name) ?? fallback(); } catch { return fallback(); }
};
const keep = (name, value) => { try { localStorage.setItem(name, value); } catch {} };

/**
 * Start sharing. `url`: where the log is (`/_zb/sync`). `interval`: how often to pull, in ms
 * (default 2000). Returns `{ flush, pull, stop }`.
 */
export function connect({ url = '/_zb/sync', interval = 2000, live = true } = {}) {
  const base = url.replace(/\/$/, '');
  const client = remember('zubra-sync:client', () => {
    const id = Math.random().toString(36).slice(2, 10);
    keep('zubra-sync:client', id);
    return id;
  });
  const clocks = clock(client);
  let cursor = remember('zubra-sync:cursor', () => '0');
  let outbox = JSON.parse(remember('zubra-sync:outbox', () => '[]'));
  const save = () => keep('zubra-sync:outbox', JSON.stringify(outbox));

  // Local writes: stamp each field, remember the stamp beside the document, queue it.
  const off = onWrite(async (collection, key, fields) => {
    const stamped = {};
    for (const [field, value] of Object.entries(fields)) {
      const stamp = clocks.tick();
      stamped[field] = stamp;
      outbox.push({ collection, key, field, value, clock: stamp });
    }
    save();
    const doc = (await currentStore().get(collection, key)) ?? {};
    await currentStore().set(collection, key, { [CLOCKS]: { ...doc[CLOCKS], ...stamped } });
    schedule();
  });

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 30);
  };

  async function flush() {
    if (!outbox.length) return;
    const sending = outbox.slice();
    try {
      const response = await fetch(`${base}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: sending }),
      });
      if (!response.ok) return;
      outbox = outbox.slice(sending.length);
      save();
    } catch {
      // Offline: the outbox stays (in localStorage too), and goes with the next flush.
    }
  }

  async function pull() {
    let body;
    try {
      const response = await fetch(`${base}/pull?since=${encodeURIComponent(cursor)}`);
      if (!response.ok) return;
      body = await response.json();
    } catch {
      return;
    }
    await apply(body);
  }

  // Changes are applied one batch at a time, in the order they arrived.
  let applying = Promise.resolve();
  const apply = (body) => (applying = applying.then(() => merge(body)).catch(() => {}));

  async function merge(body) {
    // By document: apply the fields whose clock beats the one stored here.
    const byDoc = new Map();
    for (const change of body.changes) {
      if (change.clock.endsWith(`-${client}`)) continue;
      clocks.see(change.clock);
      const id = JSON.stringify([change.collection, change.key]);
      if (!byDoc.has(id)) byDoc.set(id, []);
      byDoc.get(id).push(change);
    }
    for (const changes of byDoc.values()) {
      const { collection, key } = changes[0];
      const doc = (await currentStore().get(collection, key)) ?? {};
      const known = { ...doc[CLOCKS] };
      const fields = {};
      for (const change of changes) {
        if (known[change.field] && known[change.field] >= change.clock) continue;
        known[change.field] = change.clock;
        fields[change.field] = change.value;
      }
      if (Object.keys(fields).length) await receive(collection, key, { ...fields, [CLOCKS]: known });
    }
    // Never move the cursor back (a live backlog can arrive after a newer push).
    const next = String(body.cursor);
    if (!(/^\d+$/.test(next) && /^\d+$/.test(cursor) && Number(next) < Number(cursor))) cursor = next;
    keep('zubra-sync:cursor', cursor);
  }

  // Live: a server-sent event stream brings changes as they're pushed, and other viewers'
  // presence. While it's open there's nothing to poll; while it isn't, polling carries on.
  let source = null;
  let open = false;
  let retry = null;
  const listen = () => {
    if (!live || typeof EventSource === 'undefined' || stopped) return;
    source = new EventSource(`${base}/live?since=${encodeURIComponent(cursor)}&peer=${encodeURIComponent(peerId())}`);
    source.addEventListener('open', () => (open = true));
    source.addEventListener('changes', (event) => apply(JSON.parse(event.data)));
    source.addEventListener('presence', (event) => receivePresence(JSON.parse(event.data)));
    source.addEventListener('error', () => {
      // Reconnect from the current cursor (EventSource would reuse the first one).
      open = false;
      source?.close();
      source = null;
      clearTimeout(retry);
      retry = setTimeout(listen, 1000);
    });
  };

  // Presence goes straight out, unqueued: an old cursor position is worth nothing later.
  const offPresence = onPresence((message) => {
    fetch(`${base}/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      keepalive: message.state === null, // a leave on pagehide still gets there
    }).catch(() => {});
  });
  let stopped = false;

  const loop = setInterval(() => flush().then(() => (open ? undefined : pull())), interval);
  const online = () => flush().then(pull);
  addEventListener('online', online);
  flush().then(pull).then(listen);
  return {
    flush,
    pull,
    stop() {
      stopped = true;
      off();
      offPresence();
      source?.close();
      clearTimeout(retry);
      clearInterval(loop);
      clearTimeout(timer);
      removeEventListener('online', online);
    },
  };
}
