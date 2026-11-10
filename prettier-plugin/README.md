# prettier-plugin-zubra

Prettier for `.zb` components.

```sh
npm install --save-dev prettier prettier-plugin-zubra
```

```json
{ "plugins": ["prettier-plugin-zubra"] }
```

```sh
npx prettier --write "src/**/*.zb"
```

- **The template** is laid out by `zubra fmt` (the plugin calls `format()` from `@zubra/compiler`), so Prettier and `zubra fmt` never disagree. `tabWidth`, `useTabs` and `printWidth` apply to it.
- **`<script>` and `<style>`** are formatted by Prettier with your configuration: JavaScript (or TypeScript for `lang="ts"`), CSS, SCSS (`lang="scss"`) and Less (`lang="less"`), indented one level inside their tag. Template literals are never re-indented.
- A body that doesn't parse, or is in a language Prettier has no parser for, is left as written. `embeddedLanguageFormatting: "off"` leaves every body as written.
- A file that doesn't parse as a component is an error, as with `zubra fmt`.

It never changes what the component compiles to. The tests format every `.zb` in the repository and compare the compiled JavaScript and CSS, ignoring only what Prettier chooses (whitespace, quote style, semicolons, trailing commas).

`.zb.tsx` and `.zb.jsx` components are JSX: Prettier already formats them.
