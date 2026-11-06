// Effects and ownership, built only on the Signals API.
//
// The Signals proposal intentionally leaves effects and scheduling to libraries; this is ours.
// It follows the pattern from the proposal's README (one Watcher, flushed in a microtask) and
// adds what components need:
//
//   effect(fn)        run fn now, re-run it (batched) when what it read changes; returns dispose
//   scope(fn)         an ownership root: effects created inside belong to it
//   flush() / tick()  apply pending re-runs now / await them
//
// Ownership: an effect created while another effect (or a scope) is running belongs to it. When
// the owner re-runs or is disposed, everything it owns is disposed first, so nothing outlives
// the code that created it.
//
// Pausing: a scope can be paused (an element left the DOM) and resumed (it came back). Paused
// effects are unwatched, so long-lived signals hold no reference to them, but each keeps its
// cached result and the versions it last saw. On resume it is re-validated and re-runs only if
// something it depends on changed while it was away — the version check in Signal.Computed does
// exactly that, so no extra bookkeeping is needed here.
import { Signal } from './signal.js';

const { untrack } = Signal.subtle;
const MAX_ROUNDS = 100;

let owner = null;          // the Effect or Scope currently running
let nextId = 0;
let scheduled = null;      // promise for the pending microtask flush
let flushing = false;
const effectOf = new WeakMap();

const watcher = new Signal.subtle.Watcher(() => {
  scheduled ??= new Promise((resolve) => queueMicrotask(() => {
    try { flush(); } finally { scheduled = null; resolve(); }
  }));
});

function report(error) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else console.error(error);
}

class Owner {
  constructor(parent) {
    this.parent = parent;
    this.children = new Set();
    this.disposed = false;
    this.paused = false;
    parent?.children.add(this);
  }

  disposeChildren() {
    for (const child of [...this.children]) child.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeChildren();
    this.parent?.children.delete(this);
  }

  pause() {
    if (this.paused || this.disposed) return;
    this.paused = true;
    for (const child of [...this.children]) child.pause();
  }

  resume() {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    // Children may be replaced while their parent resumes, so iterate a snapshot and skip
    // anything that was disposed along the way.
    for (const child of [...this.children]) if (!child.disposed) child.resume();
  }
}

class Effect extends Owner {
  constructor(fn, parent) {
    super(parent);
    this.id = ++nextId;
    this.cleanup = undefined;
    this.computed = new Signal.Computed(() => {
      this.disposeChildren();
      this.runCleanup();
      const previous = owner;
      owner = this;
      try {
        const result = fn();
        this.cleanup = typeof result === 'function' ? result : undefined;
      } finally {
        owner = previous;
      }
    });
    effectOf.set(this.computed, this);
    watcher.watch(this.computed);
  }

  /** Re-validate: re-runs fn only if a dependency changed since the last run. */
  run() {
    // untrack: if this effect was created inside another effect, the parent must not end up
    // depending on whatever the child reads.
    untrack(() => this.computed.get());
  }

  runCleanup() {
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    if (cleanup) untrack(cleanup);
  }

  dispose() {
    if (this.disposed) return;
    super.dispose();
    watcher.unwatch(this.computed);
    try { this.runCleanup(); } catch (error) { report(error); }
  }

  pause() {
    if (this.paused || this.disposed) return;
    super.pause();
    watcher.unwatch(this.computed);
  }

  resume() {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    watcher.watch(this.computed);
    try { this.run(); } catch (error) { report(error); }
    for (const child of [...this.children]) if (!child.disposed) child.resume();
  }
}

class Scope extends Owner {
  run(fn) {
    const previous = owner;
    owner = this;
    try { return fn(); } finally { owner = previous; }
  }
}

/**
 * Run `fn` now and again whenever a signal it read changes. Re-runs are batched: any number of
 * writes in one task cause one re-run, in a microtask. `fn` may return a cleanup function, which
 * runs before the next run and on dispose. Errors thrown by re-runs are reported, not thrown, so
 * one failing effect doesn't stop the others; an error in the first run is thrown to the caller.
 */
export function effect(fn) {
  const e = new Effect(fn, owner);
  e.run(); // if this throws, the effect stays registered and re-runs when its dependencies change
  return () => e.dispose();
}

/**
 * Create an ownership root and run `fn` inside it. Returns the scope, whose `dispose()`,
 * `pause()` and `resume()` apply to every effect created within (now or by later `run()` calls).
 */
export function scope(fn) {
  const s = new Scope(owner);
  if (fn) s.run(fn);
  return s;
}

/** Apply all pending re-runs synchronously, parents before children. */
export function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (let round = 0; ; round++) {
      const pending = watcher.getPending();
      watcher.watch(); // re-arm before running, so writes made by effects schedule another round
      if (pending.length === 0) return;
      if (round >= MAX_ROUNDS) {
        report(new Error('mnx: effects keep re-triggering each other; stopped after 100 rounds'));
        return;
      }
      const effects = pending.map((computed) => effectOf.get(computed)).sort((a, b) => a.id - b.id);
      for (const e of effects) {
        if (e.disposed || e.paused) continue;
        try { e.run(); } catch (error) { report(error); }
      }
    }
  } finally {
    flushing = false;
  }
}

/** Resolves once pending re-runs have been applied. */
export const tick = () => scheduled ?? Promise.resolve();
