# Recipes (Astro)

The complex example: a small recipe site built with Astro, where Zubra components are the
page's building blocks and only the interactive ones ship JavaScript.

```sh
cd examples/recipes
npm install
npm run dev        # or: npm run build && npm run preview
```

The example links the packages in this repository, so the compiler needs building once: either
`npm run build` in `compiler/` (WebAssembly; needs the `wasm32-unknown-unknown` Rust target), or
`cargo build` at the root and `ZUBRA_COMPILER=../../target/debug/zubra npm run dev`.

## What it shows

| Component | Kind | Rendered | What it uses |
| --- | --- | --- | --- |
| `recipe-card.zb` | `.zb`, static | server only, no JS | props, a slot (the tags), scoped `<style>` |
| `recipe-servings.zb.tsx` | JSX | server, hydrated with `client:load` | `let` state from a prop, derived values, a keyed `.map()` list |
| `recipe-reviews.zb` | `.zb` | server, hydrated with `client:visible` | `resource()` + `<zb-await>` (loading, loaded, error), state, a form |
| `star-rating.zb` | `.zb`, form-associated | inside the reviews | `formValue`, `validity`, `onFormReset`, `emit` |

- **The index** (`src/pages/index.astro`) is a grid of `<RecipeCard>`s. They're rendered at build
  time and never defined in the browser: the page has no `<script>` at all.
- **A recipe page** (`src/pages/recipes/[id].astro`) has two islands. The servings scaler
  multiplies every amount as you change the number of people. The reviews load from
  `public/data/reviews/<id>.json` once they scroll into view.
- **`<star-rating>` is a real form control.** Inside the review form it submits under its
  `name`, keeps the form from submitting while `required` and unset, and clears when the form
  resets. With `readonly` it displays a rating, which is how each review shows its stars.
- **Styles.** `.zb` components carry scoped styles (`@scope`, so page CSS doesn't leak in and
  theirs doesn't leak out). The JSX component is in the light DOM and styled from the layout,
  as any element is. The layout puts its global CSS in the `base` cascade layer, under the components' scoped styles, so a global `a { color }` doesn't override a card's. Colors come from custom properties, with a dark theme.

Server rendering covers what depends on props only. Text that comes from state (the scaled
amounts, the reviews) is left as a placeholder in the HTML and filled in when the island
hydrates.

`plugin/test/examples.test.js` builds this site and checks both: the HTML Astro writes, and the
pages in a browser.
