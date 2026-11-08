# The Zubra component registry

Twenty-five accessible components to copy into your project:

```sh
npx zubra add tag-input modal-dialog         # into src/components/ (--dir elsewhere)
npx zubra add --list
```

`zubra` comes with `@zubra/compiler`. The files are copied, not installed: they're yours to edit, and `zubra add` never overwrites a file you have (`--force` does).

| Inputs | Display | App pieces | Widgets |
|---|---|---|---|
| `tag-input`, `date-range`, `money-input`, `star-rating`, `toggle-switch`, `choice-cards`, `color-swatches`, `quantity-stepper`, `segmented-control` | `donut-chart`, `spark-line`, `line-chart`, `progress-ring`, `streak-grid`, `flip-card`, `step-indicator` | `kanban-column`, `chat-message`, `message-composer`, `modal-dialog` | `accordion-panel`, `tool-tip`, `tab-list`, `dropdown-menu`, `combo-box` |

The widgets are the pieces Radix and shadcn/ui give React apps, built on the platform (`<details>`, `popover`, anchor positioning) and `@zubra/runtime/primitives`. `combo-box` uses Zag.js through `@zubra/runtime/zag`. It imports `@zag-js/vanilla` and `@zag-js/combobox`, and `zubra add` says to install them (`index.json` lists them under `packages`). [Accessible widgets without a headless library](../docs/guide/accessible-widgets.md) maps the rest.

Each component's comment says what it does, its props, slots and events (`index.json` collects them). The inputs are form controls with a two-way `value` (or `checked`), so `v-model`, React's controlled pattern and Angular's `ZubraModel` work with them as they are.

## Accessibility

Every component is tested in Chromium (`test/components.test.js`) the way assistive technology meets it: found by its role and accessible name, used from the keyboard (radio groups, tab lists and menus with arrow keys and one tab stop, typing to jump in a menu, Space and Enter on switches and toggle buttons, a dialog and a menu that move focus in and back, Escape to close), and checked for the state it announces (`aria-checked`, `aria-pressed`, `aria-current`, `aria-expanded`).

## Theming

Colours come from CSS custom properties, each with a default, so the components look right on their own and take your theme when you set them on a parent:

| Property | Used for | Default |
|---|---|---|
| `--ink`, `--muted` | text | `#1d2130`, `#667085` |
| `--surface`, `--sunken`, `--hover` | backgrounds | `#ffffff`, `#f3f4f7`, `#f2f4f8` |
| `--line` | borders | `#d9dce3` |
| `--accent`, `--link`, `--danger` | emphasis | `#4f5df5`, `#2563eb`, `#d92d20` |
| `--up`, `--down` | chart trends | `#12805c`, `#c4320a` |
| `--habit`, `--level-0` | `streak-grid` | `#16a34a`, `#ebedf0` |
| `--chip`, `--chip-ink`, `--column`, `--column-over` | `kanban-column` | `#eceefe`, `#3a3f9e`, `#f3f4f7`, `#e8ebff` |
| `--mention`, `--mention-wash` | `chat-message` | `#8a5a00`, `#fff4cc` |

## Adding one

Put the `.zb` file in `components/`, give it a description comment, add it to a category in `build-index.mjs`, run `node registry/build-index.mjs`, and add its keyboard and screen-reader test.
