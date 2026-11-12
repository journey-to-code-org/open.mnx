// Reads after an `await` in a resource's fetcher: `resource(tracked(fetcher))`.
//
//   const list = resource(tracked(async ({ signal, track }) => {
//     const token = await auth(signal)
//     return load(token, track(() => page.get()), signal)
//   }))
//
// The Signals API tracks a read only while a Computed is running. A resource's fetcher runs
// inside its effect until its first `await`; the code after that runs later, outside it, so its
// reads are not followed. `tracked()` gives each run `track(read)`: it reads, and when what
// `read` returns changes, the resource runs the fetcher again, as for a read before the
// `await`. The compiler writes `tracked()` and the `track()` calls for an async fetcher in a
// `.zb` script, so this module is loaded only by components that have one.
//
// A run that was replaced or has settled, or a resource that was disposed, still reads through
// `track()`, but no longer subscribes. The reads are watched by an effect owned where `tracked()` was called (a
// component's setup), so a detached element holds none of them and catches up when it returns.
import { Signal } from './signal.js';
import { effect } from './effect.js';

const { untrack, currentComputed } = Signal.subtle;
const THREW = Symbol('threw');

function readOnce(computed) {
  try { return computed.get(); } catch { return THREW; }
}

/** Wraps a resource's fetcher so it is also given `track(read)`, for reads after an `await`. */
export function tracked(fetcher) {
  if (typeof fetcher !== 'function') throw new TypeError('zubra: tracked() takes a function');
  // Read by each run before it can wait, so the resource's effect runs again when it changes.
  const again = new Signal.State(0);
  // The run whose later reads are watched: set when it makes one, and when it settles.
  const tail = new Signal.State(null);
  let latest = null;

  // When a read changes, run again. A new read is appended (and seen) without re-running.
  const stop = effect(() => {
    const watched = tail.get();
    if (!watched) return;
    let changed = false;
    for (const read of watched.run.reads) {
      if (!Object.is(readOnce(read.computed), read.seen)) changed = true; // read each, to keep watching it
    }
    if (changed && watched.run === latest) untrack(() => again.set(again.get() + 1));
  });

  return (context) => {
    again.get();
    const { signal } = context;
    const run = { reads: [] };
    latest = run;
    // The resource aborts a run when the next one starts, or when it is disposed: then no run
    // follows, and nothing is watched any more.
    signal?.addEventListener('abort', () => queueMicrotask(() => { if (latest === run) stop(); }), { once: true });
    const track = (read) => {
      if (typeof read !== 'function') throw new TypeError('zubra: track() takes a function that reads signals');
      // Before the first `await` the resource's effect is running, and tracks the read itself.
      if (currentComputed()) return read();
      // A replaced or finished run (a timer the fetcher left), or a disposed resource: its value
      // can't depend on the read any more, so read without subscribing.
      if (run !== latest || run.done || signal?.aborted) return untrack(read);
      const computed = new Signal.Computed(read);
      run.reads.push({ computed, seen: readOnce(computed) });
      tail.set({ run });
      return computed.get(); // rethrows what `read` threw
    };
    const settled = () => {
      run.done = true;
      // The newest run has finished: stop watching an older run's later reads.
      if (run === latest && untrack(() => tail.get())?.run !== run) tail.set(run.reads.length ? { run } : null);
    };
    const result = fetcher({ ...context, track });
    Promise.resolve(result).then(settled, settled);
    return result;
  };
}
