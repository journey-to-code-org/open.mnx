import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Signal } from '../src/signal.js';
import { effect, scope, root, flush, tick, DISPOSE } from '../src/effect.js';

const { hasSinks } = Signal.subtle;

function captureErrors() {
  const errors = [];
  const original = globalThis.reportError;
  globalThis.reportError = (error) => errors.push(error);
  return { errors, restore: () => { globalThis.reportError = original; } };
}

test('runs immediately, then once per batch of writes', async () => {
  const s = new Signal.State(0);
  const seen = [];
  const dispose = effect(() => { seen.push(s.get()); });
  assert.deepEqual(seen, [0]);
  s.set(1); s.set(2); s.set(3);
  assert.deepEqual(seen, [0], 'writes are batched, not applied synchronously');
  await tick();
  assert.deepEqual(seen, [0, 3]);
  dispose();
});

test('flush() applies pending re-runs synchronously', () => {
  const s = new Signal.State('a');
  let last;
  const dispose = effect(() => { last = s.get(); });
  s.set('b');
  flush();
  assert.equal(last, 'b');
  dispose();
});

test('an equal write does not re-run; an unchanged derived value does not re-run', async () => {
  const n = new Signal.State(1);
  const parity = new Signal.Computed(() => n.get() % 2);
  let runs = 0;
  const dispose = effect(() => { runs++; parity.get(); });
  n.set(1);
  n.set(3);
  await tick();
  assert.equal(runs, 1);
  n.set(4);
  await tick();
  assert.equal(runs, 2);
  dispose();
});

test('cleanup runs before each re-run and on dispose, and its reads are not tracked', async () => {
  const s = new Signal.State(0);
  const untracked = new Signal.State(0);
  const log = [];
  const dispose = effect(() => {
    const value = s.get();
    log.push(`run ${value}`);
    return () => { untracked.get(); log.push(`cleanup ${value}`); };
  });
  s.set(1);
  await tick();
  untracked.set(1);
  await tick();
  dispose();
  assert.deepEqual(log, ['run 0', 'cleanup 0', 'run 1', 'cleanup 1']);
});

test('dispose stops re-runs and releases every subscription', async () => {
  const s = new Signal.State(0);
  let runs = 0;
  const dispose = effect(() => { runs++; s.get(); });
  assert.equal(hasSinks(s), true);
  dispose();
  assert.equal(hasSinks(s), false);
  s.set(1);
  await tick();
  assert.equal(runs, 1);
});

test('nested effects belong to their parent and are replaced when it re-runs', async () => {
  const outer = new Signal.State(0);
  const inner = new Signal.State(0);
  const log = [];
  const dispose = effect(() => {
    const o = outer.get();
    effect(() => {
      log.push(`inner ${o}/${inner.get()}`);
      return () => log.push(`inner cleanup ${o}`);
    });
  });
  inner.set(1);
  await tick();
  outer.set(1);
  await tick();
  inner.set(2);
  await tick();
  assert.deepEqual(log, [
    'inner 0/0',
    'inner cleanup 0', 'inner 0/1',
    'inner cleanup 0', 'inner 1/1',   // parent re-ran: old child disposed, new one created
    'inner cleanup 1', 'inner 1/2',   // only the new child reacts
  ]);
  dispose();
  assert.equal(hasSinks(inner), false);
});

test("a child's reads do not become its parent's dependencies", async () => {
  const childOnly = new Signal.State(0);
  let parentRuns = 0;
  const dispose = effect(() => {
    parentRuns++;
    effect(() => { childOnly.get(); });
  });
  childOnly.set(1);
  await tick();
  assert.equal(parentRuns, 1);
  dispose();
});

test('a parent re-runs before its children, and a child it replaced never runs', async () => {
  const s = new Signal.State(0);
  const log = [];
  const dispose = effect(() => {
    const v = s.get();
    log.push(`parent ${v}`);
    effect(() => { log.push(`child of ${v} sees ${s.get()}`); });
  });
  s.set(1);
  await tick();
  assert.deepEqual(log, ['parent 0', 'child of 0 sees 0', 'parent 1', 'child of 1 sees 1']);
  dispose();
});

test('an error in one re-run is reported and does not stop the others', async () => {
  const { errors, restore } = captureErrors();
  try {
    const s = new Signal.State(0);
    let healthyRuns = 0;
    const d1 = effect(() => { if (s.get() === 1) throw new Error('bad value'); });
    const d2 = effect(() => { healthyRuns++; s.get(); });
    s.set(1);
    await tick();
    assert.equal(healthyRuns, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /bad value/);
    s.set(2);
    await tick();
    assert.equal(errors.length, 1, 'the failing effect recovers once its input is fixed');
    d1(); d2();
  } finally {
    restore();
  }
});

test('effects that keep re-triggering each other are stopped and reported', () => {
  const { errors, restore } = captureErrors();
  try {
    const a = new Signal.State(0);
    const b = new Signal.State(0);
    const d1 = effect(() => { b.set(a.get() + 1); });
    const d2 = effect(() => { a.set(b.get() + 1); });
    flush();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /re-triggering/);
    d1(); d2();
  } finally {
    restore();
  }
});

test('writes made by an effect are applied in the same flush', () => {
  const source = new Signal.State(1);
  const doubled = new Signal.State(0);
  let seen;
  const d1 = effect(() => { doubled.set(source.get() * 2); });
  const d2 = effect(() => { seen = doubled.get(); });
  source.set(5);
  flush();
  assert.equal(seen, 10);
  d1(); d2();
});

test('a scope owns every effect created inside it', async () => {
  const s = new Signal.State(0);
  let runs = 0;
  const root = scope(() => {
    effect(() => { runs++; s.get(); });
    effect(() => { runs++; s.get(); });
  });
  root.run(() => effect(() => { runs++; s.get(); }));
  assert.equal(runs, 3);
  root.dispose();
  assert.equal(hasSinks(s), false);
  s.set(1);
  await tick();
  assert.equal(runs, 3);
});

test('pause releases subscriptions; resume re-runs only if something changed meanwhile', async () => {
  const s = new Signal.State(0);
  const other = new Signal.State('x');
  const log = [];
  const root = scope(() => {
    effect(() => { log.push(`s=${s.get()}`); });
    effect(() => { log.push(`other=${other.get()}`); });
  });
  root.pause();
  assert.equal(hasSinks(s), false, 'a paused (detached) component is not retained by the signals it read');
  assert.equal(hasSinks(other), false);
  s.set(1);
  await tick();
  assert.deepEqual(log, ['s=0', 'other=x'], 'paused effects do not run');
  root.resume();
  assert.deepEqual(log, ['s=0', 'other=x', 's=1'], 'only the effect whose input changed re-runs');
  other.set('y');
  await tick();
  assert.deepEqual(log, ['s=0', 'other=x', 's=1', 'other=y'], 'resumed effects are live again');
  root.dispose();
});

test('resuming a parent that must re-run replaces its children instead of resuming them', async () => {
  const s = new Signal.State(0);
  const log = [];
  const root = scope(() => {
    effect(() => {
      const v = s.get();
      effect(() => { log.push(`child ${v}`); });
    });
  });
  root.pause();
  s.set(1);
  root.resume();
  assert.deepEqual(log, ['child 0', 'child 1']);
  root.dispose();
});

test('500 paused effects on one long-lived signal hold no subscriptions', () => {
  const shared = new Signal.State(0);
  const roots = Array.from({ length: 500 }, () => scope(() => effect(() => { shared.get(); })));
  assert.equal(Signal.subtle.introspectSinks(shared).length, 500);
  roots.forEach((root) => root.pause());
  assert.equal(Signal.subtle.introspectSinks(shared).length, 0);
  roots.forEach((root) => root.dispose());
});

test("a child that throws does not re-run its parent (the parent never depends on the child)", async () => {
  // Without untrack the parent would depend on the child's computed. Normally harmless (an
  // effect's computed always yields undefined, so equality cut-off hides it) — but an error is a
  // new value, and would re-run the parent.
  const { errors, restore } = captureErrors();
  try {
    const childOnly = new Signal.State(0);
    let parentRuns = 0;
    const dispose = effect(() => {
      parentRuns++;
      effect(() => { if (childOnly.get() === 1) throw new Error('child failed'); });
    });
    childOnly.set(1);
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(parentRuns, 1);
    dispose();
  } finally {
    restore();
  }
});

test('parents still run first after disposals reorder the watched set', async () => {
  const s = new Signal.State(0);
  const log = [];
  const early = effect(() => { s.get(); });
  const dispose = effect(() => {
    const v = s.get();
    log.push(`parent ${v}`);
    effect(() => { log.push(`child of ${v} sees ${s.get()}`); });
  });
  early(); // swap-removal moves the newest (the child) ahead of its parent in the watcher
  s.set(1);
  await tick();
  assert.deepEqual(log, ['parent 0', 'child of 0 sees 0', 'parent 1', 'child of 1 sees 1']);
  dispose();
});

test('disposing a scope of many effects releases every subscription at once', async () => {
  const { batch } = await import('../src/effect.js');
  const shared = new Signal.State(0);
  const rows = scope(() => { for (let i = 0; i < 2000; i++) effect(() => { shared.get(); }); });
  assert.equal(hasSinks(shared), true);
  rows.dispose();
  assert.equal(hasSinks(shared), false, 'released synchronously');
  // Inside batch(), the release happens at its end.
  const more = [scope(() => effect(() => { shared.get(); })), scope(() => effect(() => { shared.get(); }))];
  batch(() => {
    for (const owner of more) owner.dispose();
    assert.equal(hasSinks(shared), true, 'not yet');
  });
  assert.equal(hasSinks(shared), false);
});

// ---- Explicit Resource Management: `using` and DisposableStack (roadmap-ecmascript E3) -------

test('DISPOSE is Symbol.dispose, or the symbol polyfills and downlevel `using` use without it', () => {
  assert.equal(DISPOSE, Symbol.dispose ?? Symbol.for('Symbol.dispose'));
});

test("an effect's dispose function is disposable: Symbol.dispose stops it and runs its cleanup", async () => {
  const s = new Signal.State(0);
  const log = [];
  const stop = effect(() => { log.push(`run ${s.get()}`); return () => log.push('cleanup'); });
  assert.equal(stop[DISPOSE], stop);
  stop[DISPOSE]();
  assert.equal(hasSinks(s), false);
  s.set(1);
  await tick();
  assert.deepEqual(log, ['run 0', 'cleanup']);
});

test('scopes and roots are disposable: Symbol.dispose disposes everything inside', async () => {
  const s = new Signal.State(0);
  let runs = 0;
  for (const make of [scope, root]) {
    const owner = make(() => { effect(() => { runs++; s.get(); }); });
    owner[DISPOSE]();
    assert.equal(owner.disposed, true);
  }
  assert.equal(hasSinks(s), false);
  s.set(1);
  await tick();
  assert.equal(runs, 2);
});

test('pausing is not disposal: a paused scope resumes, and only Symbol.dispose ends it', async () => {
  const s = new Signal.State(0);
  const log = [];
  const owner = scope(() => effect(() => { log.push(s.get()); }));
  owner.pause();
  s.set(1);
  owner.resume();
  assert.equal(owner.disposed, false);
  s.set(2);
  await tick();
  assert.deepEqual(log, [0, 1, 2], 'resumed and live');
  owner[DISPOSE]();
  s.set(3);
  await tick();
  assert.deepEqual(log, [0, 1, 2]);
});

test('a DisposableStack owns effects and scopes, disposing them last-in first-out', { skip: typeof DisposableStack !== 'function' && 'no DisposableStack in this Node' }, () => {
  const order = [];
  const stack = new DisposableStack();
  stack.use(effect(() => () => order.push('effect')));
  stack.use(scope(() => effect(() => () => order.push('scope'))));
  stack.dispose();
  assert.deepEqual(order, ['scope', 'effect']);
});

test('`using` disposes an effect, a scope and a resource when the block ends, last first', { skip: typeof DisposableStack !== 'function' && 'no `using` in this Node' }, async () => {
  const { leaveBlock } = await import('./using/block.js');
  const { log, aborted } = await leaveBlock();
  assert.deepEqual(log, ['run 0', 'scope cleanup', 'effect cleanup'], 'the effect never re-ran');
  assert.equal(aborted, true, "the resource's request was aborted");
});
