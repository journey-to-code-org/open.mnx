# 2. Templates

Templates are HTML with `{expressions}` and a few elements that start with `zb-`. Everything here is valid HTML syntax, so editors, formatters and linters understand it.

## Conditions and lists

```html
<script>
  let items = [{ id: 1, text: "Milk", done: false }]
  let filter = "all"
  const shown = filter === "all" ? items : items.filter((item) => item.done === (filter === "done"))
</script>
<shopping-list>
  <p zb-if={items.length === 0}>Nothing yet.</p>
  <p zb-else-if={shown.length === 0}>Nothing {filter}.</p>
  <ul zb-else>
    <zb-each items={shown} as="item" key={item.id}>
      <li>{item.text}</li>
    </zb-each>
  </ul>
</shopping-list>
```

- **One element, one condition:** `zb-if={…}` on the element, then `zb-else-if={…}` and `zb-else` on the siblings right after it (whitespace may come between). This keeps tables and lists valid HTML for editors and formatters (`<tr zb-if={…}>`).
- **Several siblings, or text:** wrap them, `<zb-if test={…}>…<zb-else-if test={…}>…</zb-else-if><zb-else>…</zb-else></zb-if>`. Both forms compile to the same thing.
- `zb-if` switches only when the chosen branch changes.
- `zb-each` with a `key` moves rows when the list reorders, along with their DOM state (focus, a half-typed input). Changing one item updates only that row.
- Mutate the list the ordinary way: `items.push({ … })`, `items.splice(i, 1)`, `item.done = !item.done`. State tracks each property, so a push adds one row and a write to one item updates one row. (Reassigning, `items = items.filter(…)`, works too.)

## Spreading attributes

`{...object}` puts an object's entries on an element: attributes, `on<Name>` listeners and properties such as `value`. It's how a headless library (Zag.js, for one) hands you a widget's behaviour:

```html
<input {...api.getInputProps()} class="field">
```

An attribute written on the element wins over the same key in the spread, and a spread can't do anything an attribute couldn't (no handler as text, no `style` text, no unsafe URLs, no `innerHTML`).

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
<zb-document onkeydown.ctrl.k.prevent={openSearch}></zb-document>
```

- `on<event>={handler}` listens. The handler can be a script function or an arrow function.
- **Modifiers** go after a dot: `.prevent`, `.stop`, `.once`, `.self`, `.capture`, `.passive`, and key filters (`.enter`, `.escape`, `.up`, a letter, …). With a key filter, `.shift`/`.ctrl`/`.alt`/`.meta` must be held and the others not, so `onkeydown.enter` and `onkeydown.shift.enter` don't overlap.
- `<zb-window>` and `<zb-document>` listen on the window or document while they're rendered, and clean up after.

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

Coming from React? Markup works in braces too, in the three forms that are directives:

```html
{saved && <p class="ok">Saved</p>}
{user ? <b>{user.name}</b> : <a href="/login">Sign in</a>}
<ul>{items.map((item) => <li key={item.id}>{item.text}</li>)}</ul>
```

They compile to exactly `zb-if`, `zb-if` with `zb-else`, and a keyed `zb-each`. The markup inside is the template's own HTML (`class`, `onclick`), and each brace holds one element. Anything else with markup in it gets an error that names the directive to use.

**Next:** [Two-way props and events](03-props-and-events.md)
