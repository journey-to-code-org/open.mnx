import type { DefineComponent } from 'vue';
import type { ElementMeta, MnxElementClass } from './index.js';

/** An mnx element as a Vue 3 component: props, events, `v-model` from `<prop>change` pairs. */
export declare function wrap(Element: MnxElementClass): DefineComponent<Record<string, unknown>>;

/** The component's two-way bindings: `<prop>` + `<prop>change` pairs. */
export declare function models(meta: Pick<ElementMeta, 'props' | 'events'>): { prop: string; event: string }[];
