/** Whether the person has asked for less motion (`prefers-reduced-motion: reduce`). */
export declare function reducedMotion(): boolean;
/** Whether `node` is an element on its way out (`leave()` was called on it). */
export declare function isLeaving(node: Node | null | undefined): boolean;
/**
 * Lets `nodes` finish their exit: each element gets `data-leaving` and `inert`, and is removed
 * once the transitions and animations that starts have ended (at once under reduced motion).
 * `float` takes them out of the flow first, so what's around them can move into their space.
 */
export declare function leave(nodes: Iterable<Node>, options?: { float?: boolean }): Promise<unknown>;
/**
 * Runs `change`, then animates each of `elements` from where it was to where it is now (FLIP),
 * using its `--zb-move-duration` and `--zb-move-easing`. Returns what `change` returns.
 */
export declare function glide<T>(elements: Iterable<Element>, change: () => T): T;
