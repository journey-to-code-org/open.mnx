// Vue 3 adapter: an mnx element as a Vue component.
//
//   <script setup>
//   import Rating from './rating.mnx'          // the build plugin wraps it for .vue files
//   </script>
//   <Rating v-model="stars" @change="saved" />
//
// - Props are set as DOM properties when the element is created, before it starts, so it never
//   renders with defaults first. A prop that's left out is the component's default.
// - The component's events are Vue events (`@valuechange`); the handler gets the DOM event.
// - Two-way binding comes from naming: a `<prop>` + `<prop>change` pair supports
//   `v-model:<prop>`, and `v-model` binds the `value` pair (or the only pair, if there's one).
// - Other attributes and listeners (class, style, @click, …) go to the element; slots become its
//   children, named slots with `slot="name"`.
import { defineComponent, h, Text, Comment, Fragment } from 'vue';

const clone = (value) => (value && typeof value === 'object' ? structuredClone(value) : value);
const pascal = (tag) => tag.split(/[-.]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');

/** `<prop>` + `<prop>change` pairs: the component's two-way bindings. */
export function models({ props, events }) {
  return Object.keys(props)
    .filter((name) => events.includes(`${name.toLowerCase()}change`))
    .map((name) => ({ prop: name, event: `${name.toLowerCase()}change` }));
}

/** Give each node of a named slot its `slot` attribute (text gets a <span> to carry it). */
function named(name, nodes) {
  return nodes.flatMap((node) => {
    if (node.type === Fragment) return named(name, node.children ?? []);
    if (node.type === Comment) return [];
    if (node.type === Text || typeof node !== 'object') return [h('span', { slot: name }, node.children ?? String(node))];
    return [h(node, { slot: name })];
  });
}

export function wrap(Element) {
  const meta = Element?.mnx;
  if (!meta) throw new TypeError('mnx: wrap() needs a compiled mnx element (the default export of a .mnx module)');
  const { tag, props, events } = meta;
  const pairs = models(meta);
  const primary = pairs.find((pair) => pair.prop === 'value') ?? (pairs.length === 1 ? pairs[0] : null);

  return defineComponent({
    name: pascal(tag),
    inheritAttrs: false,
    props: {
      ...Object.fromEntries(Object.keys(props).map((name) => [name, { default: undefined }])),
      ...(primary ? { modelValue: { default: undefined } } : {}),
    },
    emits: [
      ...events,
      ...pairs.map((pair) => `update:${pair.prop}`),
      ...(primary ? ['update:modelValue'] : []),
    ],
    setup(given, { attrs, slots, emit, expose }) {
      const listeners = Object.fromEntries(events.map((name) => {
        // `on` + the name as given is how Vue's patchProp attaches a listener for exactly it.
        const key = `on${name[0].toUpperCase()}${name.slice(1)}`;
        return [key, (event) => {
          // Only the element's own event (one from inside with the same name was stopped there).
          emit(name, event);
          for (const pair of pairs) {
            if (pair.event !== name) continue;
            emit(`update:${pair.prop}`, event.detail);
            if (pair === primary) emit('update:modelValue', event.detail);
          }
        }];
      }));
      let element = null;
      expose({ get element() { return element; } });
      return () => {
        // `.name` makes Vue set a DOM property, at creation (before the element starts) and on
        // every update. (Current Vue would also pick a property for a defined element that has
        // it; the prefix doesn't depend on that check.)
        const domProps = {};
        for (const name of Object.keys(props)) {
          let value = given[name];
          if (primary && name === primary.prop && given.modelValue !== undefined) value = given.modelValue;
          domProps[`.${name}`] = value === undefined ? clone(props[name].default) : value;
        }
        const children = [];
        for (const [name, slot] of Object.entries(slots)) {
          const nodes = slot() ?? [];
          children.push(...(name === 'default' ? nodes : named(name, nodes)));
        }
        return h(tag, { ...attrs, ...domProps, ...listeners, ref: (node) => { element = node; } }, children);
      };
    },
  });
}
