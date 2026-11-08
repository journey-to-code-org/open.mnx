/**
 * The binder for `{...spread}` in compiled components (imported by the compiler's output when a
 * template spreads an object). Not called by hand.
 */
export declare function spread(part: { spread: () => unknown; own?: string[] }, node: Element): void;
