# 6. Async data

`resource(fetcher)` holds data that arrives later, as signals: `value`, `error`, `status` (`"pending"`, `"ready"` or `"error"`) and `loading`, plus `refresh()`, and `dispose()` to stop it early (it stops with the element anyway).

```html
<script>
  import { resource } from '@zubra/runtime'

  const user = resource(({ signal }) =>
    fetch(`/api/users/${userId}`, { signal }).then((response) => response.json()))
</script>
<user-card user-id="1">
  <zb-await {user} delay={200} keep>
    <zb-pending><p>Loading…</p></zb-pending>
    <zb-then as="{ name, email }"><h2>{name}</h2><p>{email}</p></zb-then>
    <zb-catch as="{ message }"><p class="error">{message} <button onclick={retry}>Try again</button></p></zb-catch>
  </zb-await>
</user-card>
```

- **It refetches by itself** when something it read changes: here the `userId` prop. The previous request is aborted (through `signal`), and so is the request in flight when the element is removed. An answer that arrives after a newer request started is dropped.
- **`<zb-await>`** shows `<zb-pending>` while pending, `<zb-then>` with the value, and `<zb-catch>` with the error. `<zb-await {user}>` is short for `value={user}`. It also takes a plain promise, or an array of promises and resources, which it waits for together.
- **No flashing.** `delay={200}` shows the pending content only if the answer takes longer than 200 ms. `keep` holds the old content while a refetch runs, instead of showing the pending content again, and the element matches `:state(loading)` meanwhile: `user-card:state(loading) { opacity: 0.6 }`.
- **`as` can destructure:** `as="{ name, email }"`, or `as="[user, posts]"` for an array.
- **`retry()`** in `<zb-catch>` fetches again.

There are no effects to write and no dependency arrays: the props and state the fetcher reads are what it depends on, after an `await` as well as before it.

```html
<script>
  import { resource } from '@zubra/runtime'
  let page = 1

  const list = resource(async ({ signal }) => {
    const token = await getToken()
    const response = await fetch(`/api/${org}/items?page=${page}`, { signal, headers: { token } })
    return response.json()
  })
</script>
```

Here `org` and `page` are read after the first `await`. The Signals API only notices reads while it is running the fetcher, which ends at that `await`, so the compiler writes those two reads as `$run.track(() => …)` (read the output to see it). A value read in another module after an `await`, a store's getter for instance, isn't followed unless it goes through `track()` too. This part is experimental (`@zubra/runtime/track`).

**Next:** [Server rendering](07-server-rendering.md)
