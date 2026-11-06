/** Something to run when an effect re-runs or is disposed. */
export type Cleanup = () => void;

/**
 * Run `fn` now and again whenever a signal it read changes (batched: several writes in one task
 * cause one re-run, in a microtask). `fn` may return a cleanup. Returns a function that disposes
 * the effect. Effects created inside another effect or scope belong to it.
 */
export declare function effect(fn: () => void | Cleanup): () => void;

/** An ownership root: disposing, pausing or resuming it applies to every effect inside. */
export interface Scope {
  run<T>(fn: () => T): T;
  dispose(): void;
  pause(): void;
  resume(): void;
  readonly disposed: boolean;
  readonly paused: boolean;
}

/** Create a scope (owned by the current one) and run `fn` in it. */
export declare function scope(fn?: () => void): Scope;

/** Apply pending effect re-runs now, parents before children. */
export declare function flush(): void;

/** Resolves once pending effect re-runs have happened. */
export declare function tick(): Promise<void>;
