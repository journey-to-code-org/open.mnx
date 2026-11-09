# @zubra/sync

Local-first state for Zubra components. `'use collection tasks'` at the top of a component's script makes its top-level `let`s the fields of a document in IndexedDB, keyed by the `doc` prop. Writes are signal assignments, so the UI never waits; state survives reloads and works offline; other elements and tabs showing the same document follow.

```html
<script>
  'use collection tasks';
  import { ephemeral } from '@zubra/sync';
  let completed = false;            // stored
  let editing = ephemeral(false);   // not stored
</script>
<task-item doc="">…</task-item>
```

`<task-item doc="t42">` is the document `tasks/t42`. This is tier 0 of the design (one device, no server); see [docs/sync.md](https://github.com/journey-to-code-org/zubra/blob/main/docs/sync.md).
