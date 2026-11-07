# 7. Server rendering

Every component also compiles to HTML: the same markup the element would render, so the page shows content before any JavaScript runs. When the script loads, the element checks that the markup has its template's shape and **binds to it in place**. Nothing is re-rendered, and a part writes to the DOM only when its value differs.

## In a framework

- **Astro**: add `@mnx/unplugin/astro` to the integrations (`npm create mnx -- --framework astro` does). Components render on the server, and a client directive (`client:load`, `client:visible`, …) hydrates one in the browser.
- **Nuxt, SvelteKit, Next**: the framework renders the element's tag and children on the server, and the element renders its template in the browser.

## In your own server

`@mnx/compiler` renders from Node, without Rust:

```js
import { render } from '@mnx/compiler';

const { html, css } = render('src/components/user-card.mnx', {
  props: { userId: '1' },
  slots: { default: '<p>Already rendered by your server</p>' },
});
```

What only the browser can compute (a handler, a value from `fetch`, `Date.now()`) is left for the element: its text renders empty and its region renders when the element starts, without a hydration warning.

## From the command line

```sh
mnx compile src/components/user-card.mnx --props props.json --partial > card.html
```

That's the end of the tutorial. The [README](../../README.md) has every feature in detail, and the [playground](https://journey-to-code-org.github.io/open.mnx/) is the quickest way to try one.
