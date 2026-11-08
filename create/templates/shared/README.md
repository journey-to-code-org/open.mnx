# {{title}}

A {{framework}} app using [mnx](https://github.com/journey-to-code-org/open.mnx) web components.

```sh
npm install
npm run dev     # then edit src/components/hello-counter.mnx: it updates in place
npm run build
npm test        # builds the app and clicks through it in Chromium (run `npx playwright install chromium` once)
```

- `src/components/` holds the components: one `.mnx` file each, with its script, styles and template.
- The mnx plugin (`@mnx/unplugin`) compiles them when they're imported, and writes their typings next to them.
- The elements are standard custom elements, so they also work in plain HTML, other frameworks and server-rendered pages.
- `AGENTS.md` and `skills/` tell a coding agent how to write and use the components, so it doesn't have to learn mnx from the source.

The [tutorial](https://github.com/journey-to-code-org/open.mnx/blob/main/docs/guide/README.md) goes from here to forms, async data and server rendering.
