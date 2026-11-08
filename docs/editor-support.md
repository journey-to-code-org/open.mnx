# Editor support

Zubra has a VS Code extension, and a language server that any editor with Language Server Protocol support can use.

## VS Code

Install **Zubra** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=JourneytoCode.zubra), or run `code --install-extension JourneytoCode.zubra`. It gives you:

- **Syntax highlighting** for `.zb` files: HTML, `{…}` as JavaScript, `<script>` and `<script lang="ts">` as JavaScript and TypeScript, `<style>` and `<style lang="scss">` as CSS and SCSS, and the directives and event attributes.
- **Diagnostics as you type**: the compiler's own errors and warnings, with their suggestions.
- **Completion** of directives, imported components, their props and events, and of props inside `{…}`.
- **Hover** documentation for imported components: description, props with types and defaults, events and slots.
- **Go to definition** for imported components.

Highlighting works on its own. The rest needs the compiler, which the extension looks for in this order:

1. The `zubra.compiler` setting: a path to the `zubra` command.
2. `@zubra/compiler` (WebAssembly) installed in your workspace: `npm i -D @zubra/compiler`.
3. `zubra` on your `PATH`.

A project made with `npm create zubra@latest` already has `@zubra/compiler`.

## Other editors

The extension is a thin client for `@zubra/language-server`. Run it with `zubra-language-server --stdio` from Neovim, Helix, Zed, Sublime LSP or any other editor that speaks LSP. It uses `@zubra/compiler` when it's installed, or the `zubra` command, or the one named in `initializationOptions.compiler`.

## `.html` files that use Zubra elements

`zubra compile x.zb --emit html-data` writes VS Code HTML custom data. Point the `html.customData` setting at it and the editor completes your tags and attributes in plain HTML and documents them on hover.
