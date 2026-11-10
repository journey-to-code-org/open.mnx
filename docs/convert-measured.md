# `zubra convert`, measured

*The one objection every developer we asked shared was "every library is React-first", and `zubra convert` is the answer to it. This page says how far it gets on a real React component library.*

## The corpus

[shadcn/ui](https://github.com/shadcn-ui/ui), `apps/v4/registry/new-york-v4/ui` at `42f3bb6` (2026-11-06): 61 files, 325 exported function components, in TypeScript. It's the most-copied React component code there is, and a hard case: most of it wraps a third-party React primitive, and almost every component spreads the rest of its props onto an element.

The run: `zubra convert <file> --prefix ui`, with `--component <Name>` for each component of a file that exports several.

## The result

| | |
|---|---|
| Files built on a React primitive (Radix, cmdk, vaul, Recharts, …) | **46 files refused up front**, with one message naming the library and pointing at the platform, the registry or Zag |
| Components in the other 15 files | 68 |
| …that convert and compile with nothing left to finish | **50** (74%) |

How it gets there:
- **Spread onto an element compiles** (`{...expr}` is a Zubra feature), so it isn't reported.
- **`...props` spread onto the returned element is dropped**, with a note: in Zubra the host *is* the element the consumer sees, and it carries their `id`, `aria-*`, `data-*` and listeners itself.
- **`className` becomes the host's own `class`**: the parameter goes and its uses become `undefined`, so `cn("base", className)` keeps the component's own classes, and the consumer's style the host.
- **The props' React type (`React.ComponentProps<"div">`) goes.**
- **A component built on a React primitive is refused up front.** Reported line by line it would be a dozen unrelated problems; it's one problem: the behaviour is the primitive's, and there's no HTML to convert to.

## What's left in the 18

All are reported with advice, none silently wrong:
- **Spreading onto another component (7)**: `<Button {...props}>`. This was an error because Zubra checks every prop of a child component. Since the next release a spread onto a component is allowed (the entries that are its props are passed as props, the rest go on its host), and a rerun of this corpus at `8ab2771` (the pinned commit isn't fetchable) shows all 7 get past it and stop at the next thing: they import the sibling component by its path in the shadcn repository (`@/registry/new-york-v4/ui/button`), which `convert` doesn't map to a converted `.zb` file, and the siblings (`Button`, `Label`) are Radix-based and refused themselves; `Loader2Icon` is a `lucide-react` icon. So the headline number stays at 50: the spread was a real blocker, but not the only one.
- **Custom hooks and a context provider (6, all in `message-scroller.tsx`)**: the component's state lives in a React context and a custom hook.
- **The rest of the props spread onto an inner element (2)**: `<div><table {...props} /></div>`. The consumer's attributes would land on the host, not the table.
- **One early return, one `children` used as a value, one icon component** that isn't imported as a component.

## What the numbers say

The plain-markup end of a React library converts: cards, alerts, inputs, tables, kbd, skeletons, empty states. The behaviour end doesn't, and shouldn't pretend to. A Radix dialog has no markup of its own to convert; its Zubra equivalent is the platform's `<dialog>`, a registry component, or a Zag machine through `@zubra/runtime/zag`.

## Per file

Converted or reported:

| File | Components | Converted | What's left |
|---|---|---|---|
| `alert.tsx` | 3 | 3 | — |
| `card.tsx` | 7 | 7 | — |
| `empty.tsx` | 6 | 6 | — |
| `field.tsx` | 10 | 7 | `<Label>` isn't an imported component (1), X can only be rendered: put X in the JSX (1), a component function returns once, at the end (1), use conditionals in the returned JSX (1) |
| `input-group.tsx` | 6 | 3 | `<Button>`, `<Input>`, `<Textarea>` aren't imported components (3) |
| `input.tsx` | 1 | 1 | — |
| `kbd.tsx` | 2 | 2 | — |
| `message-scroller.tsx` | 6 | 0 | member expressions as tags (X) aren't supported (5), import the component and use its name (5), X isn't converted (1), props as one object (X) aren't converted (1) |
| `message.tsx` | 6 | 6 | — |
| `native-select.tsx` | 3 | 2 | the rest of the props, used other than spread onto the returned element, aren't converted (1) |
| `pagination.tsx` | 7 | 4 | `<PaginationLink>` isn't an imported component (2), <MoreHorizontalIcon> isn't an imported component (1) |
| `skeleton.tsx` | 1 | 1 | — |
| `spinner.tsx` | 1 | 0 | `<Loader2Icon>` isn't an imported component (1) |
| `table.tsx` | 8 | 7 | the rest of the props, used other than spread onto the returned element, aren't converted (1) |
| `textarea.tsx` | 1 | 1 | — |

Refused up front:

| File | Built on |
|---|---|
| `accordion.tsx` | Radix |
| `alert-dialog.tsx` | Radix |
| `aspect-ratio.tsx` | Radix |
| `attachment.tsx` | Radix |
| `avatar.tsx` | Radix |
| `badge.tsx` | Radix |
| `breadcrumb.tsx` | Radix |
| `bubble.tsx` | Radix |
| `button-group.tsx` | Radix |
| `button.tsx` | Radix |
| `calendar.tsx` | react-day-picker |
| `carousel.tsx` | Embla's React carousel |
| `chart.tsx` | Recharts |
| `checkbox.tsx` | Radix |
| `collapsible.tsx` | Radix |
| `combobox.tsx` | Base UI |
| `command.tsx` | cmdk |
| `context-menu.tsx` | Radix |
| `dialog.tsx` | Radix |
| `direction.tsx` | Radix |
| `drawer.tsx` | vaul |
| `dropdown-menu.tsx` | Radix |
| `form.tsx` | Radix |
| `hover-card.tsx` | Radix |
| `input-otp.tsx` | input-otp |
| `item.tsx` | Radix |
| `label.tsx` | Radix |
| `marker.tsx` | Radix |
| `menubar.tsx` | Radix |
| `navigation-menu.tsx` | Radix |
| `popover.tsx` | Radix |
| `progress.tsx` | Radix |
| `radio-group.tsx` | Radix |
| `resizable.tsx` | react-resizable-panels |
| `scroll-area.tsx` | Radix |
| `select.tsx` | Radix |
| `separator.tsx` | Radix |
| `sheet.tsx` | Radix |
| `sidebar.tsx` | Radix |
| `slider.tsx` | Radix |
| `sonner.tsx` | sonner |
| `switch.tsx` | Radix |
| `tabs.tsx` | Radix |
| `toggle-group.tsx` | Radix |
| `toggle.tsx` | Radix |
| `tooltip.tsx` | Radix |
