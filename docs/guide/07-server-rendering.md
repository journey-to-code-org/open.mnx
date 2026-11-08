# 7. Server rendering

Every component also compiles to HTML: the same markup the element would render, so the page shows content before any JavaScript runs. When the script loads, the element checks that the markup has its template's shape and **binds to it in place**. Nothing is re-rendered, and a part writes to the DOM only when its value differs.

## In a framework

- **Astro**: add `@zubra/unplugin/astro` to the integrations (`npm create zubra -- --framework astro` does). Components render on the server, and a client directive (`client:load`, `client:visible`, …) hydrates one in the browser.
- **SvelteKit, Nuxt, React Router, SolidStart**: the framework renders the element's tag, and `@zubra/server` adds its shadow root to the page. Use `shadow` components there.

  ```js
  // SvelteKit: src/hooks.server.js
  import { createZubra } from '@zubra/server';
  const Zubra = createZubra({ components: 'src/components' });
  export const handle = ({ event, resolve }) => resolve(event, { transformPageChunk: ({ html }) => Zubra.injectShadowRoots(html) });
  ```

  The page is complete before JavaScript, and form controls submit their server-rendered values (`examples/meta/` has each framework).
- **Next.js**: import `.zb` files through the Turbopack loader, with its server rule (`options: { server: true }`, see the README). The React wrapper then writes each shadow-DOM element's shadow root into the server's HTML, for elements without React children.

## In your own server

`@zubra/server` works with any template engine (Express, Fastify and Hono have adapters):

```js
import { createZubra } from '@zubra/server';
const zubra = createZubra({ components: 'src/components' });

// per request
if (zubra.handle(req, res)) return;               // the browser modules and @zubra/runtime
const page = zubra.page();
const card = page.render('user-card', { user }); // HTML, inside your template
res.end(page.finish(myLayout(card)));            // + the components' CSS and module scripts
```

The component's script runs on the server too, as far as it's deterministic: `.map()`, `.filter()`, `toFixed()`, `Math`, template literals, and arrow functions from the script. What only the browser can compute (a handler, `Date`, `Intl`, a value from `fetch`) is left for the element: its text renders empty and its region renders when the element starts, without a hydration warning. `zubra check --server` lists those places.

## From the command line

```sh
zubra compile src/components/user-card.zb --props props.json --partial > card.html
```

That's the end of the tutorial. The [README](../../README.md) has every feature in detail, and the [playground](https://journey-to-code-org.github.io/zubra/playground/) is the quickest way to try one.
