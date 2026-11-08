# @mnx-examples/ui

A component library built from the [component registry](../../../registry/) with `mnx build --lib`:

```sh
npm run build        # node ../test/build-ui.mjs: the registry's components, built into dist/
```

It takes every registry component that has no npm dependencies, so it leaves out `combo-box`, which needs Zag.js. A library that included it would list `@zag-js/combobox` and `@zag-js/vanilla` as peer dependencies, which `mnx build --lib` does for any package a component imports.

`dist/` is a package anyone can install and use, without the mnx plugin. It has an ES module per element, React and Vue entries with typings, `custom-elements.json` and `exports`. Two of the framework apps use it the way they would use any package from npm:

| App | Imports |
|---|---|
| [`react-board`](../react-board/) | `import { KanbanColumn } from '@mnx-examples/ui/react'`, and `@mnx-examples/ui/tag-input` (the element) in the converted card editor |
| [`vue-budget`](../vue-budget/) | `import { MoneyInput, SegmentedControl, DonutChart } from '@mnx-examples/ui/vue'` |

Their own, app-specific components stay as `.mnx` files compiled by the plugin, so each app shows both ways of using mnx components.

Inside this repository, each app's `vite.config.js` aliases `@mnx-examples/ui` to `dist/`. The tests build the library first, and so do the apps' `dev` and `build` scripts. Published to npm, the package would be an ordinary dependency, with no alias.
