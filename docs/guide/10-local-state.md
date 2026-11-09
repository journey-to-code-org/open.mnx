# 10. State that lives on the device

A component's `let`s last as long as the element. This chapter keeps them: in the browser's own storage, across reloads and tabs, and, when you want, across devices. It needs [`@zubra/sync`](../sync.md) (`npm install @zubra/sync`).

## `'use collection'`

```html
<!-- note-pad.zb -->
<script>
  'use collection notes'
  import { ephemeral } from '@zubra/sync'

  let text = ""                    // stored
  let focused = ephemeral(false)   // state, but not stored
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
</script>

<note-pad doc="scratch">
  <textarea aria-label="Note" value={text}
    oninput={(event) => (text = event.target.value)}
    onfocus={() => (focused = true)} onblur={() => (focused = false)}></textarea>
  <p>{words} {words === 1 ? "word" : "words"}{focused ? " · editing" : ""}</p>
</note-pad>
```

```html
<note-pad doc="monday"></note-pad>   <!-- the document notes/monday -->
```

The directive makes the component's state a document in the collection `notes`, found by its `doc` prop. Its top-level `let`s are the document's fields; `const`s are derived, so they aren't stored, and neither is anything wrapped in `ephemeral()`. Two elements with the same `doc` show the same document, and so does another tab.

Try it in the [playground](https://journey-to-code-org.github.io/zubra/playground/#example=sync): type a note, reload the page, and it's still there. The JavaScript tab shows the one line the directive adds, `$collection("notes", ["doc"], $p, { text })`.

## Nothing to run

That's the whole setup. The store is IndexedDB, and tabs hear each other's writes through `BroadcastChannel`. No server is involved, so it works offline from the start, and the server renders the defaults (`0 words`) until the stored document loads.

## Sharing between devices

To share documents, start a connection on the page and serve the log:

```js
import { connect } from '@zubra/sync/connect';
connect({ url: '/_zb/sync' });
```

```js
import { createSyncServer } from '@zubra/sync/server';
const sync = createSyncServer();
if (await sync.handle(req, res)) return;
```

The component doesn't change. Writes still land on the device first, go out when the network allows, and merge field by field: the later write wins, on every device alike. `presence()` and `peers()` add who else is looking at the same document.

[`examples/standup`](../../examples/standup/) is a whole app built this way, with a SQLite log, offline edits and presence. The [sync page](../sync.md) has the protocol, `authorize`, the stores, and the `zubra-sync` binary for servers without Node.

**Back to:** [the guide](README.md)
