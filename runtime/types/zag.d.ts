/**
 * Run a Zag.js machine for this element: started when it connects, stopped when it disconnects
 * (a fresh machine each time it connects). `props` is the machine's props, or a function returning
 * them. `current` is the machine's service, read reactively: pass it to the machine's `connect()`
 * inside a `computed`.
 */
export declare function useMachine<Service = any>(machine: unknown, props?: Record<string, unknown> | (() => Record<string, unknown>)): { readonly current: Service };
/** Zag's prop normalizer for the DOM (attribute names, lowercased listeners): pass it to `connect()`. */
export { normalizeProps } from '@zag-js/vanilla';
