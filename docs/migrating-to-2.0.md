# Migrating to 2.0

2.0 changes three things for `.mnx` files, and nothing for JSX components (`.mnx.jsx`/`.mnx.tsx`), which have 2.0's semantics already. 1.7 warns about each one; `mnx migrate` does the only rewrite needed.

```sh
mnx migrate src/**/*.mnx --check    # what would change (exit status 1 if anything would)
mnx migrate src/**/*.mnx            # rewrite in place
```

## 1. Props are names in the script

In 2.0 a prop's name means the prop in the script, as it already does in the template: read `value`, assign `value = 2`. `props()` still works.

So a script binding can't share a prop's name. The usual case is a default taken from the script, which `mnx migrate` renames:

```html
<script>const title = "Hi"</script>            <script>const titleDefault = "Hi"</script>
<mnx-card title={title}>                 →     <mnx-card title={titleDefault}>
```

The binding and its uses in the script and in host defaults are renamed. In the template, `title` was already the prop. 1.7 warns: *in 2.0, props are names in the script, so the script's `title` will clash with the prop `title`*.

## 2. `let` is state

In 2.0 a top-level `let` in the script is state: assigning it updates the template, as `state()` does. `let count = 0` and `count++` in a handler is a counter. `state()` and `computed()` keep working.

Nothing needs rewriting. A `let` the script changes and the template reads starts updating it, which is almost always what was meant. `mnx migrate` and 1.7's warnings list each one so you can check.

## 3. The CLI is `mnx`

The CLI is `mnx` in 2.0. `mnix` stays as an alias through 2.x, so scripts keep working. 1.7 already installs both.

## What doesn't change

- The `.mnx` format otherwise, the HTML output, the hydration markers (DOM Parts hasn't settled on a serialization; see `docs/standards/dom-parts.md`) and the Signals API (the proposal's API hasn't changed).
- The adapters, the plugin, `@mnx/compiler` and the language server, apart from version numbers.
- Compiled code must match its runtime's major version: 2.0's runtime refuses modules compiled for 1.x with an error that says to recompile, instead of misbehaving.
