# 6. Async data

`resource(fetcher)` holds data that arrives later, as signals: `value`, `error`, `status` (`"pending"`, `"ready"` or `"error"`) and `loading`, plus `refresh()`.

```html
<script>
  import { resource } from '@mnx/runtime'

  const user = resource(({ signal }) =>
    fetch(`/api/users/${userId}`, { signal }).then((response) => response.json()))
</script>
<user-card user-id="1">
  <mnx-await value={user}>
    <p>Loading…</p>
    <mnx-then as="data"><h2>{data.name}</h2></mnx-then>
    <mnx-catch as="error"><p class="error">{error.message}</p></mnx-catch>
  </mnx-await>
</user-card>
```

- **It refetches by itself** when something it read changes: here the `userId` prop. The previous request is aborted (through `signal`), and so is the request in flight when the element is removed. An answer that arrives after a newer request started is dropped.
- **`<mnx-await>`** shows its content while pending, `<mnx-then>` with the value, and `<mnx-catch>` with the error. It also takes a plain promise.
- While a refetch is pending, `value` keeps the previous result, so lists don't flash empty. Read `user.loading` to show a spinner beside them instead.

There are no effects to write and no dependency arrays: what the fetcher reads before its first `await` is what it depends on.

**Next:** [Server rendering](07-server-rendering.md)
