# Zubra DevTools

A **Zubra** pane in the browser's Elements panel (Chrome, Edge, Firefox). Select any node a Zubra component renders, and it shows:

- **The component**: its host tag and its `.zb` file and line. Click it to open the file there in your editor.
- **Props and state**, by the names in the script, with their current values.
- **Bindings**: those on the selected node first, then the rest of the component. Each is named as the DOM operation it performs (`textContent = …`, `setAttribute('value', …)`, `classList.toggle('done', …)`, `addEventListener('click', …)`), with the `.zb` line that wrote it and the named signals it reads (`count`, `items[0].done`). That's what the compiled output does, which is the platform you're learning.
- **What a parent binds onto a child**, when the selected node is a component's host.
- **The last update**: what was written, and which bindings re-ran (marked *ran*).

It's read-only, and it follows the page: it re-reads when the selection changes and when the page updates.

## What it needs

A development build. `@zubra/unplugin` makes one in Vite's dev server: it compiles each component with `--devtools` (which records the source lines and names) and Vite serves the runtime's development build (which has the hook). "Open in editor" goes through Vite's own `/__open-in-editor`, so it opens the editor it finds running (set `LAUNCH_EDITOR`, for instance to `code`, to choose one).

Outside Vite, compile with `zubra compile x.zb --emit js --devtools` and import `@zubra/runtime` without the `production` condition. An ordinary build still shows the component, its props and its bindings, without lines or the script's names.

A production build has none of it: the compiler adds nothing without the flag, and the runtime's `production` build has no hook.

## How it reads the page

Through `globalThis.__ZUBRA_DEVTOOLS__`, which the runtime's development build defines (`runtime/src/devhook.js` records; `runtime/src/devtools.js`, loaded when the pane connects, reads). The pane calls `inspectedWindow.eval` with `$0`, the selected node, and gets plain JSON back. No content script, no permissions, nothing sent anywhere. Dependencies come from `Signal.subtle.introspectSources`, the Signals proposal's own introspection, so the view is the same on the polyfill and on a native `Signal`.

## Install

Until it's in the stores, load it unpacked from this folder:

- **Chrome or Edge**: open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose **Load unpacked**, and pick `editors/devtools`.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick `editors/devtools/manifest.json`.

Then open DevTools on your app, select an element, and find **Zubra** beside Styles and Computed.

To package it for a store: `cd editors/devtools && zip -r ../zubra-devtools.zip . -x 'test/*' package.json README.md`.

## Tests

`npm test` here checks the manifest and the pane's rendering. The pane against a live page, with the runtime's hook, runs with the runtime's browser suite (`runtime/test/browser/devtools.test.js`).
