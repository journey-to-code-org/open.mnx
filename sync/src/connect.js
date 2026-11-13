// Tier 1: share 'use collection' documents through a log on a server, so other devices (and
// other people) converge. The store stays the source of truth on the device: writes land there
// first, and go out when the network allows; changes from the log come in and are merged.
//
//   import { connect } from '@zubra/sync/connect';
//   connect({ url: '/_zb/sync' });
//
// The protocol (plan/sync-design.md), plain HTTP so any server can keep the log:
//   POST <url>/push  { changes: [Change] }            → { ok: true }
//   GET  <url>/pull?since=<cursor>[&scope=<json>]      → { changes: [Change], cursor }
//   Change = { collection, key, field, value, clock }  (clock: a hybrid logical clock, a string
//   that sorts by time, then counter, then client id)
//
// Merging is last-writer-wins per field, by clock. A device that was offline pushes what it
// wrote when it's back; whichever write has the later clock wins, on every device alike.
import { onWrite, receive, currentStore, onPresence, receivePresence, peerId, startingPull } from './index.js';
import { mesh } from './webrtc.js';

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

/**
 * @internal The changes waiting to be pushed. A push takes a snapshot (`take`), and when the
 * server has it, exactly those changes leave (`done`): by identity, not by count, so a change
 * added while an earlier push was out is never dropped by it. Two pushes can overlap (the debounce
 * and the poll loop); this is why that's safe.
 *
 * It keeps one change per field: a newer one replaces what's waiting for the same field (this
 * device's later write wins anyway), so hours of typing offline wait as one change per field,
 * not one per keystroke, and still fit in localStorage.
 */
export function outboxOf(changes = [], persist = () => {}) {
  const same = (a, b) => a.collection === b.collection && a.key === b.key && a.field === b.field;
  let pending = [];
  for (const change of changes) pending = [...pending.filter((other) => !same(other, change)), change];
  return {
    get size() {
      return pending.length;
    },
    pending: () => pending.slice(),
    add(change) {
      pending = pending.filter((other) => !same(other, change));
      pending.push(change);
      persist(pending);
    },
    take: () => pending.slice(),
    done(sent) {
      const gone = new Set(sent);
      pending = pending.filter((change) => !gone.has(change));
      persist(pending);
    },
  };
}

const remember = (name, fallback) => {
  try { return localStorage.getItem(name) ?? fallback(); } catch { return fallback(); }
};
const keep = (name, value) => { try { localStorage.setItem(name, value); } catch {} };

/**
 * Start sharing. `url`: where the log is (`/_zb/sync`). `interval`: how often to pull, in ms
 * (default 2000). `scope`: only what this page shows, per collection `true` or a key prefix (or a
 * list of them), e.g. `{ seats: 'showing-12/', brands: true }`; leave it out for everything.
 * Returns `{ flush, pull, stop }`.
 */
export function connect({ url = '/_zb/sync', interval = 2000, live = true, webrtc = false, scope = null } = {}) {
  const base = url.replace(/\/$/, '');
  // The scope goes with every pull and live request. Each scope keeps its own cursor: a page that
  // moves to another showing reads that showing from the start, not from where the last one was.
  const scoped = scope ? `&scope=${encodeURIComponent(JSON.stringify(scope))}` : '';
  const cursorName = scope ? `zubra-sync:cursor:${JSON.stringify(scope)}` : 'zubra-sync:cursor';
  const client = remember('zubra-sync:client', () => {
    const id = Math.random().toString(36).slice(2, 10);
    keep('zubra-sync:client', id);
    return id;
  });
  const clocks = clock(client);
  let cursor = remember(cursorName, () => '0');
  const outbox = outboxOf(JSON.parse(remember('zubra-sync:outbox', () => '[]')), (pending) =>
    keep('zubra-sync:outbox', JSON.stringify(pending)));

  // This device's stamps, kept here the moment a field is edited. Storing them beside the document
  // takes an await, and a change from elsewhere merged in that time must still lose to them.
  const mine = new Map(); // JSON [collection, key] → { field: clock }
  const newest = (a, b) => (a && (!b || a > b) ? a : b);
  const own = ({ collection, key, field, clock: stamp }) => {
    const id = JSON.stringify([collection, key]);
    if (!mine.has(id)) mine.set(id, {});
    mine.get(id)[field] = newest(stamp, mine.get(id)[field]);
  };

  // Local writes: stamp each field, remember the stamp beside the document, queue it.
  const off = onWrite(async (collection, key, fields) => {
    const stamped = {};
    for (const [field, value] of Object.entries(fields)) {
      const stamp = clocks.tick();
      stamped[field] = stamp;
      const change = { collection, key, field, value, clock: stamp };
      own(change);
      outbox.add(change);
    }
    const doc = (await currentStore().get(collection, key)) ?? {};
    await currentStore().set(collection, key, { [CLOCKS]: { ...doc[CLOCKS], ...stamped } });
    schedule();
  });

  let timer = null;
  let warned = false;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 30);
  };

  async function flush() {
    if (!outbox.size) return;
    const sending = outbox.take();
    try {
      const response = await fetch(`${base}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: sending }),
      });
      if (!response.ok) {
        // A refused write is kept (it may be allowed later), but say why once: a server with no
        // `authorize` refuses every write from pages, and a silent outbox looks like a bug.
        if (response.status === 403 && !warned) {
          warned = true;
          const why = await response.json().then((body) => body?.error, () => '');
          console.warn(`@zubra/sync: the server refused this page's changes${why ? `: ${why}` : ''}`);
        }
        return;
      }
      outbox.done(sending);
    } catch {
      // Offline: the outbox stays (in localStorage too), and goes with the next flush.
    }
  }

  async function pull() {
    let body;
    try {
      const response = await fetch(`${base}/pull?since=${encodeURIComponent(cursor)}${scoped}`);
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
    for (const [id, changes] of byDoc) {
      const { collection, key } = changes[0];
      const doc = (await currentStore().get(collection, key)) ?? {};
      // What's stored, and what this device has stamped since that may not be stored yet.
      const known = { ...doc[CLOCKS] };
      for (const [field, stamp] of Object.entries(mine.get(id) ?? {})) known[field] = newest(stamp, known[field]);
      const fields = {};
      for (const change of changes) {
        if (known[change.field] && known[change.field] >= change.clock) continue;
        known[change.field] = change.clock;
        fields[change.field] = change.value;
      }
      // An edit made here while the change was being stored still wins on screen.
      const stillNewer = (field) => field === CLOCKS || !(mine.get(id)?.[field] > known[field]);
      if (Object.keys(fields).length) await receive(collection, key, { ...fields, [CLOCKS]: known }, stillNewer);
    }
    // Never move the cursor back (a live backlog can arrive after a newer push), unless the server
    // says this device's cursor was past the end of its log: then it starts over from what it sent.
    const next = String(body.cursor);
    if (body.reset || !(/^\d+$/.test(next) && /^\d+$/.test(cursor) && Number(next) < Number(cursor))) cursor = next;
    keep(cursorName, cursor);
  }

  // Live: a server-sent event stream brings changes as they're pushed, and other viewers'
  // presence. While it's open there's nothing to poll; while it isn't, polling carries on.
  let source = null;
  let open = false;
  let retry = null;
  const listen = () => {
    if (!live || typeof EventSource === 'undefined' || stopped) return;
    source = new EventSource(`${base}/live?since=${encodeURIComponent(cursor)}&peer=${encodeURIComponent(peerId())}${scoped}`);
    source.addEventListener('open', () => (open = true));
    source.addEventListener('changes', (event) => apply(JSON.parse(event.data)));
    source.addEventListener('presence', (event) => {
      const message = JSON.parse(event.data);
      rtc?.sawPeer(message.room, message.peer, message.state);
      receivePresence(message);
    });
    source.addEventListener('signal', (event) => rtc?.receiveSignal(JSON.parse(event.data)));
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
  // With webrtc, presence goes over data channels to the peers that have one; the server carries
  // it only while someone in the room doesn't (and always carries goodbyes).
  const rtc =
    webrtc && typeof RTCPeerConnection !== 'undefined'
      ? mesh({
          self: peerId(),
          iceServers: webrtc.iceServers ?? [],
          deliver: receivePresence,
          signal: (room, to, data) =>
            fetch(`${base}/signal`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ room, from: peerId(), to, data }),
            }).catch(() => {}),
        })
      : null;

  const offPresence = onPresence((message) => {
    if (rtc?.send(message) && message.state !== null) return;
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
  // What's still waiting to be sent is newer than what's stored wherever the store says otherwise:
  // a tab that closed with writes queued can leave the stored value behind the outbox.
  async function replay() {
    const byDoc = new Map();
    for (const change of outbox.pending()) {
      const id = JSON.stringify([change.collection, change.key]);
      byDoc.set(id, [...(byDoc.get(id) ?? []), change]);
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
  }

  // Components wait for this first pull before applying what's stored (index.js: fresh first).
  const first = (applying = applying.then(replay).catch(() => {})).then(flush).then(pull);
  startingPull(first);
  first.then(listen);
  return {
    flush,
    pull,
    /** The peers presence goes to directly (webrtc), by peer id. */
    direct: () => rtc?.direct() ?? [],
    stop() {
      stopped = true;
      off();
      offPresence();
      rtc?.close();
      source?.close();
      clearTimeout(retry);
      clearInterval(loop);
      clearTimeout(timer);
      removeEventListener('online', online);
    },
  };
}
