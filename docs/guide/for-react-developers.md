# Zubra for React developers

A Zubra component is closer to a React function component than it looks. The difference is that **the body runs once per element**, and updates go straight to the DOM nodes that read the changed value. There's no re-render, so there are no hook rules, dependency arrays or memoization.

| React | Zubra |
|---|---|
| `function Counter({ label = "Clicks" })` | `<my-counter label="Clicks">` (or the same function in a `.zb.jsx` file) |
| `const [count, setCount] = useState(0)` | `let count = 0`, then `count++` |
| `const doubled = useMemo(() => count * 2, [count])` | `const doubled = count * 2` |
| `useState(seconds)` plus `useEffect(() => setLeft(seconds), [seconds])` | `let left = from(seconds)`: follows the prop until assigned, starts over when it changes (`zubra convert` writes it) |
| `useEffect(() => { … }, [count])` | `effect(() => { … })`: tracks what it reads (it runs before the DOM updates; `onMount(() => effect(…))` runs after, as React's does) |
| `useEffect(() => { … return cleanup }, [])` | `onMount(() => { … return cleanup })` |
| `useRef()` + `ref={input}` | `let input = null` + `ref={input}` |
| `{cond && <X />}`, `cond ? <A /> : <B />` | `<zb-if test={cond}>…<zb-else>…</zb-else></zb-if>` (or the same JSX in `.zb.jsx`) |
| `items.map((item) => <li key={item.id}>…</li>)` | `<zb-each items={items} as="item" key={item.id}><li>…</li></zb-each>` |
| `className={cx({ open })}` | `class:open` or `class={{ open }}` |
| `style={{ fontSize: size }}` | `style:font-size={size + "px"}` or `style={{ fontSize: … }}` |
| `onSubmit={(e) => { e.preventDefault(); save() }}` | `onsubmit.prevent={save}` |
| `props.onChange(value)` | `emit('valuechange', value)`, or a `value:model` prop |
| `children` | `<zb-slot>`; named slots for more than one |
| Context | `createContext` / `provide` / `inject` |
| `use(promise)` with Suspense | `resource()` with `<zb-await>` |

## Converting a component

`zubra convert src/TodoItem.jsx` rewrites a React function component as a Zubra JSX component, converting the hooks above and reporting what it can't (README, "Moving in from React"). It's a good way to see how your own code maps.

## Prefer JSX?

Write the component as a function in a `.zb.jsx` or `.zb.tsx` file. It compiles to the same element, with the same once-per-element semantics:

```jsx
import { model } from '@zubra/runtime'

export default function MyCounter({ label = "Clicks", count = model(0) }) {
  const doubled = count * 2
  return <button onClick={() => count++}>{label}: {count} ({doubled})</button>
}
```

`model(0)` makes `count` two-way, like `count:model={0}`.

## Using Zubra components in a React app

With `@zubra/unplugin`, importing a `.zb` file (or a library built with `zubra build --lib`) into a `.jsx`/`.tsx` file gives you a typed React component: props are set as properties, and `onValueChange`-style props listen for the element's events. These are lines of the [sprint board](../../examples/frameworks/react-board):

<!-- snippet: examples/frameworks/react-board/src/App.jsx#react-imports -->
```jsx
import { KanbanColumn } from '@zubra-examples/ui/react';
import TaskCard from './components/task-card.zb';
```

The cards are React's: React reorders, filters, adds and removes them inside the column's slot, and the column and the card are Zubra elements:

<!-- snippet: examples/frameworks/react-board/src/App.jsx#react-cards -->
```jsx
{visible[column.id].map((card) => (
  <TaskCard
    key={card.id}
    data-id={card.id}
    card={card}
    onCardOpen={() => open(card)}
    onCardMove={(event) => dispatch({ type: 'shift', id: card.id, by: event.detail })}
    onCardReorder={(event) => dispatch({ type: 'reorder', id: card.id, by: event.detail })}
  />
))}
```

React 19 also uses the elements directly (`<my-counter count={n} oncountchange={…}>`).

## What you get with React

Each line links the test that checks it. The tests run on every push.

- Props including objects, `on<Event>` handlers, and React-managed children in an element's slots, reordered, filtered, added and removed by React ([`react.test.js`](../../examples/frameworks/test/react.test.js)).
- Drag and drop between columns, undo, and the keyboard (Shift+arrows) are events from the elements into React's reducer ([`react.test.js`](../../examples/frameworks/test/react.test.js)).
- A Zubra form control used as a controlled input: the editor's tag input is driven by React state ([`react.test.js`](../../examples/frameworks/test/react.test.js)).
- Under Next.js, the schedule's cards are in the server HTML with JavaScript off and hydrate in place, and a Server Action takes Zubra form controls like native inputs, validation included ([`next-conference`](../../examples/meta/next-conference/test/app.test.js)).
- The card editor is a React component converted with `zubra convert`, and editing a card through it works ([`react.test.js`](../../examples/frameworks/test/react.test.js)).
- The same `.zb` file also runs in Vue, Svelte, Angular, Solid, Lit, Preact, Astro and plain HTML apps, each row checked in CI ([the framework matrix](../framework-matrix.md)).

## What doesn't cross

The general rules, with the reasons, are in [What crosses the boundary](../what-crosses-the-boundary.md): props, events, slots and forms cross; render props, framework context and framework lifecycle don't. For React in particular:

- **Render props and `useContext`.** The element can't render React nodes, and React context is invisible from inside it. Use slots and props.
- **Suspense and transitions** can't suspend through an element. Loading is a prop or an event.
- **Next.js: an element given React children renders in the browser only.** React's `dangerouslySetInnerHTML` and children are exclusive, and a declarative shadow root as a React child breaks hydration. That is React's limit and Zubra can't fix it from its side. Elements without React children are server-rendered ([Server rendering, honestly](../server-rendering.md)).
- **Event names are lowercase** underneath: `onValueChange` in the wrapper is the element's `valuechange`.

**Which framework do you use alongside Zubra, and what would a page written for you need to show?** [Tell us in an issue](https://github.com/journey-to-code-org/zubra/issues/new).
