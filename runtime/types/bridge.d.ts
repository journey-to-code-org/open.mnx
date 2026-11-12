import type { Signal } from './signal.js';

/** A signal, or a function that reads signals (tracked like a computed). */
export type SignalSource<T> = Signal.State<T> | Signal.Computed<T> | (() => T);

export interface BridgeOptions {
  /** Also notify when something inside an array or plain object changes (`items.push(x)`). */
  deep?: boolean;
}

/** An unsubscribe function that is also an RxJS-style `Unsubscribable`. */
export interface Unsubscribe {
  (): void;
  unsubscribe(): void;
}

/**
 * The Svelte store contract and an RxJS-style Subscribable at once: Svelte's `$store`, Solid's
 * `from`, Angular's `toSignal` and RxJS's `from` take it as it is.
 */
export interface SignalStore<T> {
  /** The current value. */
  get(): T;
  /** Call `run` now and on each change. */
  subscribe(run: ((value: T) => void) | { next?(value: T): void }): Unsubscribe;
}

/** A store over a writable signal: also a Svelte writable store. */
export interface WritableSignalStore<T> extends SignalStore<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

/** Call `callback(value)` now and on each change (batched per microtask) until unsubscribed. */
export declare function subscribe<T>(source: SignalSource<T>, callback: (value: T) => void, options?: BridgeOptions): () => void;

/** The source as a store. Writable (`set`, `update`) when the source is a `Signal.State` or has `set`. */
export declare function toStore<T>(source: Signal.State<T>, options?: BridgeOptions): WritableSignalStore<T>;
export declare function toStore<T>(source: SignalSource<T>, options?: BridgeOptions): SignalStore<T>;

/** The source's current value. */
export declare function read<T>(source: SignalSource<T>): T;
/** Whether the source can be written. */
export declare function writable(source: unknown): boolean;
