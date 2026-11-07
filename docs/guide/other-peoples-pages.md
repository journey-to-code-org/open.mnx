# mnx on other people's pages

A widget that runs on pages you don't control (an embed, a browser extension's content script, a third-party script) meets rules your own pages don't have. `examples/extension/page-notes/` is a working example of each of these.

## Shadow DOM, and make the host's rules `!important`

Use `shadow` on the host, so the page's CSS can't restyle what's inside and yours can't touch the page.

The host element itself is in the page, though:
- a page's `* { font-family: Georgia !important }` matches it and beats your `:host` rules;
- inherited properties (font, colour, line height) then flow into your shadow root.

`all: initial` in `:host` isn't enough on its own: the host's rules have to be `!important`, because across a shadow boundary the inner `!important` wins. `host-reset` on the host does both:

```html
<style>
  :host { position: fixed; font: 14px/1.4 system-ui, sans-serif; color: #1d2130; }
</style>
<my-widget shadow host-reset>…</my-widget>
```

The host starts from `all: initial`, and each declaration in a top-level `:host` rule becomes `!important`.

## Content scripts can't define elements

In a Chrome extension's content script (its isolated world), `customElements` is `null`. Run the part that defines and renders elements in the page's own world (`"world": "MAIN"` in the manifest). Keep a second content script in the isolated world for `chrome.*` APIs, and pass data between them as JSON text in DOM events.

The page can see and send those events too, so treat what arrives as untrusted:
- parse it, and display it as text (mnx escapes text and attributes);
- never use it as markup;
- let a "hide" or "delete" from the page do only what the page could do anyway.

## Tag names

Your tags share one registry with the page's. Prefix them with something specific (`page-notes-widget`, not `note-widget`), and don't load a second copy of the same element. If the page already defined your tag, the first definition stands and yours is silently not used.

## Custom elements and tables

The HTML parser moves a custom element out of a `<table>`, `<tbody>` or `<tr>`, so an element can't be a table row or cell. Keep the `<tr>` and `<td>` in the page's template, and put components inside the cells (`examples/hypermedia/hono-bikes/`). Customized built-ins (`<tr is="my-row">`) would solve it, but Safari doesn't support them.
