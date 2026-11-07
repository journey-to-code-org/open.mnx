# Examples

Projects that use mnx 2 the way an app would, each with its own README:

- **[`todo/`](todo/)**, the basic one: two `.mnx` components and a few lines of glue, built with
  Vite.
- **[`recipes/`](recipes/)**, the complex one: an Astro site with static server-rendered
  components, a JSX island, a form-associated control and data loaded with `resource()`.
- **[`frameworks/`](frameworks/)**: one app per framework (React, Vue, Svelte, Solid, Lit,
  Preact, Angular), each mixing that framework's components with mnx elements.
- **[`planner/`](planner/)**, the largest plain one: an event planner app (calendar, guests, budget,
  schedule, tasks, export) in nine `.mnx` components, with context, routing and persistence and
  no framework.
- **[`helpdesk/`](helpdesk/)**, the server one: a help-desk ticket tracker in Express, EJS and
  MongoDB. Components are rendered on the server inside EJS pages and hydrated in the browser
  without a bundler; every page works with JavaScript off.
- **[`meta/`](meta/)**, the meta-framework ones: a conference app in Next.js, a bookshop in Nuxt
  and a workout log in SvelteKit, each using mnx elements from server-rendered pages, with forms
  posting to the framework's own server code. Its README lists what they found.
- **[`backends/`](backends/)**, the non-JavaScript servers: a community garden's plot sign-up
  in Flask, Jinja and SQLite, whose components are rendered by the Rust CLI, with no Node.js
  on the server.
- **[`hypermedia/`](hypermedia/)**: a bike shop's inventory in Hono and htmx, on Node.js or
  Bun. htmx swaps server-rendered fragments in, and the mnx elements in them hydrate where they
  land.
- **[`extension/`](extension/)**: a Chrome extension (Manifest V3) with mnx components in its
  popup, its options page, and a widget on other people's pages.
- **[`desktop/`](desktop/)**: a focus timer in Electron, with a sandboxed renderer under a strict
  Content Security Policy.

Each one has tests that build it and drive it in Chromium: `plugin/test/examples.test.js`, and the
`test/` (or `tests/`) folder of each app. The help desk's also run against MongoDB in CI.

The loose `.mnx` files here are the small samples the CLI's README and tests refer to.
