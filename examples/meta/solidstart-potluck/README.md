# Saturday potluck: SolidStart 2

A potluck sign-up in SolidStart 2 (on Vite and Nitro). The page shows who's bringing what, and
has a form that posts to a server `action`. It works without JavaScript and submits in place
with it. The components:
- `dish-board`, its own;
- `choice-cards` (the course) and `quantity-stepper` (how many people), from the registry and
  form-associated.

Solid uses custom elements directly: `prop:` sets a property and `on:` listens for an event.

```jsx
<choice-cards name="course" label="Course" prop:items={items} prop:value={course()} on:valuechange={(event) => setCourse(event.detail)} />
```

```sh
cargo build                 # from the repository root (the compiler, until @mnx/compiler is on npm)
cd examples/meta/solidstart-potluck
npm install
npm run dev                 # or: npm run build && npm start
```

## What it found

- **Solid's hydration tolerates light DOM.** With `dish-board` switched to light DOM, the page
  still hydrated without errors. Solid claims only the nodes it marked, and leaves an element's
  own children alone. That's unlike React, Vue and Svelte (`../README.md`). The components are
  shadow DOM anyway, for consistency with the other apps.
- **The same server gap** (fixed in 2.8). Solid renders the hosts with no inner markup, and
  `prop:` values are properties, so they weren't in the server HTML either. Now the hosts carry
  `mnx-props` (written by the mnx plugin since 2.10; by hand in 2.8), and `src/middleware.js` runs `mnx.injectShadowRoots` on each page. Without
  JavaScript the action gets the course and head count, and the sign-up goes through.
- **The template wants Node.js 24** (`engines`). It builds and runs on 22, which CI uses.
