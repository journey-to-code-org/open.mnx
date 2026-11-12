// @zubra/runtime/track: reads after an `await` in a resource's fetcher.

/** What a fetcher wrapped by `tracked()` is given for each run. */
export interface TrackedRun {
  /** Aborted when a newer run starts or the resource is disposed. */
  signal: AbortSignal;
  /**
   * Read signals and follow them, after an `await` too: when what `read` returns changes, the
   * resource runs the fetcher again. A replaced run still reads, without subscribing.
   */
  track<V>(read: () => V): V;
}

/**
 * Wraps a resource's fetcher so it is also given `track()`:
 * `resource(tracked(async ({ signal, track }) => …))`. The compiler writes it for an async
 * fetcher in a `.zb` script.
 */
export declare function tracked<T>(fetcher: (run: TrackedRun) => T | PromiseLike<T>): (context: { signal: AbortSignal }) => T | PromiseLike<T>;
