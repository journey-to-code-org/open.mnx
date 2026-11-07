# Examples

Three projects that use mnx 2.0 the way an app would, each with its own README:

- **[`todo/`](todo/)**, the basic one: two `.mnx` components and a few lines of glue, built with
  Vite.
- **[`recipes/`](recipes/)**, the complex one: an Astro site with static server-rendered
  components, a JSX island, a form-associated control and data loaded with `resource()`.
- **[`planner/`](planner/)**, the largest: an event planner app (calendar, guests, budget,
  schedule, tasks, export) in nine `.mnx` components, with context, routing and persistence and
  no framework.

`plugin/test/examples.test.js` builds each one and drives them in Chromium.

The loose `.mnx` files here are the small samples the CLI's README and tests refer to.
