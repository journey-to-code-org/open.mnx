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

With `@zubra/unplugin`, importing a `.zb` file into a `.vue` file gives you a Vue component: `v-model` binds the `value` + `valuechange` pair (or any `:model` prop with `v-model:name`), events work with `@name`, and slots map to slots.

```vue
<script setup>
import { ref } from 'vue';
import QuantityStepper from './components/quantity-stepper.zb';
const tickets = ref(1);
</script>
<template>
  <QuantityStepper v-model="tickets" :max="4" />
</template>
```
