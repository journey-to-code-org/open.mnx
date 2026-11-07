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
- **The same server gap.** Solid renders the hosts with no inner markup. `prop:` values are
  properties, so they aren't in the server HTML either. Without JavaScript the action gets no
  course and no head count, and refuses the sign-up.
- **The template wants Node.js 24** (`engines`). It builds and runs on 22, which CI uses.
