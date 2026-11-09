# 9. Forms that post to the server

[Forms](05-forms.md) made elements that are real form controls. This chapter sends a form somewhere: to a function on your server, written in the component, that works with or without JavaScript. It needs [`@zubra/actions`](../actions.md) on the server (`npm install @zubra/actions`).

## A function marked `'use server'`

```html
<!-- newsletter-signup.zb -->
<script>
  import { subscribers } from '../subscribers.js';   // only subscribe() uses it

  let message = '';

  export async function subscribe(formData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    if (!email.includes('@')) return { error: "That doesn't look like an email address" };
    await subscribers.add(email);
    return { ok: true };
  }
</script>

<newsletter-signup>
  <form action={subscribe} onaction={(event) => (message = event.detail.value?.error ?? 'Thanks for subscribing!')}>
    <input name="email" type="email" required aria-label="Email" />
    <button>Subscribe</button>
  </form>
  <p>{message}</p>
</newsletter-signup>
```

Open it in the [playground](https://journey-to-code-org.github.io/zubra/playground/#example=actions) and look at three tabs:

- **JavaScript.** `subscribe` is now `const subscribe = "/_zb/action/newsletter-signup/subscribe";`. The function, its error message and `subscribers.js` are gone. The browser gets a URL, never the code.
- **HTML.** The form is `<form action="/_zb/action/newsletter-signup/subscribe" method="post">`: a plain form that posts without JavaScript.
- **Server.** The other half, from `zubra compile newsletter-signup.zb --emit server`: the import, the function, and a map from its URL to it.

The playground has no server, so submitting the form there shows what would be posted.

## Serving it

```js
import { createActions } from '@zubra/actions';
const actions = await createActions({ components: 'components' });

// in your Node request handler, before your own routes
if (await actions.handle(req, res)) return;
```

Hono, Express and Fastify have adapters. Put `actions.script()` on the page, and a submit becomes a `fetch`: the form gets `aria-busy` while it's in flight, then the `action` event with the function's return value, which is what `onaction` above reads. Without JavaScript, the browser's own post goes to the same URL and comes back to the page with a `303`, and the server reads the result once, with `actions.result(request)`.

## What to keep in mind

- **It's an HTTP endpoint.** Validate the `FormData` in the function. `required` and `type="email"` help people fill in the form; they don't protect the server.
- **Only `'use server'` functions can be exported** from a component script, and only they get URLs.
- **Cross-site posts are refused,** and a thrown error is never shown to the browser.

[`examples/helpdesk`](../../examples/helpdesk/) answers tickets this way. The [actions page](../actions.md) has the whole contract: redirects, context such as the signed-in user, and the adapters.

**Next:** [State that lives on the device](10-local-state.md).
