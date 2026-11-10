# Editor support

Zubra has a VS Code extension, and a language server that any editor with Language Server Protocol support can use.

## VS Code

Install **Zubra** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=JourneytoCode.zubra), or run `code --install-extension JourneytoCode.zubra`. It gives you:

- **Syntax highlighting** for `.zb` files: HTML, `{…}` as JavaScript, `<script>` and `<script lang="ts">` as JavaScript and TypeScript, `<style>` and `<style lang="scss">` as CSS and SCSS, and the directives and event attributes.
- **Diagnostics as you type**: the compiler's own errors and warnings, with their suggestions.
- **Completion** of directives, imported components, their props and events, and of props inside `{…}`.
- **Hover** documentation for imported components: description, props with types and defaults, events and slots.
- **Go to definition** for imported components.
- **Formatting**: Format Document (Shift+Alt+F), or on save with `"editor.formatOnSave": true`. It's `zubra fmt` with your editor's indentation: the template re-indented, tags tidied, and a tag too wide for its line split one attribute per line (`zubra.format.printWidth`, default 100). It never changes what the component compiles to, and leaves expressions, comments, `<script>`, `<style>`, `<pre>` and `<textarea>` as written (see [Formatting](../README.md#formatting)). The extension is the default formatter for `.zb`. To have `<script>` and `<style>` formatted too, use Prettier with [`prettier-plugin-zubra`](../prettier-plugin/README.md). Needs Zubra 5.4 or later; with an older compiler it says so once and changes nothing.
- **Format Selection** (and `"editor.formatOnPaste": true`): formats the lines the selection touches, exactly as Format Document would write them in the whole file, and nothing else. Needs a Zubra compiler with `formatRange` (5.5 or later).

Highlighting works on its own. The rest needs the compiler, which the extension looks for in this order:

1. The `zubra.compiler` setting: a path to the `zubra` command.
2. `@zubra/compiler` (WebAssembly) installed in your workspace: `npm i -D @zubra/compiler`.
3. `zubra` on your `PATH`.

A project made with `npm create zubra@latest` already has `@zubra/compiler`.

## In the browser: Zubra DevTools

A pane in the Elements panel of Chrome, Edge and Firefox. Select a node: it shows the component's `.zb` file and line (click to open it in your editor), its props and state by name, and each binding as the DOM operation it performs, with its line and the signals it reads; and after a change, what was written and which bindings re-ran. It reads the development build `@zubra/unplugin` makes in Vite's dev server; production builds carry none of it. Install and details: [editors/devtools](../editors/devtools/README.md).

## Other editors

The extension is a thin client for `@zubra/language-server`. Run it with `zubra-language-server --stdio` from Neovim, Helix, Zed, Sublime LSP or any other editor that speaks LSP. It uses the compiler named in `initializationOptions.compiler` if there is one; otherwise `@zubra/compiler` when it's installed, then the command in the `ZUBRA_COMPILER` environment variable, then `zubra` on the `PATH`.

## `.html` files that use Zubra elements

`zubra compile x.zb --emit html-data` writes VS Code HTML custom data. Point the `html.customData` setting at it and the editor completes your tags and attributes in plain HTML and documents them on hover.
