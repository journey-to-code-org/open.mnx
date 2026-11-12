# Zubra for VS Code

Language support for [Zubra](https://journey-to-code-org.github.io/zubra/): `.zb` files are HTML with a script and styles, compiled to standard web components.

- **Syntax highlighting** for `.zb`: HTML, `{…}` as JavaScript, `<script>` and `<script lang="ts">` as JavaScript and TypeScript, `<style>` and `<style lang="scss">` as CSS and SCSS, and Zubra's directives and event attributes.
- **Diagnostics as you type**: the compiler's own errors and warnings, with their suggestions ("did you mean `count`?").
- **Type errors** in `<script lang="ts">` components, from your project's own TypeScript (what `npx zubra check --types` reports): the script, every template expression, child props and event handlers, worked out when the file opens and each time it's saved. Needs `@zubra/compiler` and `typescript` installed in the project.
- **Completion** of directives, imported components, their props and events, and of props inside `{…}`.
- **TypeScript inside components**: in a `<script lang="ts">` component, hover, completion and go to definition from TypeScript in the script and in every `{…}` of the template (a `zb-each` item has its list's element type; completion works after a `.` you're still typing). It's TypeScript 5.9's language service, shipped with the extension, over the same file `zubra check --types` checks.
- **Hover** documentation for imported components: description, props with types and defaults, events and slots.
- **Go to definition** for imported components.
- **Formatting** (Format Document, or format on save with `"editor.formatOnSave": true`): `zubra fmt`'s layout, with your editor's indentation. It re-indents the template and tidies tags without changing what the component compiles to, and leaves expressions, comments, `<script>`, `<style>` and `<pre>` as written. `zubra.format.printWidth` (default 100) is the width a tag is fitted into before its attributes go one per line. Needs Zubra 5.4 or later.
- **Format Selection** (and `"editor.formatOnPaste": true`): formats the lines the selection touches, exactly as Format Document would write them in the whole file, and nothing else. Needs a Zubra compiler with `formatRange` (the release after 5.4).
- **Extract to component** (select whole sibling nodes of the template; lightbulb → *Extract to component*, or *Zubra: Extract to Component…* in the command palette and the context menu, which asks for the name): moves the markup into a new `.zb` file beside this one and puts `<new-tag …>` in its place, with the import. What the selection reads becomes a prop, a function of the component used as a whole handler (`onclick={remove}`) becomes an event, and names the component imports are imported again. When it can't, the action shows disabled with the reason: a selection that starts or ends inside a tag, a comment, a `{…}` expression or a `<textarea>`; assigning to the component's state; a `<zb-slot>`, or content placed in a slot (`slot="title"`); a handler that takes the event as its argument; a function or a browser-only value the server couldn't pass as a prop; a shadow DOM component; a cut `zb-if`/`zb-else` chain; a name that's taken. What it would write is compiled first, so it never leaves a component that compiled not compiling, or one that rendered on the server not rendering. No CSS moves: rules that match by descendant still apply, but a rule or layout that depends on the selection being a direct child (`ul > li`, a flex or grid container's children) now sees the new element. The action is offered to editors that can apply an edit creating a file. Needs a Zubra compiler with the `refactor` command (5.5 or later).

## Requirements

Diagnostics, completion and formatting use the Zubra compiler. The extension finds it in this order:

1. The `zubra.compiler` setting, a path to the `zubra` command.
2. `@zubra/compiler` (WebAssembly) installed in your project: `npm i -D @zubra/compiler`. A file in a folder with its own `node_modules` (an app inside the workspace) uses that folder's.
3. The `ZUBRA_COMPILER` environment variable.
4. In a checkout of the zubra repository, the CLI `cargo build` made (`target/debug` or `target/release`, the newer).
5. `zubra` on your `PATH` (on Windows, the `zubra.cmd` npm installs too).

If none of them can be run, the extension says so once, in a warning, and doesn't mark your files. Building or installing one then works without reloading the window.

Highlighting needs none of them.

## Learn more

- [Documentation](https://journey-to-code-org.github.io/zubra/docs/) and the [playground](https://journey-to-code-org.github.io/zubra/playground/), which runs in the browser.
- `npm create zubra@latest` starts a project.
- [Source](https://github.com/journey-to-code-org/zubra/tree/main/editors/vscode) and [issues](https://github.com/journey-to-code-org/zubra/issues).
