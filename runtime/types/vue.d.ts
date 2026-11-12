import type { DefineComponent } from 'vue';
import type { ElementMeta, ZubraElementClass } from './index.js';

/** A zubra element as a Vue 3 component: props, events, `v-model` from `<prop>change` pairs. */
export declare function wrap(Element: ZubraElementClass): DefineComponent<Record<string, unknown>>;

/** The component's two-way bindings: `<prop>` + `<prop>change` pairs. */
export declare function models(meta: Pick<ElementMeta, 'props' | 'events'>): { prop: string; event: string }[];

/** Provide a Context Protocol value (or a signal) to every element inside; renders `<zb-context>`. */
export declare const ZubraContext: DefineComponent<{ context: unknown; value: unknown }>;

/**
 * A Zubra signal (or a function of signals) as a Vue ref; assigning `.value` writes a writable
 * signal. Stops with the current effect scope, or with `stop()`.
 */
export declare function useSignal<T>(source: import('./bridge.js').SignalSource<T>, options?: import('./bridge.js').BridgeOptions): import('vue').Ref<T> & { stop(): void };
