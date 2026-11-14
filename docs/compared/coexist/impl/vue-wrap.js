// Lit and Enhance have no Vue output, so their Vue bindings are written by hand with this: a
// Vue component around a custom element that passes every prop as a property, re-emits the
// element's events, and makes `v-model` the element's `value` and `valuechange`.
import { defineComponent, h } from 'vue';

export function wrap(tag, props, { model = false, events = [] } = {}) {
  return defineComponent({
    name: tag,
    props: model ? { ...props, modelValue: props.value } : props,
    emits: model ? [...events, 'valuechange', 'update:modelValue'] : events,
    setup(given, { emit, slots }) {
      const listeners = {};
      for (const event of events) listeners[`on${event[0].toUpperCase()}${event.slice(1)}`] = (e) => emit(event, e);
      if (model) listeners.onValuechange = (e) => (emit('update:modelValue', e.detail), emit('valuechange', e));
      return () => {
        const properties = {};
        for (const name of Object.keys(props)) properties[`.${name}`] = given[name]; // `.name`: always a property
        if (model && given.modelValue !== undefined) properties['.value'] = given.modelValue;
        return h(tag, { ...properties, ...listeners }, slots.default?.());
      };
    },
  });
}
