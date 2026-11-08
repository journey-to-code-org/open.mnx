# Migrating to 5.0: the platform's markers

5.0 changes one thing: the server markup's hydration markers. They were comments and are now processing instructions, which HTML gained with out-of-order streaming in Chrome 150. Components, their source and every API are the same as 4.3.

| | 4.x | 5.0 |
|---|---|---|
| A region | `<!--[-->` … `<!--]-->` | `<?zb [?>` … `<?zb ]?>` |
| A region left to the browser | `<!--[?-->` | `<?zb [??>` |
| Supplied slot content | `<!--[!-->` | `<?zb [!?>` |
| Before dynamic text | `<!---->` | `<?zb ?>` |
| A streamed region | `<template data-zb-swap>` and a script | `<?start name="zb-0-0"?>`…`<?end?>`, `<template for="zb-0-0">` and a script |
| The compiled code's interface | `abi: 2` | `abi: 3` |

## What it fixes

- **Minifiers keep the markers.** html-minifier-terser's `removeComments` removed comment markers; it keeps processing instructions. `ignoreCustomComments: [ZUBRA_MARKER_COMMENT]` isn't needed for 5.0 markup.
- **htmx keeps them.** htmx parses fragments with `Document.parseHTMLUnsafe()`, which drops comments in Chromium 153, so 4.x needed `delete Document.parseHTMLUnsafe`. It keeps processing instructions.
- **Streaming works without JavaScript in Chrome and Edge.** A browser with out-of-order streaming puts a streamed region in place itself. The inline script still runs: it hands the element the value, and puts the region in place where the browser didn't (other browsers, and shadow roots, which a `<template for>` can't reach).

## In every browser

Chrome and Edge 150+ parse `<?zb [?>` as a `ProcessingInstruction` node. Firefox and Safari, until they ship it, parse it as a comment (`<!--?zb [?-->`). The runtime reads both, so 5.0 markup hydrates everywhere. A minifier works on the markup before any browser parses it, so it keeps the markers for every browser.

## Updating

Update the packages together: `@zubra/runtime`, `@zubra/compiler`, `@zubra/unplugin`, `@zubra/server`, and the `zubra` crate or CLI. There's no change to make in components.

The order doesn't matter much:

- **A 5.0 runtime reads 4.x markup.** It still reads the comment markers, for all of 5.x, so a 4.x server (or HTML cached from one) keeps hydrating.
- **A 5.0 runtime runs modules compiled by 4.x** (`abi: 2`): their shape is the same.
- **A 4.x runtime refuses modules compiled by 5.0** (`abi: 3`), with an error that says to update it, because it can't read 5.0's markers. Without that check it would render every element fresh.
- **A library built with `zubra build --lib`** declares `@zubra/runtime` `^4.x` as a peer until it's rebuilt with 5.0 (`^5.0.0`). It runs on 5.0, so `overrides` works until then.

## If you post-process the HTML

- **Code that looks for the markers** (a test that counts `<!--[?-->`, a script that walks comments) should look for `<?zb ` too, or walk `NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_COMMENT`.
- **A sanitizer that removes processing instructions** (DOMPurify does) removes the markers. The element then puts them back by structure, as since 2.10, and renders fresh where it can't, with a warning.
- **`ignoreCustomComments: [ZUBRA_MARKER_COMMENT]`** can stay; it's harmless, and still keeps a 4.x server's markers.
