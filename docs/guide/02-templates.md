# 2. Templates

Templates are HTML with `{expressions}` and a few elements that start with `mnx-`. Everything here is valid HTML syntax, so editors, formatters and linters understand it.

## Conditions and lists

```html
<script>
  let items = [{ id: 1, text: "Milk", done: false }]
  let filter = "all"
  const shown = filter === "all" ? items : items.filter((item) => item.done === (filter === "done"))
</script>
<shopping-list>
  <mnx-if test={items.length === 0}>
    <p>Nothing yet.</p>
  <mnx-else-if test={shown.length === 0}>
    <p>Nothing {filter}.</p>
  </mnx-else-if>
  <mnx-else>
    <ul>
      <mnx-each items={shown} as="item" key={item.id}>
        <li>{item.text}</li>
      </mnx-each>
    </ul>
  </mnx-else>
  </mnx-if>
</shopping-list>
```

- `mnx-if` switches only when the chosen branch changes.
- `mnx-each` with a `key` moves rows when the list reorders, along with their DOM state (focus, a half-typed input). Changing one item updates only that row.
- Mutate the list the ordinary way: `items.push({ … })`, `items.splice(i, 1)`, `item.done = !item.done`. State tracks each property, so a push adds one row and a write to one item updates one row. (Reassigning, `items = items.filter(…)`, works too.)

## Classes and styles

```html
<li class="item" class:done={item.done} class:selected={item.id === selected}
    style:--accent={item.color} style:opacity={item.archived ? 0.5 : null}>
```

- `class:name={…}` adds the class while the value is truthy. Bare `class:done` reads a name `done`. `class={{ done, selected }}` does the same for several classes.
- `style:property={…}` sets one property; `null` or `false` removes it. Custom properties (`--accent`) work, which is the usual way to pass a value into CSS.

## Events

```html
<form onsubmit.prevent={save}>
  <input value={draft} oninput={(event) => (draft = event.target.value)}
         onkeydown.escape={() => (draft = "")}>
</form>
<mnx-document onkeydown.ctrl.k.prevent={openSearch}></mnx-document>
```

- `on<event>={handler}` listens. The handler can be a script function or an arrow function.
- **Modifiers** go after a dot: `.prevent`, `.stop`, `.once`, `.self`, `.capture`, `.passive`, and key filters (`.enter`, `.escape`, `.up`, a letter, …). With a key filter, `.shift`/`.ctrl`/`.alt`/`.meta` must be held and the others not, so `onkeydown.enter` and `onkeydown.shift.enter` don't overlap.
- `<mnx-window>` and `<mnx-document>` listen on the window or document while they're rendered, and clean up after.

## References

```html
<script>
  let input = null
  function focusInput() { input.focus() }
</script>
<search-box>
  <input ref={input}>
  <button type="button" onclick={focusInput}>Search</button>
</search-box>
```

`ref={name}` assigns the element to a `let` once it's rendered, and `null` when it's removed.

## Expressions

Any JavaScript expression works in `{…}`: calls, arrow functions, template strings, `new`. The compiler checks every name in every branch (a typo gets a "did you mean"), and evaluates the simple ones at build time for the server HTML.

**Next:** [Two-way props and events](03-props-and-events.md)
