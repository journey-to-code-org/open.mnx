---
name: mnx-cli
description: Run the mnx compiler from a shell or a build: check a component, compile it to HTML or JavaScript, publish a component library, copy in a registry component, convert a React component, migrate old code, or drive the compiler as a long-lived process from another language. Use for any `mnx …` or `npx mnx …` command.
---

Two binaries share the name. The **Rust CLI** (`mnx`, built with `cargo build --release` into `target/release/mnx`) does `check`, `compile`, `migrate`, `convert`, `request` and `serve`. The **npm CLI** (`npx mnx`, from `@mnx/compiler`, WebAssembly, no Rust) does all of those plus `build --lib` and `add`. In a project made by `npm create mnx`, use `npx mnx`. In this repository, `target/release/mnx` (or `cargo run --release --`).

## Commands

| | |
|---|---|
| `mnx check <file>... [--format json] [--server]` | Errors and warnings with carets and suggested fixes; exit 1 on an error. `--server` also reports every part the server can't render (an error for `checked`, `selected`, `value` and `disabled`). `--format json` for tooling. |
| `mnx compile <file>` | Server HTML. `--props props.json` gives prop values (required props need one); `--slots slots.json` gives slot content (`--slots-html` to keep it as HTML); `--partial` leaves browser-only parts empty instead of failing. |
| `mnx compile <file> --emit js` | The custom element module. `--framework react\|vue` emits the wrapper instead; `--emit dts\|manifest\|html-data\|interface\|css` the typings, Custom Elements Manifest, VS Code data, prop/event interface, or stylesheet. |
| `npx mnx build --lib <dir> [--out dist] [--name @acme/ui] [--version x.y.z] [--watch]` | A publishable package: an ES module per element, `react` and `vue` entries, typings, `custom-elements.json`, a `skills/` folder for agents, and `package.json` with `exports` and `@mnx/runtime` as a peer. |
| `npx mnx add <name>... [--dir src/components]`, `npx mnx add --list` | Copy a registry component (twenty-five tested, accessible ones) into the project to own. |
| `mnx convert <Component.jsx> [--prefix word] [--component Name] [--as mnx] [--out file]` | A React function component as an mnx JSX component next to it (`--as mnx` for the HTML-first file, once nothing is left to finish; `--component` picks one of several exports). Exit 1 and a report for what it can't convert: spread props, custom hooks, a context from another module, a third-party React primitive in the markup. |
| `mnx migrate <file>... [--to 3] [--check]` | Rewrite 1.x code for 2.0, or 2.x code for 3.0; `--check` only lists. |
| `mnx request < request.json`, `mnx serve` | The compiler as JSON: one request (or `{ "requests": [...] }`) in, one response out; `serve` keeps answering, one JSON line per request, for a server in any language. |

## Steps for common jobs

**Check a component**: `mnx check src/components/x.mnx` → read each error's caret line and `help:` → fix → re-run until `no errors`.

**Server HTML for a page in a non-Node server**: start one `mnx serve` per process (the Flask example keeps one behind a lock: `examples/backends/flask-garden/garden/mnx.py`). Per render, write one JSON line:

```json
{"command":"compile","emit":"html","path":"/c/price-tag.mnx","files":{"/c/price-tag.mnx":"<source>"},"props":{"cents":129900},"partial":true}
```

and read one line back: `{"ok":true,"output":"<price-tag …>…</price-tag>","warnings":"…"}`. `files` carries every `.mnx` the component imports, keyed by the paths the imports resolve to. Serve the browser the `js` output of each component the page used, and `@mnx/runtime`.

**Publish components**: `npx mnx build --lib src/components --out dist && cd dist && npm publish`. Consumers need no mnx tooling.

**Bring a React component in**: `npx mnx convert src/Thing.jsx`, read the report, finish what it names by hand, then `mnx check` the result.

## Reference

`mnx --help`; https://github.com/journey-to-code-org/open.mnx#the-cli, `#sharing-components`, `#moving-in-from-react`; the request format in the repository's `src/request.rs`.
