# 11. Motion

Things on a page appear, disappear and move. This chapter animates all three with CSS, and the one attribute the platform is missing: `animate`.

## Coming in: just CSS

An element that's inserted can transition from a starting style. That needs nothing from Zubra:

```html
<style>
  .toast { transition: opacity 200ms, translate 200ms; }
  @starting-style { .toast { opacity: 0; translate: 0 8px; } }
</style>
<save-toast saved={false}>
  <button onclick={() => (saved = !saved)}>Save</button>
  <p class="toast" zb-if={saved}>Saved</p>
</save-toast>
```

Click Save and the toast slides up. Click again, and it vanishes: once `saved` is false the element is removed, and a removed element can't transition.

## Going out: `zb-animate`

```html
<style>
  .toast { transition: opacity 200ms, translate 200ms; }
  @starting-style { .toast { opacity: 0; translate: 0 8px; } }
  .toast[data-leaving] { opacity: 0; translate: 0 8px; }
</style>
<save-toast saved={false}>
  <button onclick={() => (saved = !saved)}>Save</button>
  <p class="toast" zb-if={saved} zb-animate>Saved</p>
</save-toast>
```

Now the toast stays when `saved` goes false. It gets `data-leaving`, which starts its transition, and `inert`, so it can't be clicked or focused on the way out. When the transition ends, it's removed. With no transition or animation, it goes at once.

On `<zb-if>` and `<zb-switch>` it's `animate`. The branch replacing the old one is rendered beside it, so tabs can cross-fade:

```html
<style>
  section { transition: opacity 150ms; grid-area: 1 / 1; }
  @starting-style { section { opacity: 0; } }
  section[data-leaving] { opacity: 0; }
  .panels { display: grid; }   /* both in one cell while they cross */
</style>
<tab-panels tab={"code"}>
  <div class="panels">
    <zb-switch value={tab} animate>
      <zb-case is="code"><section>…</section></zb-case>
      <zb-case is="preview"><section>…</section></zb-case>
    </zb-switch>
  </div>
</tab-panels>
```

## Moving: `animate` on a list

A keyed list moves its rows when their order changes, keeping each row's element. With `animate`, they glide there:

```html
<style>
  ul { position: relative; }
  li { transition: opacity 200ms; --zb-move-duration: 300ms; }
  @starting-style { li { opacity: 0; } }
  li[data-leaving] { opacity: 0; }
</style>
<todo-list todos={[]}>
  <ul>
    <zb-each items={todos} as="todo" key={todo.id} animate>
      <li>{todo.text}</li>
    </zb-each>
  </ul>
</todo-list>
```

Each row that stays is measured before and after the change, then animated from where it was to where it is (the technique called FLIP). Removed rows leave as above, held where they were out of the flow, so the rows after them close the gap as they fade. That's why the `ul` is positioned. `--zb-move-duration` and `--zb-move-easing` set how rows glide; `linear()` gives springy curves.

## People who asked for less

Under `prefers-reduced-motion: reduce`, `animate` stops waiting and gliding: content leaves at once, and rows jump to their places. Your own transitions should stop too:

```css
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0s !important; animation-duration: 0s !important; }
}
```

## What it compiles to

Open the Element tab in the playground. A component that animates gets two short helpers, `leave(nodes, float)` and `glide(elements, change)`, and passes them to its `when()` and `list()`. They are the whole feature, and they're also in `@zubra/runtime/motion` for code that adds and removes elements itself.

**Back to:** [the guide](README.md)
