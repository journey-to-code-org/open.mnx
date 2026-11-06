// The TC39 Signals API (https://github.com/tc39/proposal-signals): the platform's own when the
// browser has it, otherwise mnx's implementation.

export declare namespace Signal {
  interface Options<T> {
    /** When two values count as the same (no change): `Object.is` by default. */
    equals?: (this: AnySignal<T>, a: T, b: T) => boolean;
    [Signal.subtle.watched]?: (this: AnySignal<T>) => void;
    [Signal.subtle.unwatched]?: (this: AnySignal<T>) => void;
  }

  type AnySignal<T = any> = State<T> | Computed<T>;
  type AnySink = Computed<any> | subtle.Watcher;

  class State<T> {
    constructor(initialValue: T, options?: Options<T>);
    get(): T;
    set(value: T): void;
  }

  class Computed<T> {
    constructor(computation: (this: Computed<T>) => T, options?: Options<T>);
    get(): T;
  }

  namespace subtle {
    function untrack<T>(fn: () => T): T;
    function currentComputed(): Computed<any> | undefined;
    function introspectSources(sink: AnySink): AnySignal[];
    function introspectSinks(signal: AnySignal): AnySink[];
    function hasSinks(signal: AnySignal): boolean;
    function hasSources(signal: AnySink): boolean;
    const watched: unique symbol;
    const unwatched: unique symbol;

    class Watcher {
      constructor(notify: (this: Watcher) => void);
      watch(...signals: AnySignal[]): void;
      unwatch(...signals: AnySignal[]): void;
      getPending(): AnySignal[];
    }
  }
}

/** True when the browser provides `Signal` natively. */
export declare const isNative: boolean;
