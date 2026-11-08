# Editor support

- **`language-server/`**: `@zubra/language-server`, a Language Server Protocol server for `.zb` files. It gives diagnostics as you type (the compiler's own errors and warnings, with their suggestions), completion of directives, imported components, their props and events, and of props inside `{…}`; hover documentation for imported components (description, props with types and defaults, events, slots); and go to definition for imported components. It uses `@zubra/compiler` (WebAssembly) when installed, or the `zubra` CLI (or the one in `initializationOptions.compiler`). Run it with `zubra-language-server --stdio` from any LSP-capable editor (Neovim, Helix, Zed, Sublime LSP, …).
- **`vscode/`**: the VS Code extension. A TextMate grammar for `.zb` (HTML, with `{…}` as JavaScript, `<script>`/`<script lang="ts">` as JavaScript/TypeScript, `<style>`/`<style lang="scss">` as CSS/SCSS, directives and event attributes highlighted), language configuration, and the language server. The `zubra.compiler` setting points at a CLI if you don't use `@zubra/compiler`.

For `.html` files that use Zubra elements, `zubra compile x.zb --emit html-data` writes VS Code HTML custom data (`html.customData`), with tag and attribute completion and docs.

Tests: `npm test` in each package. The language server is tested over real LSP (JSON-RPC on stdio), and the grammar with `vscode-textmate` and Oniguruma, the engine VS Code uses.

Packaging the extension (`npx @vscode/vsce package`) and publishing it to the Marketplace needs a publisher account; `publisher` in `vscode/package.json` must match it.
