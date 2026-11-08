# Converting the card editor from React

The card editor (`src/components/card-editor.zb.jsx`) started as a React component, `src/CardEditor.jsx`. `zubra convert` rewrote it as a Zubra component, and a few lines were finished by hand. The board itself is still React, and it uses the editor like any other component.

```sh
zubra convert src/CardEditor.jsx --out src/components/card-editor.zb.jsx
```

## What `zubra convert` did

```text
CardEditor.jsx: made the component the file's default export
CardEditor.jsx: `useEffect(…, [])` became `onMount(…)`
CardEditor.jsx: `useState` became a `let` (state), and its setter calls assignments
CardEditor.jsx: `useRef` became a `let` holding the element or value, without `.current`
CardEditor.jsx: `onChange` on text fields became `onInput` (the DOM's `change` waits for blur)
CardEditor.jsx: adjusted 2 relative imports for src/components
CardEditor.jsx: wrote src/components/card-editor.zb.jsx (<card-editor>)
warning: call `onClose(…)` to fire the event; passing it on isn't supported
1 thing to finish by hand (above)
```

Before (React):

```jsx
export function CardEditor({ card, isNew, suggestions, onSave, onDelete, onClose }) {
  const dialog = useRef(null);
  const [draft, setDraft] = useState(card);
  const set = (key) => (event) => setDraft({ ...draft, [key]: … });

  useEffect(() => {
    dialog.current.showModal();
  }, []);
  …
  <input name="title" required value={draft.title} onChange={set('title')} autoFocus />
  …
  <button type="button" onClick={() => dialog.current.close()}>Cancel</button>
```

After (Zubra), as `zubra convert` wrote it:

```jsx
export default function CardEditor({ card, isNew, suggestions, onSave, onDelete, onClose }) {
  let dialog = null;
  let draft = card;
  const set = (key) => (event) => (draft = { ...draft, [key]: … });

  onMount(() => {
    dialog.showModal();
  });
  …
  <input name="title" required value={draft.title} onInput={set('title')} autoFocus />
  …
  <button type="button" onClick={() => dialog.close()}>Cancel</button>
```

Comments, formatting and everything else were left as they were.

## What was finished by hand

1. **`onClose={onClose}` on the `<dialog>`** became `onClose={() => onClose()}`. In a Zubra component, `onClose` is the component's `close` event: calling it fires the event, so it has to be called rather than passed on. (`convert` reported this one.)
2. **`onClick={onDelete}`**, for the same reason, became `onClick={() => onDelete()}`. (The compiler stops at the first such place, so it came up after the first fix.)
3. **The tag input** was a component in this app. It now comes from the shared library (`../ui`, see below), so it's imported for its element (`import '@zubra-examples/ui/tag-input'`) and written as `<tag-input …>`.
4. **In `App.jsx`**, `onSave` now gets an event, so the card is `event.detail`: `onSave={(event) => dispatch({ type: 'save', card: event.detail, … })}`. `onClose` and `onDelete` were unchanged.

## What it turned up

Seeding state from a prop (`let draft = card`, which is what `useState(card)` converts to) needs the prop to be set before the component's script runs. React 19 sets the props as it creates the element, before inserting it. Under React 18 the element reads them from the `zb-props` attribute the adapter writes, which carries props that can be written as JSON. `runtime/test/browser/adapters.test.js` covers both.

## The shared library

The board's column (`kanban-column`) and the editor's tag input come from `@zubra-examples/ui` (`../ui`). That package is built from the [component registry](../../../registry/) with `zubra build --lib`, so the app imports the column as a React component from the package's React entry:

```js
import { KanbanColumn } from '@zubra-examples/ui/react';
```

The Vue budget app uses the same package's Vue entry for its money input, segmented control and donut chart.
