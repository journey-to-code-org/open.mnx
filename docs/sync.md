# Sync: component state that lives on the device

`'use collection <name>'` at the top of a component's script keeps its state in a local store. The page needs `@zubra/sync` (an import map entry, or a bundler).

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
- **Loading never overwrites.** Until an element's document has loaded, it shows the defaults and saves nothing, so the defaults never replace stored state.
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
- **`authorize`** decides who may write a document and who sees its changes. The log is in memory by default; `log: { append(changes), after(cursor) }` stores it anywhere.
- Cross-site pushes are refused, like actions.

Pulling is polling (every 2 seconds by default, and when the browser comes back online). A live channel (SSE or WebSocket), presence and a WebRTC transport are the next steps in the design.
