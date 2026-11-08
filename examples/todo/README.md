# To-do list

The basic example: two `.zb` components and a few lines of plain JavaScript, built with Vite.

```sh
cd examples/todo
npm install
npm run dev
```

The example links the packages in this repository, so the compiler needs building once: either
`npm run build` in `compiler/` (WebAssembly; needs the `wasm32-unknown-unknown` Rust target), or
`cargo build` at the root and `ZUBRA_COMPILER=../../target/debug/zubra npm run dev`.

## What it shows

- **`todo-app.zb`** owns the list. `items` is a prop (the page sets it from `localStorage`);
  `filter` and `draft` are `let`, so they're state; `remaining` and `shown` are derived from
  them and update on their own. Every change goes through `update()`, which writes `items` and
  fires `change`.
- **`todo-item.zb`** is one row: a checkbox, a label you double-click to edit, and a remove
  button. It doesn't change the list itself; it fires `toggle`, `rename` and `remove`, and the
  app handles them with `ontoggle`, `onrename` and `onremove`.
- **`main.js`** is the only glue: it loads the saved items into `<todo-app>` and saves them on
  `change`. Any framework could do the same, since `<todo-app>` is just an element with a
  property and an event.

The list is keyed (`key={item.id}`), so filtering and clearing move rows instead of rebuilding
them, and an edit in progress stays where it is.

`plugin/test/examples.test.js` builds this example and drives it in a browser.
