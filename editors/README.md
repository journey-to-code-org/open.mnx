# Editor support

- **`language-server/`**: `@zubra/language-server`, a Language Server Protocol server for `.zb` files. It gives diagnostics as you type (the compiler's own errors and warnings, with their suggestions), completion of directives, imported components, their props and events, and of props inside `{…}`; hover documentation for imported components (description, props with types and defaults, events, slots); and go to definition for imported components. It uses `@zubra/compiler` (WebAssembly) when installed, or the `zubra` CLI (or the one in `initializationOptions.compiler`). Run it with `zubra-language-server --stdio` from any LSP-capable editor (Neovim, Helix, Zed, Sublime LSP, …).
- **`vscode/`**: the VS Code extension. A TextMate grammar for `.zb` (HTML, with `{…}` as JavaScript, `<script>`/`<script lang="ts">` as JavaScript/TypeScript, `<style>`/`<style lang="scss">` as CSS/SCSS, directives and event attributes highlighted), language configuration, and the language server. The `zubra.compiler` setting points at a CLI if you don't use `@zubra/compiler`.

For `.html` files that use Zubra elements, `zubra compile x.zb --emit html-data` writes VS Code HTML custom data (`html.customData`), with tag and attribute completion and docs.

Tests: `npm test` in each package. The language server is tested over real LSP (JSON-RPC on stdio), and the grammar with `vscode-textmate` and Oniguruma, the engine VS Code uses.

Packaging: `npm run package` in `vscode/` builds `zubra-<version>.vsix`. It packs a copy that depends on the published `@zubra/language-server` of the same version (the repo's own `file:` dependency can't go in a .vsix) and fails if the server didn't make it into the package. Publishing to the Marketplace needs a publisher account whose id matches `publisher` in `vscode/package.json` (`JourneytoCode`), then `npx @vscode/vsce publish` with a personal access token, or upload the .vsix by hand at marketplace.visualstudio.com/manage.

Editors that aren't Microsoft's VS Code (VSCodium, Cursor, Windsurf, Gitpod and others) read extensions from [Open VSX](https://open-vsx.org), a separate registry. The same `.vsix` works there: create an account, claim a namespace named after the publisher (`JourneytoCode`) and make an access token, then `npx ovsx publish zubra-<version>.vsix -p <token>`. It hasn't been published there yet.
