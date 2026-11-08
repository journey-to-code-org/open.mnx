# Parts in production: a usage report for DOM Parts and declarative templating

*Zubra 1.6, November 2026. For [WICG/webcomponents#1069](https://github.com/WICG/webcomponents/issues/1069) and the [DOM Parts](https://github.com/WICG/webcomponents/issues/1028) discussions. Neither has a spec yet. This is evidence from a compiler that already ships a parts model, about the shape of what it needed.*

## The model Zubra uses

Zubra compiles each component into a static template, plus a list of **parts**: the places in it that change, each with the expression that computes it. Part kinds are text, an attribute, a property, an event, and a **region** (conditional, list, list row, slot, or awaited value). The browser runtime clones the template, or, for server-rendered markup, walks the existing DOM by the same paths and binds each part to its node. Nothing is re-rendered on hydration, and a part writes only when its value differs.

This is the DOM Parts shape: a template, the parts within it, and values pushed to parts. Here is what we learned building it.

### 1. Server markup needs markers, and only four kinds

The HTML output (from the Rust compiler, or from `@zubra/compiler` in Node) marks:

| Marker | Up to 4.x | Meaning |
|---|---|---|
| `<?zb [?>` … `<?zb ]?>` | `<!--[-->` … `<!--]-->` | a region: a branch, a list, one list row |
| `<?zb [!?>` | `<!--[!-->` | a slot region holding content the caller supplied (left alone on hydration) |
| `<?zb [??>` | `<!--[?-->` | a region the server couldn't compute and left for the element (partial rendering) |
| `<?zb ?>` | `<!---->` | where a dynamic text node starts, when it has siblings |

Since 5.0 the markers are processing instructions, which HTML gained with out-of-order streaming (Chrome 150): minifiers, sanitizers and `parseHTMLUnsafe()` dropped comments, and keep these. Browsers that don't parse them yet make each a comment (`?zb [?`), which the runtime reads the same way. Nothing else is needed. In particular, text that is an element's only child is bound through the element, and attributes need no markers. The most important lesson: **paths must count only elements and markers**, because parsers merge adjacent text and drop empty text. A whole region counts as one position, so a list's length never shifts the paths after it. If DOM Parts serializes parts in markup, we'd ask for these properties, and Zubra 2.0 will emit that serialization if it has settled by then.

### 2. Regions are the hard part, not attributes

Most of the runtime's complexity is in regions:

- keyed list rows that move with `moveBefore()` (so focus, a half-typed input and iframes survive);
- branches that re-render only when the chosen branch changes;
- **light-DOM slots that frameworks keep managing**. React, Vue, Svelte, Solid and Lit call `insertBefore`/`removeChild` on the host, and those calls must be routed into the right region. Each framework's own markers (Lit's parts, Svelte's anchors) must also stay with their content.

A native parts API that covers attributes and text but not ranges of nodes would leave most of this in libraries. `ChildNodePart`-style ranges are the essential primitive.

### 3. Hydration needs a shape check

Before binding, the runtime compares the server markup's shape (top-level tags and region markers) with the template's. Markup that doesn't match is rendered fresh, with a warning; markup that matches is bound in place. Measured on 1,000 server-rendered rows, hydration costs about what a fresh render does (77 ms against 83 ms, `runtime/test/browser/bench.test.js`). Its value is keeping every node and no layout shift, not speed. A native "attach parts to existing DOM" operation is where a browser could beat libraries.

### 4. Signals, not re-rendering

#1069's tagged-template `html` evaluates its expressions eagerly. Several commenters noted the friction with signals, and we agree from practice. Zubra binds each part to a computation, which re-runs when the signals it reads change, so there is no re-render step to diff. A templating API that accepts a function (or a `Signal.Computed`) per part would serve compiled frameworks directly. One that requires re-calling the whole template would be bypassed.

### 5. HTML first

Zubra's canonical format is HTML (`.zb` files), with JSX lowered into it. The same template drives server rendering and hydration. The comment in #1069 preferring to move templating forward "on the HTML side rather than in JS" matches our experience: the declarative form is what lets the server render without running component code. Zubra's partial rendering shows the boundary. What the server can't compute becomes a `<!--[?-->` region for the client.

## Reproducing

```sh
cargo build && cd runtime && npm ci && npm run test:browser   # regions.test.js, keyed.test.js, slots.test.js, bench.test.js
```
