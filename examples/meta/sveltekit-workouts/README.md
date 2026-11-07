# Reps: SvelteKit with mnx components

A workout log. Log an exercise with its sets, reps and effort through a **form action**, enhanced with `use:enhance`. The page shows this week's training days against a goal and the last eight weeks as a grid.

SvelteKit builds with Vite, so the mnx plugin goes in `vite.config.js`. Svelte uses the elements directly: properties in, events out, and form controls in forms.

```svelte
<quantity-stepper name="sets" value={3} min={1} max={10} label="sets"></quantity-stepper>
<star-rating name="effort" label="Effort" required></star-rating>
<streak-grid log={data.log} today={data.today} weeks={8}></streak-grid>
```

| What | Where |
|---|---|
| mnx form controls in a form action: `sets`, `reps` and `effort` arrive in the action's `FormData`, and `required` stops the submission | `src/routes/+page.svelte`, `+page.server.js` |
| Registry components (`quantity-stepper`, `star-rating`, `streak-grid`, `progress-ring`) and the app's own `workout-row` | `mnx/` |
| An object prop from Svelte (`log={data.log}`) | the streak grid |

```sh
npm install
npm run dev
ORIGIN=http://localhost:3000 npm run build && npm start
npm test
```

Inside this repository, the mnx compiler is the CLI from `cargo build` (the tests find it) or a built `compiler/mnx.wasm`. `.npmrc` installs the repository's packages as copies.

SvelteKit 3 notes: configuration goes in `sveltekit({ … })` in `vite.config.js` (`svelte.config.js` is gone), `$lib` is `#lib` (a `package.json` import), and the Node adapter takes its origin from `paths.origin` at build time (`ORIGIN` here). Without that, it assumes HTTPS and refuses its own form posts over HTTP.

## What this app found

These are recorded in the project's server roadmap (`plan/roadmap-server.md`).

- **Light DOM breaks Svelte's hydration outright.** As in the Next.js and Nuxt apps, the elements are defined before the framework hydrates, and a light-DOM element renders into its host. Svelte's hydration then fails (`HierarchyRequestError`) and the page is left blank. The components are shadow DOM here.
- **Without JavaScript, the elements show nothing, and the form can't log a workout.** Svelte server-renders the host tags only, and shadow DOM needs JavaScript to draw. Form-associated controls only submit once JavaScript has defined them. So the form action received no `sets`, `reps` or `effort`. Fixed in 2.8: `src/hooks.server.js` runs `mnx.injectShadowRoots` on each page, which renders the elements' shadow roots from their `mnx-props` (which the mnx plugin adds in the server build since 2.10) and adds a hidden input for each control. Without JavaScript the form now logs a workout. The streak grid needs `Date` and `Intl`, so it still draws in the browser.
- **Svelte writes object props as `"[object Object]"` in server HTML.** Fixed while building this: the runtime now treats that as "not given yet" instead of warning about invalid JSON, since Svelte sets the real object once it runs.
