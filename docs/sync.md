# Sync: component state that lives on the device

`'use collection <name>'` at the top of a component's script keeps its state in a local store. It needs `@zubra/sync` installed (`npm install @zubra/sync`). With a bundler, that's all. With `@zubra/server`, too: it finds the package, serves it, and adds it to the page's import map, so `import { connect } from '@zubra/sync/connect'` works in a page as written. If it isn't installed, the build or the page says so, naming the component and the command to run.

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
const sync = createSyncServer({ authorize: ({ request, collection, key, kind }) => true });
const response = await sync.fetch(request); // null if it isn't a sync request
```

Components don't change. The protocol is plain HTTP, so any server can keep the log:

| | |
|---|---|
| `POST /_zb/sync/push` | `{ "changes": [Change] }` → `{ "ok": true }` |
| `GET /_zb/sync/pull?since=<cursor>[&scope=<json>]` | `{ "changes": [Change], "cursor": … }` |
| `Change` | `{ "collection", "key", "field", "value", "clock" }` |

- **The device is the source of truth.** A write lands in the local store first. The connection stamps each changed field with a hybrid logical clock (`<ms>-<counter>-<device>`), queues it (in `localStorage`, so a reload doesn't lose it) and pushes it when it can. Offline, it waits.
- **The server keeps a log, in order, and doesn't merge.** Every device applies the same rule to the same changes: for each field, the change with the later clock wins. So they converge, whichever order the changes arrive in. The clock of each field's winning write is stored beside the document (`$clocks`).
- **`authorize`** decides who may write a document and who sees its changes. It's told what's asked: `kind` is `'change'` (a push), `'presence'` (joining a document's room; nothing is stored) or `'read'` (a change about to be sent to this request), and `write` is true for the first two.
- **The log** is in memory by default. `sqliteLog(path)` from `@zubra/sync/sqlite` keeps it in a SQLite file through the runtime's own SQLite (`node:sqlite` on Node 22.5+, `bun:sqlite` on Bun), so it survives a restart with nothing to install. Any `{ append(changes), after(cursor, limit) }` works too.
- **A log that doesn't grow with every change:** `sqliteLog(path, { keep: 'latest' })` (and `memoryLog`, `durableObjectLog`, with the same option) keeps each field's latest value only. A change with a newer clock replaces the field's row and takes the next cursor; one with an older clock is dropped. A new device reads what's there now, not the evening's history of every seat held and released. Devices merge the same either way: what's dropped would have lost to the newer write on every device anyway. Opening a file that has the full log as `keep: 'latest'` carries each field's latest value across, numbered after the old cursors, so devices that had read the old log miss nothing. The `zubra-sync` binary keeps every change.
- Cross-site pushes are refused, like actions.

**Fresh first.** On a connected page, a component waits for the connection's first pull before it applies what this device stored last time, so a returning visitor never sees last visit's state over what the log (or the page the server just rendered) says now. Until then it shows what it was rendered with. Offline, the pull fails at once and the stored document shows straight away; a pull that doesn't answer holds it back for 1.5 seconds at most. Call `connect()` in the page's own scripts (they all run before `DOMContentLoaded`, which is what a component waits for before looking).

**A cursor past the end of the log starts over.** If a device asks for changes after a cursor the log has never reached (the log was replaced, or wiped, or the device's cursor came from another one), pull and the live stream answer with everything in its scope from the beginning, with `"reset": true`, and the device takes the new cursor. Without this, it would hear nothing until the new log grew past its old cursor. Logs say where they end with `head()`; the built-in ones and the `zubra-sync` binary do. What a device already has with newer clocks than the new log's stays, by the same last-writer-wins rule.

Changes arrive over a live channel: `GET /_zb/sync/live?since=<cursor>` is a server-sent event stream of `changes` as they're pushed (and `presence`, below). While it's open there's nothing to poll; when it drops, the connection polls (every 2 seconds by default, and when the browser comes back online) and reopens it from the current cursor. `connect({ live: false })` polls only. A server with several processes needs a shared log and a pub/sub between them; the reference server's subscribers are its own process's.

### Only what the page shows: `scope`

By default a page receives, and stores, every change in the log. A page that shows one showing's seats, or one business's orders, should ask for just those:

```js
connect({ scope: { seats: 'showing-12/', holds: 'showing-12/', brands: true } });
```

- **Per collection, `true` or a key prefix**, or a list of prefixes. A collection the scope doesn't name isn't sent. Keys made from several props (`by showing, seat`) are joined with `/`, so a prefix like `'showing-12/'` takes every seat in that showing.
- **What's out of scope isn't sent:** not by pull, not by the live stream (its backlog or new changes), and not as presence. The page's store never has it.
- **Each scope keeps its own cursor** (in `localStorage`). A page that moves to another showing reads that showing from the start, not from wherever the last one got to.
- **The server can impose one:** `createSyncServer({ scope: ({ request }) => ({ orders: `${business(request)}/` }) })`. A page's own scope can only narrow it, and pushes and presence outside it are refused with 403. That's tenancy: each business's documents under its own key prefix, on one log. `authorize` still runs on what's in scope.
- **The `zubra-sync` binary honours a page's scope.** It has no notion of users, so a server-imposed scope is the JavaScript server's; put the binary behind an app that sets one.

### The server taking part

Devices decide most things themselves, and last writer wins is right for what one person owns. Some things two people can both want: the last item in stock, a job two drivers tap at once. The server decides those, in a [server action](actions.md), and its decision is a write to the same documents, so every page showing them follows.

```js
const docs = await sync.documents();   // every document, as the devices merge it, kept current

export async function claim(formData, context) {
  'use server'
  const order = docs.get('orders', formData.get('order'));
  if (order?.driver) return { error: 'Taken' };
  // No await between the check and the write: no other request can come in between.
  await sync.write('orders', formData.get('order'), { driver: context.user.id, status: 'claimed' });
}
```

- **`documents()`** reads the log once, then keeps up with every push and write. `get(collection, key)` is a document's fields (a copy); `all(collection)` is every document in a collection with its `key`; `collections()` names the collections that have any. Reads are synchronous.
- **`write(collection, key, fields)`** stamps each field with the server's clock (`createSyncServer({ device })`, `server` by default), which is always later than any clock it has seen. So the write wins over everything before it, and a device that writes afterwards wins over it, as between any two devices. The view has it at once; then it's logged and sent to every live page. A server that hasn't read its log yet (it just started) reads it before its first write, so that write comes after every clock in it. If the log refuses a write, `write()` rejects and the documents take it back out; a push the log refuses never reaches them.
- **To keep a document the server's alone**, refuse `kind: 'change'` for it in `authorize`, and let `kind: 'presence'` through if people should see who else has it open.
- One process: the view is this process's, like the live subscribers. Several processes need a shared log and should decide such things in one place.

### On Cloudflare Workers: a Durable Object

A Worker has many isolates and no memory they share, so the sync server can't live in one: a change pushed to one isolate would never reach a page listening on another. `@zubra/sync/durable` puts it in a Durable Object instead, one per app, with the log in the object's own SQLite (`durableObjectLog(ctx.storage)`, the table and cursors of `sqliteLog`). The Worker forwards `/_zb/sync/*` to it.

```js
import { SyncObject, syncStub } from '@zubra/sync/durable';

export class Market extends SyncObject {
  authorize({ request, collection, kind }) { /* as on Node; secrets are this.env's */ }
  // The object runs one call at a time: what must not interleave goes in its methods.
  async claim(order, driver) {
    if ((await this.documents()).get('orders', order)?.driver) return { error: 'Taken' };
    await this.write('orders', order, { driver, status: 'claimed' });
    return { ok: true };
  }
}

export default {
  async fetch(request, env) {
    const sync = syncStub(env.MARKET);             // the object named 'sync'
    return (await sync.fetch(request))              // Sync's requests, or null
      ?? render(await sync.documents('orders'));    // a copy, for this page
  },
};
// wrangler.jsonc: "durable_objects": { "bindings": [{ "name": "MARKET", "class_name": "Market" }] },
//                 "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Market"] }]
```

- **One difference from Node**: on Node, a server action reads `documents()` and writes in the same process, with no await between, so nothing interleaves. In a Worker the documents are in the object, and `syncStub(…).documents()` is a copy, not kept current. A read-then-write that must not interleave goes in a method of your `SyncObject` (`sync.stub.claim(…)`), where `this.documents()` is the live view. Don't `fetch()` in the middle of one: waiting on the network lets the object take the next request.
- **A page that vanishes is noticed a little later.** A page that closes says it's leaving, and is gone from its rooms at once. One whose connection is simply cut (a crash, a dropped network) isn't reported to a Durable Object: it finds out when a keep-alive can't be written, which on workerd is the third after the cut. So `SyncObject` sends one every 2 seconds (`static options = { heartbeat }`), and such a page leaves within about 6.
- **Options**: `static options = { mount, heartbeat, device, table, origins }`; `syncStub(namespace, { name, mount })` must use the same `mount`. A different `name` is a separate object with its own log.
- **The object is awake while any page listens.** An open live stream holds it in memory, which a Durable Object is billed for by duration; see [Zubra on Cloudflare Workers](edge.md).

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
- **Nothing is stored**, on the device or the server. `authorize` decides who may join a room (`kind: 'presence'`) and who sees its presence (`kind: 'read'`).

### Device to device: `connect({ webrtc: true })`

Presence changes far more often than documents, and nobody needs it stored, so it doesn't have to go through a server at all once two viewers have found each other. With `webrtc`, each pair of viewers in a room opens a WebRTC data channel and sends presence over it; the server carries only what a channel can't:

- **introductions**: a newcomer's first presence, which is how the others learn it's there;
- **signaling**: the offer, answer and ICE candidates that open a channel (`POST /_zb/sync/signal { room, from, to, data }`, delivered as a `signal` event on that one peer's live stream);
- **goodbyes**, and presence to anyone without a channel yet.

On one network, the pointer moves never leave it. Across networks, peers need help finding a path: `connect({ webrtc: { iceServers: [{ urls: 'stun:stun.example.org' }] } })`. Some pairs can't connect directly at all (strict NATs, some corporate networks); that takes a TURN relay, which the app provides, since it carries traffic and costs bandwidth. Without one, those pairs simply keep using the server, so presence still works, just not directly.

- **Documents never go over channels.** Their changes go through the log, which is what makes them durable and lets offline devices catch up.
- **It isn't end-to-end encrypted in the sense of "the server knows nothing".** DTLS encrypts each channel, but the server still sees who is in which room, and carries the introductions.
- `link.direct()` lists the peers presence currently goes to directly.
