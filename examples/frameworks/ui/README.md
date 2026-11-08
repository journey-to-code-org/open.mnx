# @zubra-examples/ui

A component library built from the [component registry](../../../registry/) with `zubra build --lib`:

```sh
npm run build        # node ../test/build-ui.mjs: the registry's components, built into dist/
```

It takes every registry component that has no npm dependencies, so it leaves out `combo-box`, which needs Zag.js. A library that included it would list `@zag-js/combobox` and `@zag-js/vanilla` as peer dependencies, which `zubra build --lib` does for any package a component imports.

`dist/` is a package anyone can install and use, without the Zubra plugin. It has an ES module per element, React and Vue entries with typings, `custom-elements.json` and `exports`. Two of the framework apps use it the way they would use any package from npm:

| App | Imports |
|---|---|
| [`react-board`](../react-board/) | `import { KanbanColumn } from '@zubra-examples/ui/react'`, and `@zubra-examples/ui/tag-input` (the element) in the converted card editor |
| [`vue-budget`](../vue-budget/) | `import { MoneyInput, SegmentedControl, DonutChart } from '@zubra-examples/ui/vue'` |

Their own, app-specific components stay as `.zb` files compiled by the plugin, so each app shows both ways of using Zubra components.

Inside this repository, each app's `vite.config.js` aliases `@zubra-examples/ui` to `dist/`. The tests build the library first, and so do the apps' `dev` and `build` scripts. Published to npm, the package would be an ordinary dependency, with no alias.
