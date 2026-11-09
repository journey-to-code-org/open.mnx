# Actions: forms that post to server functions

A component can export a function marked `'use server'`. Its form posts to it, with or without JavaScript, and the function's code never reaches the browser.

```html
<!-- login-form.zb -->
<script>
  import { users } from '../users.js';   // only the server function uses it: it stays on the server

  let message = '';

  export async function login(formData) {
    'use server';
    const email = formData.get('email');
    if (!(await users.has(email))) return { error: 'Invalid login' };
    return { ok: true };
  }
</script>

<login-form>
  <form action={login} onaction={(event) => (message = event.detail.value?.error ?? 'Welcome')}>
    <input name="email" type="email" required />
    <button>Log in</button>
    <p>{message}</p>
  </form>
</login-form>
```

## What the compiler writes

Read the output; it's the whole mechanism.

- **The HTML and the template** get a plain form: `<form action="/_zb/action/login-form/login" method="post">`. `method="post"` is added unless you write a method yourself.
- **The browser module** has `const login = "/_zb/action/login-form/login";` where the function was. The function, the `'use server'` string and `users.js` are gone. The script can still use the name (`fetch(login, …)`).
- **`zubra compile login-form.zb --emit server`** writes the server half: the imports the function needs, the function, and `actions`, which maps its URL to it.

Only a `'use server'` function can be exported from a component script; any other `export` is an error.

## Serving them: `@zubra/actions`

```js
import { createActions } from '@zubra/actions';
const actions = await createActions({ components: 'components' });

// Node's http
if (await actions.handle(req, res)) return;
// fetch-style servers (Bun, Deno, workers)
const response = await actions.fetch(request);
```

Or an adapter: `@zubra/actions/hono` (`app.use(await actions(options))`), `@zubra/actions/express` (mount it before any body parser), `@zubra/actions/fastify` (`app.register(actions, options)`).

Put `actions.script()` on pages with action forms. It's a small module that sends those forms with `fetch` instead of navigating.

## The contract

It's HTTP, so any server can implement it, and `curl` can call an action.

| | With JavaScript | Without |
|---|---|---|
| Request | `fetch(action, { method: 'POST', body: new FormData(form), headers: { accept: 'application/json' } })` | the browser's own post, same body |
| Response | `200` with the return value as JSON (`500` with `{ "error": … }` if the function threw) | `303 See Other` back to the page it came from, with the result in a one-use cookie |
| In the page | the form fires `action` with `detail: { value }` (or `{ error, status }`) | the server reads `actions.result(request)` and renders it |

- The function receives the `FormData` and `{ request }`, plus whatever `createActions({ context })` returns for the request: `context: ({ request, req, c }) => ({ user: req.user, db })`, where `req` is Node's request (so what an auth middleware put on it is there; mount that middleware first) and `c` is Hono's context. If it returns a `Response`, that response is sent as it is (a redirect after success, say).
- While a request is in flight the form has `aria-busy="true"`, so CSS can show it: `form[aria-busy="true"] button { opacity: .5 }`.
- `beforeaction` fires first and is cancelable (`detail: { formData }`).
- A form opts out of the script with `data-zb-native`. Forms in a shadow root aren't seen by the document's listener; call `enhance(shadowRoot)` from `@zubra/actions/client`.

## Without JavaScript

The page the form came from gets the result back once:

```js
const done = actions.result(req, (name, value) => res.setHeader(name, value)); // clears the cookie
// done: { action: '/_zb/action/login-form/login', value: { error: 'Invalid login' } } or null
page.render('login-form', { message: done?.value?.error ?? '' });
```

The adapters do this for you: `c.get('zubraAction')` (Hono), `res.locals.zubraAction` (Express), `request.zubraAction` (Fastify). A result bigger than a cookie holds (about 4 KB) reaches only the JavaScript path.

## Security

- **Cross-site posts are refused** (by `Sec-Fetch-Site`, or `Origin` when that's missing), so a form on another site can't call an action with your users' cookies. Allow more origins with `origins: [...]`.
- **The client never decides anything.** A server function validates its `FormData` like any endpoint: the form's `required` and `type="email"` are conveniences, not checks.
- **A thrown error is never shown.** The client gets a generic error; `onError(error, request)` gets the real one.
- **Unknown actions are 404**, and only `'use server'` functions have URLs.

## Limits, for now

- Endpoints live at `/_zb/action/`; mounting an app under a sub-path isn't configurable yet.
- An import that a server function uses and that only the *template* (not the script) also uses is dropped from the browser module. Use it in the script, or import it twice.
