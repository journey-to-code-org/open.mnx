# 6. Async data

`resource(fetcher)` holds data that arrives later, as signals: `value`, `error`, `status` (`"pending"`, `"ready"` or `"error"`) and `loading`, plus `refresh()`.

```html
<script>
  import { resource } from '@zubra/runtime'

  const user = resource(({ signal }) =>
    fetch(`/api/users/${userId}`, { signal }).then((response) => response.json()))
</script>
<user-card user-id="1">
  <zb-await value={user}>
    <p>Loading…</p>
    <zb-then as="data"><h2>{data.name}</h2></zb-then>
    <zb-catch as="error"><p class="error">{error.message}</p></zb-catch>
  </zb-await>
</user-card>
```

- **It refetches by itself** when something it read changes: here the `userId` prop. The previous request is aborted (through `signal`), and so is the request in flight when the element is removed. An answer that arrives after a newer request started is dropped.
- **`<zb-await>`** shows its content while pending, `<zb-then>` with the value, and `<zb-catch>` with the error. It also takes a plain promise.
- While a refetch is pending, `value` keeps the previous result, so lists don't flash empty. Read `user.loading` to show a spinner beside them instead.

There are no effects to write and no dependency arrays: what the fetcher reads before its first `await` is what it depends on.

**Next:** [Server rendering](07-server-rendering.md)
