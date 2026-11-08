# Zubra with Tailwind, shadcn/ui, MUI and Bootstrap

Your styling system doesn't have to change to use Zubra components. One rule decides how a component gets the app's styles:

- **Light DOM** (the default): the component's markup is part of the page, so the page's CSS applies to it. Use the library's classes in the template.
- **Shadow DOM** (`shadow` on the host tag): page CSS stops at the shadow root, but **CSS custom properties inherit through it**. Read the library's variables, or hand the shadow root the stylesheet with `adoptStyles()`.

All four libraries below put their theme in CSS variables, so a theme switch (dark mode, a brand colour) reaches every Zubra component without code in the component. Each section has a complete app in `examples/frameworks/`, tested in Chromium, live in the [demo gallery](https://journey-to-code-org.github.io/zubra/).

| | Light-DOM components | Shadow-DOM components | Theme switch |
|---|---|---|---|
| **Tailwind 4** | Utility classes in the template | `adoptStyles(css)` with the compiled CSS | `dark:` (media query); class-based dark mode doesn't cross shadow roots |
| **shadcn/ui** | Tailwind classes on shadcn's tokens (`bg-primary`) | `var(--primary)`, `var(--radius)`, … | `.dark` and theme classes swap the variables |
| **MUI** | Scoped styles on `var(--mui-…)` | The same variables | `cssVariables` + `useColorScheme()`, or a new theme |
| **Bootstrap 5** | Bootstrap's classes in the template | `var(--bs-…)` | `data-bs-theme` swaps the variables |

## Tailwind CSS 4

[`examples/frameworks/tailwind-cafe/`](../../examples/frameworks/tailwind-cafe/)

```html
<menu-card item={{}} picked={false}>
  <article class="rounded-2xl border bg-white p-4 shadow-sm dark:bg-stone-900">
    <button class="rounded-lg data-active:bg-roast" data-active={picked ? "" : null}>M</button>
  </article>
</menu-card>
```

- **Tailwind's scanner reads `.zb` files** with its other sources. If your components live somewhere it doesn't look, add `@source "../components";` to the CSS.
- **Variants and arbitrary values work** as in any markup: `hover:`, `aria-pressed:`, `data-active:`, `dark:`, `active:scale-[0.97]`, and your `@theme` colours.
- **Shadow DOM:** import the compiled CSS as a string and adopt it.

  ```js
  import tailwind from './app.css?inline';
  import { adoptStyles } from '@zubra/runtime';
  adoptStyles(tailwind); // every Zubra shadow root, now and later
  ```

  Tailwind 4 declares its theme for `:root, :host`, so its variables exist inside the shadow root too.
- **Class-based dark mode doesn't reach shadow roots.** `@custom-variant dark (&:where(.dark, .dark *))` selects on an ancestor class, and a selector inside a shadow root can't see the page's `<html>`. Either keep the default media-query `dark:` variant, or style shadow components with CSS variables that the class switches (as shadcn does).
- **In a component's `<style>`,** `@reference "tailwindcss";` gives you `@apply` and the theme's values.

## shadcn/ui (and Radix)

[`examples/frameworks/shadcn-invoices/`](../../examples/frameworks/shadcn-invoices/)

Keep shadcn exactly as `npx shadcn add` writes it. Zubra components join in three ways:

- **Light DOM, on shadcn's tokens:** `class="bg-primary text-primary-foreground rounded-md"`, the same classes shadcn's components use. A Zubra badge and a shadcn Button share `--primary`.
- **Shadow DOM, on shadcn's variables:** `background: var(--chart-1); color: var(--muted-foreground); border-radius: var(--radius)`.
- **Inside Radix primitives:** a form-associated Zubra control in a shadcn Dialog (which Radix portals to `<body>`) submits with the form. Zubra events are `on<Event>` props in React (`invoiceopen` → `onInvoiceOpen`).

shadcn's theme picker and `.dark` change the variables, so both shadcn's components and Zubra's restyle together. To give React apps Radix-like widgets without React, see [Accessible widgets without a headless library](accessible-widgets.md).

## MUI

[`examples/frameworks/mui-clinic/`](../../examples/frameworks/mui-clinic/)

MUI styles its own components with CSS-in-JS, which can't style anything else. Turn on its CSS variables:

```js
const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'class' },
  colorSchemes: { light: { palette: { primary: { main: '#00796b' } } }, dark: { palette: { primary: { main: '#4db6ac' } } } },
});
```

MUI then writes `--mui-palette-primary-main`, `--mui-palette-text-secondary`, `--mui-shape-borderRadius`, `--mui-font-body1` and the rest on `<html>`. Zubra components read those in their own styles, light or shadow DOM:

```css
button[aria-checked=true] { background: var(--mui-palette-primary-main); color: var(--mui-palette-primary-contrastText); }
```

`useColorScheme().setMode('dark')` and a new theme object (a different brand colour) both rewrite the variables, and the components follow. A form-associated Zubra control sits in MUI's `FormControl`, and its value comes with `FormData` next to MUI's TextFields.

## Bootstrap 5

[`examples/frameworks/bootstrap-devday/`](../../examples/frameworks/bootstrap-devday/)

```html
<session-list sessions={[]}>
  <div class="list-group">
    <label class="list-group-item d-flex gap-3"><input class="form-check-input" type="checkbox"> …
      <span class="badge rounded-pill text-bg-success">Beginner</span></label>
  </div>
</session-list>
```

- **Light DOM:** Bootstrap's classes in the template, styled by the page's Bootstrap CSS.
- **Shadow DOM:** your Sass variables (`$primary`, `$border-radius-lg`) become `--bs-primary`, `--bs-border-radius-lg` and so on, which a shadow root can read. `data-bs-theme="dark"` switches them.
- **Validation:** a Zubra form control that calls `validity()` matches `:invalid`, so Bootstrap's `.was-validated :invalid ~ .invalid-feedback` shows its message. Give it Bootstrap's invalid border with one rule: `.was-validated my-control:invalid { --border: var(--bs-form-invalid-border-color); }`.
- **Bootstrap's JavaScript** (Modal, Collapse, Dropdown) works around Zubra elements like any other markup.

## Other systems

The same rule covers the rest:
- a system with CSS variables (Open Props, Pico, daisyUI, Radix Themes, Chakra's CSS variables) reaches shadow components;
- a class-based one (Bulma, Foundation, UnoCSS) styles light-DOM components;
- when you want a shadow root to have a whole stylesheet, `adoptStyles()` puts it there.
