# Zubra for VS Code

Language support for [Zubra](https://journey-to-code-org.github.io/zubra/): `.zb` files are HTML with a script and styles, compiled to standard web components.

- **Syntax highlighting** for `.zb`: HTML, `{…}` as JavaScript, `<script>` and `<script lang="ts">` as JavaScript and TypeScript, `<style>` and `<style lang="scss">` as CSS and SCSS, and Zubra's directives and event attributes.
- **Diagnostics as you type**: the compiler's own errors and warnings, with their suggestions ("did you mean `count`?").
- **Completion** of directives, imported components, their props and events, and of props inside `{…}`.
- **Hover** documentation for imported components: description, props with types and defaults, events and slots.
- **Go to definition** for imported components.

## Requirements

Diagnostics and completion use the Zubra compiler. The extension finds it in this order:

1. The `zubra.compiler` setting, a path to the `zubra` command.
2. `@zubra/compiler` (WebAssembly) installed in your workspace: `npm i -D @zubra/compiler`.
3. `zubra` on your `PATH`.

Highlighting needs none of them.

## Learn more

- [Documentation](https://journey-to-code-org.github.io/zubra/docs/) and the [playground](https://journey-to-code-org.github.io/zubra/playground/), which runs in the browser.
- `npm create zubra@latest` starts a project.
- [Source](https://github.com/journey-to-code-org/zubra/tree/main/editors/vscode) and [issues](https://github.com/journey-to-code-org/zubra/issues).
