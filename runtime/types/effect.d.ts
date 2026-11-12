/**
 * `[Symbol.dispose]()`, so `using` and `DisposableStack` accept it, when the project's `lib`
 * has Explicit Resource Management (`esnext.disposable`, or `esnext`); nothing otherwise, so
 * older `lib` settings still type-check.
 */
export type Disposal = SymbolConstructor extends { readonly dispose: infer K extends symbol }
  ? { [P in K]: () => void }
  : {};

/** Something to run when an effect re-runs or is disposed. */
export type Cleanup = () => void;

/**
 * Run `fn` now and again whenever a signal it read changes (batched: several writes in one task
 * cause one re-run, in a microtask). `fn` may return a cleanup. Returns a function that disposes
 * the effect, and is also disposable (`using stop = effect(…)`). Effects created inside another
 * effect or scope belong to it.
 */
export declare function effect(fn: () => void | Cleanup): (() => void) & Disposal;

/**
 * An ownership root: disposing, pausing or resuming it applies to every effect inside. It's
 * disposable too (`using s = scope(…)`); pausing isn't disposal, and a paused scope resumes.
 */
export interface Scope extends Disposal {
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
