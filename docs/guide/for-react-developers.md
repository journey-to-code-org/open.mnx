# mnx for React developers

An mnx component is closer to a React function component than it looks. The difference is that **the body runs once per element**, and updates go straight to the DOM nodes that read the changed value. There's no re-render, so there are no hook rules, dependency arrays or memoization.

| React | mnx |
|---|---|
| `function Counter({ label = "Clicks" })` | `<my-counter label="Clicks">` (or the same function in a `.mnx.jsx` file) |
| `const [count, setCount] = useState(0)` | `let count = 0`, then `count++` |
| `const doubled = useMemo(() => count * 2, [count])` | `const doubled = count * 2` |
| `useEffect(() => { … }, [count])` | `effect(() => { … })`: tracks what it reads |
| `useEffect(() => { … return cleanup }, [])` | `onMount(() => { … return cleanup })` |
| `useRef()` + `ref={input}` | `let input = null` + `ref={input}` |
| `{cond && <X />}`, `cond ? <A /> : <B />` | `<mnx-if test={cond}>…<mnx-else>…</mnx-else></mnx-if>` (or the same JSX in `.mnx.jsx`) |
| `items.map((item) => <li key={item.id}>…</li>)` | `<mnx-each items={items} as="item" key={item.id}><li>…</li></mnx-each>` |
| `className={cx({ open })}` | `class:open` or `class={{ open }}` |
| `style={{ fontSize: size }}` | `style:font-size={size + "px"}` or `style={{ fontSize: … }}` |
| `onSubmit={(e) => { e.preventDefault(); save() }}` | `onsubmit.prevent={save}` |
| `props.onChange(value)` | `emit('valuechange', value)`, or a `value:model` prop |
| `children` | `<mnx-slot>`; named slots for more than one |
| Context | `createContext` / `provide` / `inject` |
| `use(promise)` with Suspense | `resource()` with `<mnx-await>` |

## Prefer JSX?

Write the component as a function in a `.mnx.jsx` or `.mnx.tsx` file. It compiles to the same element, with the same once-per-element semantics:

```jsx
import { model } from '@mnx/runtime'

export default function MyCounter({ label = "Clicks", count = model(0) }) {
  const doubled = count * 2
  return <button onClick={() => count++}>{label}: {count} ({doubled})</button>
}
```

`model(0)` makes `count` two-way, like `count:model={0}`.

## Using mnx components in a React app

With `@mnx/unplugin`, importing an `.mnx` file into a `.jsx`/`.tsx` file gives you a typed React component: props are set as properties, `onValueChange`-style props listen for the element's events, and `value` + `onValueChange` is a controlled component. React 19 also uses the elements directly (`<my-counter count={n} onvaluechange={…}>`).

Why bother, if you already have React? The same component works in the Vue app next door, in server-rendered HTML, and in a plain page, and it can be published once for all of them.
