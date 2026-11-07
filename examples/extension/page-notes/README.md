# Page Notes: a Chrome extension

Notes for each site, as a Manifest V3 extension. mnx components appear in three very different
places:

- **the toolbar popup**: the active site's notes, and a box to add one (`note-list`,
  `note-composer`, with the registry's `color-swatches`);
- **the options page**: the widget on or off, the default colour, sites it's hidden on, and
  export (the registry's `toggle-switch` and `color-swatches`);
- **the pages themselves**: a small widget in the corner of sites that have notes
  (`page-notes-widget`, in shadow DOM).

The service worker keeps the toolbar badge at the active site's note count.

```sh
cargo build                 # from the repository root (the compiler, until @mnx/compiler is on npm)
cd examples/extension/page-notes
npm install
npm run build               # → dist/
```

Then open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and pick `dist/`.
`npm run watch` rebuilds as you edit; reload the extension to pick it up.

`build.mjs` is esbuild with mnx's esbuild plugin (`@mnx/unplugin/esbuild`):
- the popup, options and service worker are ES modules;
- content scripts can't be ES modules, so they're bundled as IIFEs.

The tests load `dist/` into Playwright's Chromium, next to a test site whose CSS tries to
restyle everything.

## What it found

- **Custom elements don't exist in a content script's world.** In the isolated world that
  content scripts run in, `customElements` is `null`, so no element can be defined there. The
  widget therefore runs in the page's own world (`"world": "MAIN"`), and a second content
  script, the bridge, stays in the isolated world for `chrome.storage`. They talk through DOM
  events with JSON in `detail`. The page can see and send those events too, so the widget only
  displays what it gets, as text (mnx escapes it). A test sends it markup.
- **Shadow DOM protects what's inside, not the host.** The host element lives in the page. A
  site's `* { font-family: … !important }` matches it and beats `:host` rules, and the font then
  inherits into the shadow root. The fix is `!important` in `:host`, which wins across a shadow
  boundary. `all: initial` alone isn't enough. Any mnx component meant for other people's pages
  needs this, which suggests a `host-reset` option, or a documented pattern.
- **A CSP without `eval` is fine.** MV3 forbids `eval` and inline scripts on extension pages.
  mnx compiles ahead of time and its runtime has no `eval`, so nothing needed changing.
- **No parent-side binding between mnx components.** Frameworks bind a `:model` prop with
  `v-model` or `bind:`. Inside an mnx template, a parent writes
  `value={color} onvaluechange={(event) => (color = event.detail)}`. (`value:model={color}` on
  the child is an error: it declares a model, it doesn't bind one.)
- **A plugin bug, fixed in this release:** under esbuild (and Bun), unplugin's `this.error()`
  records the error instead of throwing it. When `load` then returned nothing, unplugin
  discarded the error, and esbuild reported "Do not know how to load path" or a `TypeError`
  instead of the compiler's message. The plugin now always throws.
