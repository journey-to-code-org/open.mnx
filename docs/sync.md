# Sync: component state that lives on the device

`'use collection <name>'` at the top of a component's script keeps its state in a local store. The page needs `@zubra/sync` (a bundler, or an import map entry: with `@zubra/server`, `createZubra({ imports: { '@zubra/sync': '/sync/index.js' } })`).

```html
<!-- task-item.zb -->
<script>
  'use collection tasks';
  import { ephemeral } from '@zubra/sync';

  let completed = false;            // a field of the document
  let title = 'Untitled';           // another
  let editing = ephemeral(false);   // state, but not stored
  const label = completed ? 'done' : 'todo';   // derived: not stored
</script>

<task-item doc="">
  <input type="checkbox" checked={completed} onchange={(event) => (completed = event.target.checked)} />
  {title} <small>{label}</small>
</task-item>
```

```html
<task-item doc="t42"></task-item>   <!-- the document tasks/t42 -->
```

`examples/standup` is a whole app built this way: a plain Node server, a SQLite log, offline edits and presence, tested with two browsers.

## What the compiler writes

One line at the end of the element's setup, and one import:

```js
import { collection as $collection } from "@zubra/sync";
…
$collection("tasks", ["doc"], $p, { completed, title });
```

The fields are the script's top-level `let`s, minus the ones wrapped in `ephemeral()`. Derived `const`s, props and functions aren't stored.

## The rules

- **The key is props.** `doc` by default; `'use collection rows by list, item'` keys by two props (`list/item`). A key prop the host doesn't declare is a compile error. It isn't `id`: that's the element's own DOM id, which must be unique on the page, and two elements may show the same document.
- **A write is an assignment.** `completed = true`, `tags.push('x')`: the DOM updates now, the store a moment later. Nothing waits on a disk or a network.
- **Loading never overwrites, and nothing typed is lost.** Until an element's document has loaded, it shows the defaults, so the defaults never replace stored state. A field someone changed while it loaded keeps their change, which is then saved; the others take the stored values.
- **Values are JSON.** Strings, numbers, booleans, `null`, arrays and plain objects (nested changes included). A `Date` is stored as its ISO string.
- **Same document, same state.** Elements showing one document follow each other, in the page and in other tabs of the same site (BroadcastChannel).
- **Merging is last-writer-wins, per field.** Two tabs writing the same field: the later write is the value. Different fields merge.
- **The server renders the defaults** (and an `ephemeral()` value, which it can evaluate); the element loads its document once it starts.

## Stores

The browser default is IndexedDB, in a database called `zubra-sync`, one record per document. Where there's no IndexedDB, a memory store. Another store is two functions:

```js
import { configure, memoryStore } from '@zubra/sync';
configure({ store: { get: async (collection, key) => doc, set: async (collection, key, fields) => {} } });
```

## Sharing between devices

Tier 0 keeps a document on one device. To share it, start a connection on the page and serve the log:

```js
// in the page
import { connect } from '@zubra/sync/connect';
connect({ url: '/_zb/sync' });
```

```js
// on the server (a fetch handler: Node through a small adapter, Bun, Deno, workers)
import { createSyncServer } from '@zubra/sync/server';
const sync = createSyncServer({ authorize: ({ request, collection, key, write }) => true });
const response = await sync.fetch(request); // null if it isn't a sync request
```

Components don't change. The protocol is plain HTTP, so any server can keep the log:

| | |
|---|---|
| `POST /_zb/sync/push` | `{ "changes": [Change] }` → `{ "ok": true }` |
| `GET /_zb/sync/pull?since=<cursor>` | `{ "changes": [Change], "cursor": … }` |
| `Change` | `{ "collection", "key", "field", "value", "clock" }` |

- **The device is the source of truth.** A write lands in the local store first. The connection stamps each changed field with a hybrid logical clock (`<ms>-<counter>-<device>`), queues it (in `localStorage`, so a reload doesn't lose it) and pushes it when it can. Offline, it waits.
- **The server keeps a log, in order, and doesn't merge.** Every device applies the same rule to the same changes: for each field, the change with the later clock wins. So they converge, whichever order the changes arrive in. The clock of each field's winning write is stored beside the document (`$clocks`).
- **`authorize`** decides who may write a document and who sees its changes.
- **The log** is in memory by default. `sqliteLog(path)` from `@zubra/sync/sqlite` keeps it in a SQLite file through the runtime's own SQLite (`node:sqlite` on Node 22.5+, `bun:sqlite` on Bun), so it survives a restart with nothing to install. Any `{ append(changes), after(cursor, limit) }` works too.
- Cross-site pushes are refused, like actions.

Changes arrive over a live channel: `GET /_zb/sync/live?since=<cursor>` is a server-sent event stream of `changes` as they're pushed (and `presence`, below). While it's open there's nothing to poll; when it drops, the connection polls (every 2 seconds by default, and when the browser comes back online) and reopens it from the current cursor. `connect({ live: false })` polls only. A server with several processes needs a shared log and a pub/sub between them; the reference server's subscribers are its own process's.

### Without Node: the `zubra-sync` binary

`sync-server/` in the repository builds `zubra-sync`, the same protocol as one binary with SQLite built in: `zubra-sync --db sync.db --port 4000`. It reads and writes the same table as `sqliteLog()`, so a log can move between them. It has no notion of users, so put it behind your app at `/_zb/sync` (a reverse proxy after the app's sign-in), or allow a page's origin with `--origin` on a trusted network. The same protocol and browser tests run against it.

## Presence: who else is here

Some state should be seen by the other viewers of a document but never stored: where their cursor is, what they've selected, that they're typing.

```html
<!-- board-view.zb -->
<script>
  'use collection boards';
  import { presence, peers } from '@zubra/sync';

  let strokes = [];                          // stored
  let cursor = presence({ x: 0, y: 0 });     // shared live, never stored
  let others = peers();                      // everyone else's presence
</script>

<board-view doc="">
  <div class="pad" onpointermove={(event) => (cursor = { x: event.offsetX, y: event.offsetY })}></div>
  <zb-each items={others} as="other" key={other.peer}>
    <span class="cursor" style={`left: ${other.cursor.x}px; top: ${other.cursor.y}px`}></span>
  </zb-each>
</board-view>
```

- **A room is a document.** The board `boards/b1`'s viewers see each other; another document's don't.
- **`peers()` is an array** of the other viewers, `{ peer, ...presence }`: each one's id and its presence fields by name (`other.cursor` above). Each tab is one peer; your own tab isn't in it. On the server it's empty, and a `presence()` value renders as its starting value.
- **Without a server**, presence reaches the other tabs of the same site (BroadcastChannel). **With `connect()`**, it reaches other devices too: `POST /_zb/sync/presence { room, peer, state }`, and the live stream's `presence` events.
- **It's cheap on purpose.** At most one message a frame, however fast the pointer moves; a heartbeat every 10 seconds; a viewer not heard from for 30 seconds has gone. Closing a tab says goodbye (`pagehide`), and the server says it for a device whose connection drops.
- **Nothing is stored**, on the device or the server. `authorize` decides who may join a room (`write: true`) and who sees its presence (`write: false`).

### Device to device: `connect({ webrtc: true })`

Presence changes far more often than documents, and nobody needs it stored, so it doesn't have to go through a server at all once two viewers have found each other. With `webrtc`, each pair of viewers in a room opens a WebRTC data channel and sends presence over it; the server carries only what a channel can't:

- **introductions**: a newcomer's first presence, which is how the others learn it's there;
- **signaling**: the offer, answer and ICE candidates that open a channel (`POST /_zb/sync/signal { room, from, to, data }`, delivered as a `signal` event on that one peer's live stream);
- **goodbyes**, and presence to anyone without a channel yet.

On one network, the pointer moves never leave it. Across networks, peers need help finding a path: `connect({ webrtc: { iceServers: [{ urls: 'stun:stun.example.org' }] } })`. Some pairs can't connect directly at all (strict NATs, some corporate networks); that takes a TURN relay, which the app provides, since it carries traffic and costs bandwidth. Without one, those pairs simply keep using the server, so presence still works, just not directly.

- **Documents never go over channels.** Their changes go through the log, which is what makes them durable and lets offline devices catch up.
- **It isn't end-to-end encrypted in the sense of "the server knows nothing".** DTLS encrypts each channel, but the server still sees who is in which room, and carries the introductions.
- `link.direct()` lists the peers presence currently goes to directly.
