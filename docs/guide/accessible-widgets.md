# Accessible widgets without a headless library

React apps get dialogs, menus, tabs and comboboxes from a headless library: Radix (the base of shadcn/ui), React Aria, Headless UI. They don't cross into a web component, because they're React. Zubra doesn't have its own headless library. There are three places to get a widget's behaviour instead, from cheapest to most complete:

1. **The platform.** Browsers now do much of what those libraries were written for. `<dialog>` is modal, keeps focus inside and closes on Escape. `popover` puts an element in the top layer and closes it on Escape or a click outside. CSS anchor positioning places it next to its button. `<details name>` makes an accordion. These cost nothing to download, and the browser does the keyboard handling and the announcements.
2. **`@zubra/runtime/primitives`.** This covers the two keyboard behaviours the platform doesn't have. `rovingFocus` gives a group of items one tab stop and arrow keys between them. `typeahead` lets you type a letter to jump to an item. That's what menus, tab lists, toolbars, listboxes and radio groups need. It's 1 KB.
3. **Zag.js, through `@zubra/runtime/zag`.** [Zag](https://zagjs.com) builds the hard widgets as state machines that work in any framework: combobox, date picker, colour picker, tree view, slider, and others. The adapter runs a machine inside a component, and template spread (`{...api.getInputProps()}`) puts Zag's attributes and handlers onto your markup. Zag is an optional peer dependency.

The registry has components built each way (`npx zubra add <name>`). Each is tested by role, accessible name and keyboard, in `registry/test/components.test.js`.

## Radix and shadcn/ui, mapped

| Radix / shadcn | In Zubra | How |
|---|---|---|
| Dialog, AlertDialog | `modal-dialog` | `<dialog>` with `showModal()` |
| Accordion, Collapsible | `accordion-panel` | `<details>`; the same `group` makes them exclusive |
| Popover | `popover` attribute | `popovertarget` on the button; anchor positioning |
| Tooltip | `tool-tip` | `popover="manual"`, `aria-describedby`, Escape hides it |
| Tabs | `tab-list` | `rovingFocus`, automatic or `manual` activation |
| DropdownMenu | `dropdown-menu` | `popover`, `rovingFocus`, `typeahead` |
| Switch | `toggle-switch` | `role=switch` on a button |
| RadioGroup | `choice-cards` | one tab stop, arrow keys |
| ToggleGroup | `segmented-control` | toggle buttons with `aria-pressed` |
| Combobox (shadcn's Command + Popover) | `combo-box` | Zag's combobox machine |
| Select | `<select>`, or Zag's select | `appearance: base-select` styles the native one where it's supported |
| Slider | `<input type=range>`, or Zag's slider | |
| DatePicker, ColorPicker, TreeView, … | Zag | `useMachine` and spread, as in `combo-box` |
| ContextMenu, Menubar, NavigationMenu | Zag's menu, or `rovingFocus` | no registry component yet |

## The platform path

The platform elements are used as they are in any page. The registry components show how to wire them up. For example, `dropdown-menu` comes down to this:

```html
<button popovertarget={menuId} aria-haspopup="menu" style:anchor-name={`--${menuId}`}>{label}</button>
<div popover id={menuId} role="menu" ref={menu} style:position-anchor={`--${menuId}`} ontoggle={toggled}>
  <zb-each items={items} as="item" key={item.value}>
    <button role="menuitem" tabindex="-1" onclick={() => choose(item)}>{item.label}</button>
  </zb-each>
</div>
```

The browser opens and closes the menu and handles Escape and clicks outside it. The script does the rest:

```js
import { onMount } from '@zubra/runtime'
import { rovingFocus, typeahead } from '@zubra/runtime/primitives'

onMount(() => {
  const roving = rovingFocus(menu, { selector: '[role=menuitem]', orientation: 'vertical' })
  const typing = typeahead(menu, { selector: '[role=menuitem]' })
  return () => { roving(); typing() }
})
```

`rovingFocus` finds the items again on each key press, so a list that changes needs nothing more. It skips disabled and hidden items, and in a right-to-left page it swaps Left and Right. `onMove` runs after each move, for widgets where selection follows focus, such as tabs. `typeahead` can call `onMatch` instead of moving focus, for widgets that use `aria-activedescendant`.

Without a bundler, a page's import map needs an `@zubra/runtime/primitives` entry, as it does for `@zubra/runtime/spread`. `@zubra/server` adds both.

Anchor positioning isn't in every browser yet. Without it, `tool-tip` and `dropdown-menu` place themselves with a few lines of script. They check with `CSS.supports("position-area: …")`.

## The Zag path

```js
import * as combobox from '@zag-js/combobox'
import { id, computed } from '@zubra/runtime'
import { useMachine, normalizeProps } from '@zubra/runtime/zag'

const uid = id() // once: Zag's ids must stay the same
const machine = useMachine(combobox.machine, () => ({ id: uid, collection, onValueChange }))
const api = computed(() => combobox.connect(machine.current, normalizeProps))
```

```html
<input {...api.getInputProps()}>
```

The props function is read again whenever Zag asks for it, so it can read state and props. The `api` computed updates when the machine changes. Each time the element connects, it gets a fresh machine, because a Zag machine can't be restarted once it has stopped. That means moving the element, or removing it and putting it back, keeps working. `npm install @zag-js/vanilla @zag-js/<machine>`; `zubra add combo-box` prints that line.

## What it costs

Gzip, minified, on top of the runtime:

| Widget | Platform path | With Zag |
|---|---|---|
| Accordion | 0.8 KB (`accordion-panel`) | |
| Tooltip | 1.3 KB (`tool-tip`) | +2.4 KB for the machine |
| Tabs | 1.3 KB (`tab-list`) + 1.0 KB primitives | +2.9 KB |
| Menu | 1.8 KB (`dropdown-menu`) + 1.0 KB primitives | +8.3 KB |
| Combobox | | 1.4 KB (`combo-box`) + 32.6 KB (Zag core, the adapter and the combobox) |

The primitives are counted once, however many widgets use them. So is Zag's core (about 6 KB), however many machines you use. The combobox is the large one. Zag's combobox brings in its list collection, its positioning and its dismissal handling. Use it when you need a combobox. A `<select>`, or an `<input list>` with a `<datalist>`, costs nothing.

These were measured with esbuild (minified, then gzipped), on Zag 1.47.
