# Trip budget: React Router 8

A shared trip budget in React Router 8's framework mode: who paid for what, who's up and down,
and a form to add an expense. It uses:
- a server `loader` and `action`;
- `<Form>` for adding, and `useFetcher` for deleting;
- validation errors returned from the action.

React Router builds with Vite, so its routes import `.mnx` files directly:

```jsx
import MoneyInput from '../../mnx/money-input.mnx';
<MoneyInput name="amount" label="Amount" required value={amount} onValueChange={(event) => setAmount(event.detail)} />
```

The components are `balance-list` (its own) and the registry's `money-input` and
`segmented-control`. The registry's two are form-associated, so they submit with `<Form>` like
native inputs.

```sh
cargo build                 # from the repository root (the compiler, until @mnx/compiler is on npm)
cd examples/meta/react-router-trips
npm install
npm run dev                 # or: npm run build && npm start
```

## What it found

- **mnx can't tell this is a React project.** The plugin looks for `@vitejs/plugin-react`, and
  React Router's Vite plugin is a different one. So `vite.config.js` says
  `mnx({ framework: 'react' })`. Without it, importing an `.mnx` file gives the element class,
  not a React component. Detection should recognise React Router (and other React frameworks on
  Vite).
- **The same three findings as Next.js** (`../README.md`):
  - the components are shadow DOM, because light DOM would make React redo the page on hydration;
  - the server HTML has the hosts only: no balances, no amount field;
  - without JavaScript, the form posts without the mnx controls' values. The test shows the
    action's "An amount above $0.", which is the case for the hidden-input fallback in roadmap
    challenge 11.
- **Form-associated controls work with React Router's `<Form>`.** `FormData` picks up their
  values, a form `reset()` clears them, and the action reads them like any other field.
