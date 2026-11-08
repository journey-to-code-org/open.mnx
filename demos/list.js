// Every example, for the demo gallery (demos/build.mjs) and its screenshots (demos/screenshots.mjs).
//
// `build` is how a static example is built under a base path (the gallery links to it live);
// the others need a server and are shown with a screenshot and a link to their source.
// `interactive` is the page the gallery's test checks, when the first page has no JavaScript.

export const demos = [
  // Client frameworks (examples/frameworks shares one toolchain install)
  { id: 'react-board', dir: 'examples/frameworks/react-board', title: 'Sprint board', stack: 'React 19', group: 'Frameworks',
    blurb: '.zb files imported as React components, React children in their slots, drag and drop, and a column from a component library.', build: 'frameworks' },
  { id: 'vue-budget', dir: 'examples/frameworks/vue-budget', title: 'Budget tracker', stack: 'Vue 3', group: 'Frameworks',
    blurb: 'v-model on Zubra elements, slot content from Vue templates, and an SVG donut from Vue’s computed state.', build: 'frameworks' },
  { id: 'svelte-flashcards', dir: 'examples/frameworks/svelte-flashcards', title: 'Flashcards', stack: 'Svelte 5', group: 'Frameworks',
    blurb: 'A spaced-repetition trainer: a shadow-DOM element with named slots filled from Svelte markup, and keyboard shortcuts.', build: 'frameworks' },
  { id: 'solid-markets', dir: 'examples/frameworks/solid-markets', title: 'Market dashboard', stack: 'Solid', group: 'Frameworks',
    blurb: 'Live prices on every tick through prop: bindings, nested elements, and an SVG chart with pointer events.', build: 'frameworks' },
  { id: 'lit-chat', dir: 'examples/frameworks/lit-chat', title: 'Team chat', stack: 'Lit 3', group: 'Frameworks',
    blurb: 'Light-DOM Zubra elements inside a LitElement’s shadow root, with the user from @lit/context.', build: 'frameworks' },
  { id: 'preact-habits', dir: 'examples/frameworks/preact-habits', title: 'Habit tracker', stack: 'Preact 10', group: 'Frameworks',
    blurb: 'Objects as props, a contribution-style grid with keyboard navigation, and a Zubra form control in a Preact form.', build: 'frameworks' },
  { id: 'angular-booking', dir: 'examples/frameworks/angular-booking', title: 'Booking wizard', stack: 'Angular 22', group: 'Frameworks',
    blurb: 'Reactive forms whose controls are Zubra elements, with validation and a step indicator.', build: 'frameworks' },

  // Rendered on the server or at build time
  { id: 'recipes', dir: 'examples/recipes', title: 'Recipes', stack: 'Astro', group: 'Server and static rendering',
    blurb: 'Zubra components as Astro islands, rendered at build time and hydrated where they’re interactive.', build: 'astro',
    // The home page's cards are static (no JavaScript); a recipe's page has the islands.
    interactive: 'recipes/dal/' },
  { id: 'eleventy-trails', dir: 'examples/meta/eleventy-trails', title: 'Mountain trails', stack: 'Eleventy 3', group: 'Server and static rendering',
    blurb: 'A static trail guide rendered by @zubra/server at build time, with no bundler.', build: 'eleventy' },
  { id: 'next-conference', dir: 'examples/meta/next-conference', title: 'Conference schedule', stack: 'Next.js 16', group: 'Server and static rendering',
    blurb: 'Filter and star talks, and rate one through a Server Action.' },
  { id: 'nuxt-bookshop', dir: 'examples/meta/nuxt-bookshop', title: 'Bookshop inventory', stack: 'Nuxt 4', group: 'Server and static rendering',
    blurb: 'Books filtered on the server with the URL in sync, stock against reorder points, and an edit form.' },
  { id: 'sveltekit-workouts', dir: 'examples/meta/sveltekit-workouts', title: 'Workout log', stack: 'SvelteKit 3', group: 'Server and static rendering',
    blurb: 'Exercises logged through a form action with use:enhance, and a week of training against a goal.' },
  { id: 'react-router-trips', dir: 'examples/meta/react-router-trips', title: 'Trip budget', stack: 'React Router 8', group: 'Server and static rendering',
    blurb: 'Who paid for what and who owes whom, in framework mode with loaders and actions.' },
  { id: 'solidstart-potluck', dir: 'examples/meta/solidstart-potluck', title: 'Potluck sign-up', stack: 'SolidStart 2', group: 'Server and static rendering',
    blurb: 'Who’s bringing what, with a sign-up form that works without JavaScript.' },

  // Servers without a front-end framework
  { id: 'helpdesk', dir: 'examples/helpdesk', title: 'Help desk', stack: 'Express, EJS, MongoDB', group: 'Servers',
    blurb: 'A ticket tracker that works without JavaScript, with a streamed activity feed.' },
  { id: 'hono-bikes', dir: 'examples/hypermedia/hono-bikes', title: 'Bike shop', stack: 'Hono and htmx', group: 'Servers',
    blurb: 'Search, paging, quick sales and inline editing, swapped in by htmx and hydrated in place.' },
  { id: 'flask-garden', dir: 'examples/backends/flask-garden', title: 'Garden plots', stack: 'Flask, Jinja, SQLite', group: 'Servers',
    blurb: 'Components rendered by the Rust CLI, with no Node.js on the server.' },

  // Plain HTML
  { id: 'todo', dir: 'examples/todo', title: 'To-do list', stack: 'Vite, no framework', group: 'Plain HTML',
    blurb: 'Two .zb components and a few lines of plain JavaScript.', build: 'vite' },
  { id: 'planner', dir: 'examples/planner', title: 'Event planner', stack: 'Vite, no framework', group: 'Plain HTML',
    blurb: 'A single-page app written only in .zb components: a month calendar, an event dialog, and each event planned in tabs (schedule, guests, budget).', build: 'vite' },

  // Outside the browser tab
  { id: 'focus-timer', dir: 'examples/desktop/focus-timer', title: 'Focus timer', stack: 'Electron', group: 'Apps',
    blurb: 'A desktop app under a strict content security policy.' },
  { id: 'page-notes', dir: 'examples/extension/page-notes', title: 'Page notes', stack: 'Chrome extension (MV3)', group: 'Apps',
    blurb: 'Notes for each site, in a popup, a side panel and the page itself.' },
];
