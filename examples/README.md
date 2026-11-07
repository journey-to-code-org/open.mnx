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

`plugin/test/examples.test.js`, `frameworks/test/` and `helpdesk/test/` build each one and drive them in Chromium (the help desk also against MongoDB in CI).

The loose `.mnx` files here are the small samples the CLI's README and tests refer to.
