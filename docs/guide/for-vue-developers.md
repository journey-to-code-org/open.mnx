# Zubra for Vue developers

If you write single-file components, Zubra will look familiar: a script, scoped styles and a template in one file, compiled ahead of time to fine-grained DOM updates. The output is a standard custom element instead of a Vue component.

| Vue | Zubra |
|---|---|
| `defineProps({ label: { type: String, default: "Hi" } })` | `<my-greeting label="Hi">`: the host tag's attributes are the props |
| `const count = ref(0)`, `count.value++` | `let count = 0`, `count++` |
| `const doubled = computed(() => count.value * 2)` | `const doubled = count * 2` |
| `const left = ref(props.seconds)` plus `watch(() => props.seconds, (s) => (left.value = s))` | `let left = from(seconds)` |
| `watch(source, (next, prev) => …)` | `watch(source, (next, prev) => …)` |
| `watchEffect(() => …)` | `effect(() => …)` |
| `onMounted`, `onUnmounted` | `onMount`, `onUnmount` |
| `v-if` / `v-else-if` / `v-else` | `<zb-if>` / `<zb-else-if>` / `<zb-else>` |
| `v-for="item in items" :key="item.id"` | `<zb-each items={items} as="item" key={item.id}>` |
| `:class="{ open }"` | `class:open` or `class={{ open }}` |
| `:style="{ fontSize: size + 'px' }"` | `style:font-size={size + "px"}` |
| `@submit.prevent="save"` | `onsubmit.prevent={save}` |
| `@keydown.enter="send"` | `onkeydown.enter={send}` |
| `ref="input"` | `ref={input}` with `let input = null` |
| `defineEmits` + `emit('select', id)` | `emit('select', id)`, imported from `@zubra/runtime`: calling it declares it |
| `defineModel()` | `value:model={…}` on the host |
| `<slot>`, `<slot name="footer">` | `<zb-slot>`, `<zb-slot name="footer">` |
| `$slots.footer` | `hasSlot('footer')` |
| `provide` / `inject` | `provide` / `inject` (with `createContext`) |
| `<style scoped>` | `<style>`: always scoped |

## Using Zubra components in a Vue app

With `@zubra/unplugin`, importing a `.zb` file (or a library built with `zubra build --lib`) into a `.vue` file gives you a Vue component. These are lines of the [budget tracker](../../examples/frameworks/vue-budget):

<!-- snippet: examples/frameworks/vue-budget/src/App.vue#vue-imports -->
```vue
import { MoneyInput, SegmentedControl, DonutChart } from '@zubra-examples/ui/vue';
import BudgetBar from './components/budget-bar.zb';
```

`v-model` binds the `value` and `valuechange` pair, or any `:model` prop with `v-model:name`. The donut's `selected` is one, and the content between its tags goes into the element's slot:

<!-- snippet: examples/frameworks/vue-budget/src/App.vue#vue-donut -->
```vue
<DonutChart v-if="segments.length" v-model="selected" :segments="segments" label="Spending by category">
  <span class="middle-label">{{ selected || 'Spent' }}</span>
  <strong class="middle-total">{{ money(selected ? segments.find((s) => s.label === selected)?.value ?? 0 : spent) }}</strong>
</DonutChart>
```

Events work with `@name`, and props are set as properties, so objects and arrays arrive as values. A form control is a form control: `required` and `min` below are checked by the platform, and `v-model` keeps `draft.amount` in step:

<!-- snippet: examples/frameworks/vue-budget/src/App.vue#vue-money -->
```vue
<MoneyInput v-model="draft.amount" name="amount" :required="true" :min="0.01" label="Amount" />
```

## What you get with Vue

Each line links the test that checks it. The tests run on every push.

- `v-model` on Zubra elements: choosing a donut segment filters the list and choosing it again clears it, and the segmented control switches the kind ([`vue.test.js`](../../examples/frameworks/test/vue.test.js)).
- A reactive object bound inside a `v-for`: one money input per category, written into `state.limits`, and saved across reloads ([`vue.test.js`](../../examples/frameworks/test/vue.test.js)).
- Zubra form controls are form controls. The money input is `:invalid` on the platform while it is empty, and the form won't submit without an amount ([`vue.test.js`](../../examples/frameworks/test/vue.test.js)).
- Under Nuxt, the server HTML carries the elements without JavaScript: light DOM for the stock meters, a declarative shadow root for the genre switch. `v-model` on a Zubra element filters the list after hydration, and the editor's money, stock, tags and featured controls are on `v-model` ([`nuxt-bookshop`](../../examples/meta/nuxt-bookshop/test/app.test.js)).
- Porting one component set to three frameworks, Vue's ports differed least from the source (6 differences, against 21 for React and 20 for Svelte), because `defineModel` and emits map onto a two-way prop and DOM events. That is one agent and one run with one-shot ports, so read it as a measurement, not a ranking ([the experiment](../standards/one-source-n-consumers.md)).
- The same `.zb` file also runs in React, Svelte, Angular, Solid, Lit, Preact, Astro and plain HTML apps, each row checked in CI ([the framework matrix](../framework-matrix.md)).

## What doesn't cross

The general rules, with the reasons, are in [What crosses the boundary](../what-crosses-the-boundary.md): props, events, slots, two-way binding and forms cross; render props, framework context and framework lifecycle don't. For Vue in particular:

- **`provide` / `inject` don't reach into the element.** Pass the value as a prop; between Zubra components use `createContext`.
- **Framework lifecycle** (`<KeepAlive>`, transitions, Suspense) can't act on the element. Loading is a prop or an event.
- **Under Nuxt, an element given Vue children must be `shadow`.** Vue would remove the nodes the element rendered. An element with no Vue children can stay light DOM; `@zubra/unplugin` says which ([Server rendering, honestly](../server-rendering.md)).
- **Event names are lowercase** (`@valuechange`, not `@valueChange`), because they are DOM events.

**Which framework do you use alongside Zubra, and what would a page written for you need to show?** [Tell us in an issue](https://github.com/journey-to-code-org/zubra/issues/new).
