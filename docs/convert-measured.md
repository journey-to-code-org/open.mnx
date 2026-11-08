# `mnx convert`, measured

*3.2.0, 2026-11-07. `plan/roadmap-4.0.md` challenge 9: the one objection everyone in the survey shared was "every library is React-first", and `mnx convert` is the answer to it. This page says how far it gets on a real React component library, so the claim has a number.*

## The corpus

[shadcn/ui](https://github.com/shadcn-ui/ui), `apps/v4/registry/new-york-v4/ui` at `42f3bb6` (2026-11-06): 61 files, 325 exported function components. It was chosen because it is the most-copied React component code there is, it is written as plain function components (no `forwardRef`, no classes), and it is TypeScript, so it exercises the TS path. It is also a hard case: 45 of the 61 files wrap a third-party React primitive (Radix, cmdk, vaul, recharts, embla, react-day-picker), and almost every component spreads the rest of its props onto an element.

The run: `mnx convert <file> --prefix ui` for a file with one component, and `--component <Name>` for each component of a file with several (3.2 added `--component`; before it, every one of the 61 files was refused at the first step, because they export several components through `export { … }`).

## The result

| | Components |
|---|---|
| Reached the conversion (a function component the tool could find) | 324 of 325 (`sonner.tsx` exports a non-function) |
| Converted with nothing left to finish | **0** |
| Blocked only by spread props (`{...props}` onto an element) | 274 |
| Blocked by spread props and a custom hook or a context from another module | 48 |
| Blocked by a member-expression tag (`<DirectionProvider.Root>`) | 1 |

Spread props are the whole story. The pattern is the same in all 323: `function Badge({ className, variant, ...props }: React.ComponentProps<"span">) { return <span className={cn(…)} {...props} /> }`. mnx checks every attribute against the element at compile time and has no "the rest of the props" concept, so `convert` reports the spread and stops.

What the run also shows:

- **The 3.2 conversions appear once each.** `useContext` from another module (`form.tsx`), reported with the advice to create the context with the runtime's `createContext`; no `useReducer`; passed-on `on…` props don't occur, because shadcn passes everything through the spread.
- **45 files would still need a hand rewrite after spread**, because their markup is a Radix (or other) React primitive, which has no DOM equivalent to convert to. A `<Checkbox>` built on `CheckboxPrimitive.Root` is not a checkbox in HTML; the mnx version would be a `form-associated` element with its own markup, which `registry/components/toggle-switch.mnx` shows the shape of. That is a port, not a conversion, and the tool should say so rather than try.
- **16 files are plain markup** (`alert`, `card`, `empty`, `field`, `input`, `kbd`, `pagination`, `skeleton`, `spinner`, `table`, `textarea`, …). With spread converted, these would convert cleanly. They are the ones a design-system team would convert first.

## What this decides

1. **Spread props are the next `convert` feature, and probably the next compiler feature.** An mnx component could accept `...rest` as "the host's other attributes": the compiler already lets the host take global, `data-`, `aria-` and event attributes, so `{...props}` on the root element maps to "forward the host's attributes to this element", which is a thing the runtime can do without a new concept. A decision record is needed before it ships (3.3 or 3.4).
2. **`--component`** is in 3.2, and it moved the corpus from 0 reached to 324.
3. **A conversion that wraps a third-party React primitive should be refused up front**, with a message that names the primitive and points at the registry component of the same kind, rather than reported as a spread problem. 3.3.

## Per file

| File | Components | Converted | What blocks each |
|---|---|---|---|
| `accordion.tsx` | 4 | 0 | spread attributes aren't converted (4) |
| `alert-dialog.tsx` | 12 | 0 | spread attributes aren't converted (12) |
| `alert.tsx` | 3 | 0 | spread attributes aren't converted (3) |
| `aspect-ratio.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `attachment.tsx` | 9 | 0 | spread attributes aren't converted (9) |
| `avatar.tsx` | 6 | 0 | spread attributes aren't converted (6) |
| `badge.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `breadcrumb.tsx` | 7 | 0 | spread attributes aren't converted (7) |
| `bubble.tsx` | 4 | 0 | spread attributes aren't converted (4) |
| `button-group.tsx` | 3 | 0 | spread attributes aren't converted (3) |
| `button.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `calendar.tsx` | 2 | 0 | spread attributes aren't converted (2) |
| `card.tsx` | 7 | 0 | spread attributes aren't converted (7) |
| `carousel.tsx` | 5 | 0 | X isn't converted (5), spread attributes aren't converted (5) |
| `chart.tsx` | 3 | 0 | X isn't converted (3), spread attributes aren't converted (3) |
| `checkbox.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `collapsible.tsx` | 3 | 0 | spread attributes aren't converted (3) |
| `combobox.tsx` | 14 | 0 | spread attributes aren't converted (14) |
| `command.tsx` | 9 | 0 | spread attributes aren't converted (9) |
| `context-menu.tsx` | 15 | 0 | spread attributes aren't converted (15) |
| `dialog.tsx` | 10 | 0 | spread attributes aren't converted (10) |
| `direction.tsx` | 1 | 0 | member expressions as tags (X) aren't supported (1), import the component and use its name (1) |
| `drawer.tsx` | 10 | 0 | spread attributes aren't converted (10) |
| `dropdown-menu.tsx` | 15 | 0 | spread attributes aren't converted (15) |
| `empty.tsx` | 6 | 0 | spread attributes aren't converted (6) |
| `field.tsx` | 10 | 0 | spread attributes aren't converted (10) |
| `form.tsx` | 5 | 0 | X isn't converted (5), spread attributes aren't converted (5) |
| `hover-card.tsx` | 3 | 0 | spread attributes aren't converted (3) |
| `input-group.tsx` | 6 | 0 | spread attributes aren't converted (6) |
| `input-otp.tsx` | 4 | 0 | spread attributes aren't converted (4), X became X, but its context comes from elsewhere (1) |
| `input.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `item.tsx` | 10 | 0 | spread attributes aren't converted (10) |
| `kbd.tsx` | 2 | 0 | spread attributes aren't converted (2) |
| `label.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `marker.tsx` | 3 | 0 | spread attributes aren't converted (3) |
| `menubar.tsx` | 16 | 0 | spread attributes aren't converted (16) |
| `message-scroller.tsx` | 6 | 0 | X isn't converted (6), spread attributes aren't converted (6), props as one object (X) aren't converted (1) |
| `message.tsx` | 6 | 0 | spread attributes aren't converted (6) |
| `native-select.tsx` | 3 | 0 | spread attributes aren't converted (3) |
| `navigation-menu.tsx` | 8 | 0 | spread attributes aren't converted (8) |
| `pagination.tsx` | 7 | 0 | spread attributes aren't converted (7) |
| `popover.tsx` | 7 | 0 | spread attributes aren't converted (7) |
| `progress.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `radio-group.tsx` | 2 | 0 | spread attributes aren't converted (2) |
| `resizable.tsx` | 3 | 0 | spread attributes aren't converted (3) |
| `scroll-area.tsx` | 2 | 0 | spread attributes aren't converted (2) |
| `select.tsx` | 10 | 0 | spread attributes aren't converted (10) |
| `separator.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `sheet.tsx` | 8 | 0 | spread attributes aren't converted (8) |
| `sidebar.tsx` | 23 | 0 | X isn't converted (23), spread attributes aren't converted (23) |
| `skeleton.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `slider.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `sonner.tsx` | 1 | 0 | no component to convert (1) |
| `spinner.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `switch.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `table.tsx` | 8 | 0 | spread attributes aren't converted (8) |
| `tabs.tsx` | 4 | 0 | spread attributes aren't converted (4) |
| `textarea.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `toggle-group.tsx` | 2 | 0 | X isn't converted (2), spread attributes aren't converted (2) |
| `toggle.tsx` | 1 | 0 | spread attributes aren't converted (1) |
| `tooltip.tsx` | 4 | 0 | X isn't converted (4), spread attributes aren't converted (4) |
