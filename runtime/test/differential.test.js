// Differential tests: every scenario runs against our implementation and against the proposal's
// reference polyfill, and the observable logs must be identical. A scenario only observes what
// the proposal defines (values, recompute counts, notify/watched/unwatched callbacks, pending
// lists, introspection as sets, thrown error types); see runtime/README.md for the few places
// where we deliberately differ, which are tested separately in signal.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Signal as Ours } from '../src/signal-impl.js';
import { Signal as Reference } from 'signal-polyfill';

function both(name, scenario) {
  test(name, () => {
    const ours = run(Ours, scenario);
    const reference = run(Reference, scenario);
    assert.deepEqual(ours, reference);
  });
}

function run(Signal, scenario) {
  const log = [];
  const say = (...parts) => log.push(parts.map(show).join(' '));
  const attempt = (label, fn) => {
    try { say(label, '=', fn()); } catch (error) { say(label, 'threw', error.constructor.name); }
  };
  const names = new Map();
  const name = (signal, label) => (names.set(signal, label), signal);
  const sources = (sink) => Signal.subtle.introspectSources(sink).map((s) => names.get(s) ?? '?').sort();
  const sinks = (signal) => Signal.subtle.introspectSinks(signal).map((s) => names.get(s) ?? '?').sort();
  scenario({ Signal, say, attempt, name, sources, sinks });
  return log;
}

function show(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ---- values and caching --------------------------------------------------------------------

both('state get/set and equality-based change detection', ({ Signal, say }) => {
  const s = new Signal.State(1);
  say(s.get());
  s.set(2);
  say(s.get());
  const custom = new Signal.State({ id: 1 }, { equals: (a, b) => a.id === b.id });
  const w = new Signal.subtle.Watcher(() => say('notified'));
  w.watch(custom);
  custom.set({ id: 1 });
  say('after equal write');
  custom.set({ id: 2 });
  say(custom.get());
});

both('computed is lazy and cached until a dependency changes', ({ Signal, say }) => {
  let runs = 0;
  const s = new Signal.State(2);
  const c = new Signal.Computed(() => (runs++, s.get() * 10));
  say('runs before get', runs);
  say(c.get(), c.get(), 'runs', runs);
  s.set(3);
  say('runs after set, before get', runs);
  say(c.get(), c.get(), 'runs', runs);
});

both('equality cut-off: an unchanged intermediate does not re-run dependents', ({ Signal, say }) => {
  let runs = 0;
  const n = new Signal.State(1);
  const parity = new Signal.Computed(() => n.get() % 2);
  const label = new Signal.Computed(() => (runs++, parity.get() ? 'odd' : 'even'));
  say(label.get(), runs);
  n.set(3);
  say(label.get(), runs);
  n.set(4);
  say(label.get(), runs);
});

both('diamond dependencies compute each node once per change (glitch-free)', ({ Signal, say }) => {
  const runs = { b: 0, c: 0, d: 0 };
  const a = new Signal.State(1);
  const b = new Signal.Computed(() => (runs.b++, a.get() + 1));
  const c = new Signal.Computed(() => (runs.c++, a.get() * 2));
  const d = new Signal.Computed(() => (runs.d++, `${b.get()}/${c.get()}`));
  say(d.get(), runs);
  a.set(5);
  say(d.get(), runs);
  const w = new Signal.subtle.Watcher(() => {});
  w.watch(d);
  a.set(6);
  say(d.get(), runs);
});

both('dynamic dependencies are re-tracked each run', ({ Signal, say, name, sources }) => {
  const flag = name(new Signal.State(true), 'flag');
  const left = name(new Signal.State('L'), 'left');
  const right = name(new Signal.State('R'), 'right');
  const pick = name(new Signal.Computed(() => (flag.get() ? left.get() : right.get())), 'pick');
  say(pick.get(), sources(pick));
  flag.set(false);
  say(pick.get(), sources(pick));
  left.set('L2');
  say(pick.get(), sources(pick));
});

// ---- errors --------------------------------------------------------------------------------

both('computed errors are cached until a dependency changes', ({ Signal, say, attempt }) => {
  let runs = 0;
  const s = new Signal.State(0);
  const c = new Signal.Computed(() => {
    runs++;
    if (s.get() === 0) throw new RangeError('zero');
    return 1 / s.get();
  });
  attempt('first', () => c.get());
  attempt('second', () => c.get());
  say('runs', runs);
  s.set(4);
  attempt('after fix', () => c.get());
  say('runs', runs);
});

both('cycles are detected', ({ Signal, attempt }) => {
  const a = new Signal.Computed(() => b.get());
  const b = new Signal.Computed(() => a.get());
  attempt('a', () => a.get());
  attempt('a again', () => a.get());
});

both('a throwing equals on State propagates from set and keeps the old value', ({ Signal, attempt }) => {
  const s = new Signal.State(1, { equals() { throw new SyntaxError('eq'); } });
  attempt('set', () => s.set(2));
  attempt('get', () => s.get());
});

both('a throwing equals on Computed is cached as its error', ({ Signal, say, attempt }) => {
  let runs = 0;
  const s = new Signal.State(1);
  const c = new Signal.Computed(() => (runs++, s.get()), { equals() { throw new EvalError('ceq'); } });
  attempt('first', () => c.get());
  s.set(2);
  attempt('second', () => c.get());
  attempt('third', () => c.get());
  say('runs', runs);
});

both('equals is called with the signal as this', ({ Signal, say }) => {
  let receiver;
  const s = new Signal.State(1, { equals(a, b) { receiver = this; return a === b; } });
  s.set(2);
  say(receiver === s);
});

// ---- watchers ------------------------------------------------------------------------------

both('watcher notifies synchronously, once, until re-armed with watch()', ({ Signal, say }) => {
  const s = new Signal.State(0);
  const c = new Signal.Computed(() => s.get());
  let w;
  w = new Signal.subtle.Watcher(function () { say('notify', this === w, w.getPending().length); });
  w.watch(c);
  c.get();
  say('set 1'); s.set(1);
  say('set 2'); s.set(2);
  w.watch();
  say('set 3 (rearmed, c still dirty)'); s.set(3);
  c.get();
  w.watch();
  say('set 4 (rearmed, c clean)'); s.set(4);
  say('pending', w.getPending().length);
});

both('a watched computed that was never read has no sources to be notified by', ({ Signal, say }) => {
  const s = new Signal.State(0);
  const c = new Signal.Computed(() => s.get());
  const w = new Signal.subtle.Watcher(() => say('notify'));
  w.watch(c);
  s.set(1);
  say('pending', w.getPending().length, 'value', c.get());
  s.set(2);
});

both('reads and writes are forbidden inside notify', ({ Signal, attempt }) => {
  const s = new Signal.State(0);
  const other = new Signal.State(0);
  const w = new Signal.subtle.Watcher(() => {
    attempt('read', () => other.get());
    attempt('write', () => other.set(1));
    attempt('untracked read', () => Signal.subtle.untrack(() => other.get()));
  });
  w.watch(s);
  s.set(1);
  attempt('read after', () => other.get());
});

both('multiple watchers are notified in subscription order', ({ Signal, say }) => {
  const s = new Signal.State(0);
  const first = new Signal.subtle.Watcher(() => say('first'));
  const second = new Signal.subtle.Watcher(() => say('second'));
  second.watch(s);
  first.watch(s);
  s.set(1);
});

both('getPending lists only dirty computeds, never states', ({ Signal, say }) => {
  const s = new Signal.State(0);
  const c = new Signal.Computed(() => s.get() + 1);
  const w = new Signal.subtle.Watcher(() => {});
  w.watch(s, c);
  c.get();
  s.set(1);
  say(w.getPending().map((x) => x === c));
  c.get();
  say(w.getPending().length);
});

both('watch/unwatch type-check their arguments', ({ Signal, attempt }) => {
  const w = new Signal.subtle.Watcher(() => {});
  attempt('watch object', () => w.watch({}));
  attempt('unwatch number', () => w.unwatch(1));
  attempt('unwatch never-watched', () => w.unwatch(new Signal.State(0)));
});

both('a notify that throws propagates out of set', ({ Signal, attempt }) => {
  const s = new Signal.State(0);
  const w = new Signal.subtle.Watcher(() => { throw new URIError('n'); });
  w.watch(s);
  attempt('set', () => s.set(1));
  attempt('value', () => s.get());
});

// ---- liveness: watched / unwatched and introspection ----------------------------------------

both('watched and unwatched fire as signals enter and leave the live graph', ({ Signal, say }) => {
  const hooks = (label) => ({
    [Signal.subtle.watched]() { say('+' + label); },
    [Signal.subtle.unwatched]() { say('-' + label); },
  });
  const a = new Signal.State(1, hooks('a'));
  const b = new Signal.Computed(() => a.get() * 2, hooks('b'));
  const c = new Signal.Computed(() => b.get() + 1, hooks('c'));
  const w = new Signal.subtle.Watcher(() => {});
  say('watch c'); w.watch(c);
  say('read c'); c.get();
  const w2 = new Signal.subtle.Watcher(() => {});
  say('second watcher on b'); w2.watch(b);
  say('unwatch c'); w.unwatch(c);
  say('unwatch b'); w2.unwatch(b);
});

both('watching a computed that was read while unwatched subscribes its sources', ({ Signal, say }) => {
  const a = new Signal.State(1, { [Signal.subtle.watched]() { say('+a'); } });
  const b = new Signal.Computed(() => a.get(), { [Signal.subtle.watched]() { say('+b'); } });
  b.get();
  new Signal.subtle.Watcher(() => {}).watch(b);
});

both('a computed that becomes watched while stale returns a fresh value', ({ Signal, say }) => {
  const s = new Signal.State(1);
  const c = new Signal.Computed(() => s.get() * 10);
  say(c.get());
  s.set(2);
  new Signal.subtle.Watcher(() => {}).watch(c);
  say(c.get());
  s.set(3);
  say(c.get());
});

both('dynamic dependencies subscribe and unsubscribe live sources', ({ Signal, say }) => {
  const hooks = (label) => ({
    [Signal.subtle.watched]() { say('+' + label); },
    [Signal.subtle.unwatched]() { say('-' + label); },
  });
  const flag = new Signal.State(true);
  const p = new Signal.State('p', hooks('p'));
  const q = new Signal.State('q', hooks('q'));
  const k = new Signal.Computed(() => (flag.get() ? p.get() : q.get()));
  new Signal.subtle.Watcher(() => {}).watch(k);
  say(k.get());
  flag.set(false);
  say(k.get());
  flag.set(true);
  say(k.get());
});

both('introspection reports sources always and sinks only when live', ({ Signal, say, name, sources, sinks, attempt }) => {
  const s = name(new Signal.State(0), 's');
  const c = name(new Signal.Computed(() => s.get()), 'c');
  c.get();
  say('unwatched', sources(c), sinks(s), Signal.subtle.hasSources(c), Signal.subtle.hasSinks(s));
  const w = name(new Signal.subtle.Watcher(() => {}), 'w');
  w.watch(c);
  say('watched', sources(w), sinks(c), sinks(s), Signal.subtle.hasSinks(s));
  attempt('sources of state', () => Signal.subtle.introspectSources(s));
  attempt('sinks of watcher', () => Signal.subtle.introspectSinks(w));
});

both('untrack reads without creating a dependency', ({ Signal, say, sources, name }) => {
  const tracked = name(new Signal.State(1), 'tracked');
  const hidden = name(new Signal.State(10), 'hidden');
  let runs = 0;
  const c = name(new Signal.Computed(() => (runs++, tracked.get() + Signal.subtle.untrack(() => hidden.get()))), 'c');
  say(c.get(), sources(c));
  hidden.set(20);
  say(c.get(), runs);
  tracked.set(2);
  say(c.get(), runs);
});

both('currentComputed is the computed being evaluated', ({ Signal, say }) => {
  say(Signal.subtle.currentComputed() === undefined);
  const outer = new Signal.Computed(() => {
    const inner = new Signal.Computed(() => Signal.subtle.currentComputed() === inner);
    return [Signal.subtle.currentComputed() === outer, inner.get(), Signal.subtle.currentComputed() === outer];
  });
  say(outer.get());
});

both('methods check their receiver', ({ Signal, attempt }) => {
  const s = new Signal.State(1);
  const c = new Signal.Computed(() => 1);
  attempt('State.get', () => s.get.call({}));
  attempt('State.set', () => s.set.call(c, 1));
  attempt('Computed.get', () => c.get.call(s));
});

both('the effect pattern from the proposal README batches into one run', async ({ Signal, say }) => {
  // Synchronous portion only (microtask flush is exercised in effect.test.js).
  const w = new Signal.subtle.Watcher(() => say('schedule'));
  const s = new Signal.State(0);
  let runs = 0;
  const e = new Signal.Computed(() => { runs++; s.get(); });
  w.watch(e);
  e.get();
  s.set(1); s.set(2); s.set(3);
  for (const pending of w.getPending()) pending.get();
  w.watch();
  say('runs', runs);
});

// ---- randomized graphs ---------------------------------------------------------------------

// A seeded generator so failures reproduce.
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomScenario(seed) {
  return ({ Signal, say, attempt }) => {
    const random = prng(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const states = Array.from({ length: 4 }, (_, i) => new Signal.State(i));
    const signals = [...states];
    const runs = [];
    for (let i = 0; i < 8; i++) {
      const index = i;
      runs.push(0);
      const deps = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(signals));
      const branch = pick(states);
      const computed = new Signal.Computed(() => {
        runs[index]++;
        // A data-dependent branch makes the dependency set change over time.
        const chosen = branch.get() % 2 === 0 ? deps : deps.slice(0, 1);
        const total = chosen.reduce((sum, dep) => sum + dep.get(), 0);
        if (total % 7 === 6) throw new Error('unlucky');
        return total % 5;
      });
      signals.push(computed);
    }
    const computeds = signals.slice(states.length);
    const watchers = [0, 1].map((w) => new Signal.subtle.Watcher(() => say('notify', w)));
    for (let step = 0; step < 60; step++) {
      const action = random();
      if (action < 0.35) {
        const s = pick(states);
        const value = Math.floor(random() * 6);
        say('set', states.indexOf(s), value);
        s.set(value);
      } else if (action < 0.65) {
        const c = pick(computeds);
        attempt('get ' + computeds.indexOf(c), () => c.get());
      } else if (action < 0.75) {
        const w = pick(watchers);
        const c = pick(computeds);
        say('watch', watchers.indexOf(w), computeds.indexOf(c));
        w.watch(c);
      } else if (action < 0.85) {
        const w = pick(watchers);
        const c = pick(computeds);
        say('unwatch', watchers.indexOf(w), computeds.indexOf(c));
        w.unwatch(c);
      } else if (action < 0.93) {
        const w = pick(watchers);
        say('pending', watchers.indexOf(w), w.getPending().map((p) => computeds.indexOf(p)).sort());
        w.watch();
      } else {
        say('runs', runs);
      }
    }
    say('final runs', runs);
  };
}

for (let seed = 1; seed <= 300; seed++) both(`random graph #${seed}`, randomScenario(seed));
