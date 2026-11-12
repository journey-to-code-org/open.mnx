// tracked(): a resource's reads after an `await`, through `track()` (ECMAScript roadmap E4).
// Runs in Node.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { Signal } from '../src/signal.js';
import { scope, tick } from '../src/effect.js';
import { resource as plain } from '../src/resource.js';
import { tracked } from '../src/track.js';

const resource = (fetcher, options) => plain(tracked(fetcher), options);

// A re-run that never stops should fail, not hang.
const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);

const later = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async () => { await later(); await tick(); await later(); await tick(); };

test('a read after an await re-runs the fetcher when it changes', async () => {
  const id = new Signal.State(1);
  const page = new Signal.State(1);
  const calls = [];
  let list;
  const owner = scope(() => {
    list = resource(async ({ track }) => {
      const user = id.get();
      await later();
      const p = track(() => page.get());
      calls.push(`${user}/${p}`);
      return `${user}/${p}`;
    });
  });
  await settle();
  assert.deepEqual(calls, ['1/1']);
  assert.equal(list.value, '1/1');

  page.set(2);
  await settle();
  assert.deepEqual(calls, ['1/1', '1/2'], 'the later read re-ran it');
  assert.equal(list.value, '1/2');

  id.set(2);
  await settle();
  assert.deepEqual(calls, ['1/1', '1/2', '2/2'], 'the earlier read still does');
  owner.dispose();
});

test('without tracked(), a read after an await is not followed (as before)', async () => {
  const page = new Signal.State(1);
  let runs = 0;
  const owner = scope(() => {
    plain(async () => { await later(); runs++; return page.get(); });
  });
  await settle();
  page.set(2);
  await settle();
  assert.equal(runs, 1);
  owner.dispose();
});

test('track() before the first await is an ordinary tracked read, run once', async () => {
  const id = new Signal.State(1);
  let runs = 0;
  const owner = scope(() => {
    resource(async ({ track }) => { runs++; const value = track(() => id.get()); await later(); return value; });
  });
  await settle();
  id.set(2);
  await settle();
  assert.equal(runs, 2, 'one re-run, not two (the effect and the later-read watcher)');
  owner.dispose();
});

test('reads that keep their value, or new reads appended, do not re-run it', async () => {
  const page = new Signal.State(1);
  const other = new Signal.State('a');
  let runs = 0;
  const owner = scope(() => {
    resource(async ({ track }) => {
      runs++;
      await later();
      track(() => page.get() > 0);
      await later();
      track(() => other.get());
      return null;
    });
  });
  await settle(); await settle();
  assert.equal(runs, 1, 'a second later read was added without a re-run');
  page.set(5); // still > 0
  await settle();
  assert.equal(runs, 1, 'a read whose value is unchanged');
  other.set('b');
  await settle();
  assert.equal(runs, 2);
  owner.dispose();
});

test('a replaced run’s late reads do not subscribe', async () => {
  const id = new Signal.State(1);
  const stale = new Signal.State(0);
  const gates = [];
  let runs = 0;
  const owner = scope(() => {
    resource(async ({ track }) => {
      runs++;
      id.get();
      await new Promise((resolve) => gates.push(resolve));
      track(() => stale.get());
      return null;
    });
  });
  id.set(2); // replaces the first run while it waits
  await tick();
  assert.equal(runs, 2);
  gates[0](); // the first run resumes and reads `stale` after being replaced
  gates[1]();
  await settle();
  const before = runs;
  stale.set(1);
  await settle();
  assert.equal(runs, before + 1, 'only the current run’s read of `stale` re-ran it, once');

  // And a read made only by the replaced run: nothing.
  const onlyOld = new Signal.State(0);
  const gates2 = [];
  let runs2 = 0;
  let first = true;
  const trigger = new Signal.State(0);
  const owner2 = scope(() => {
    resource(async ({ track }) => {
      runs2++;
      trigger.get();
      const mine = first;
      first = false;
      await new Promise((resolve) => gates2.push(resolve));
      if (mine) track(() => onlyOld.get());
      return null;
    });
  });
  trigger.set(1);
  await tick();
  gates2[0](); gates2[1]();
  await settle();
  const runsBefore = runs2;
  onlyOld.set(1);
  await settle();
  assert.equal(runs2, runsBefore, 'the replaced run’s read is not followed');
  owner.dispose();
  owner2.dispose();
});

test('a replaced run that resumes last does not take the current run’s place', async () => {
  const id = new Signal.State(1);
  const page = new Signal.State(0);
  const gates = [];
  let runs = 0;
  const owner = scope(() => {
    resource(async ({ track }) => {
      runs++;
      id.get();
      await new Promise((resolve) => gates.push(resolve));
      track(() => page.get());
      return null;
    });
  });
  id.set(2);
  await tick();
  gates[1](); // the current run resumes, reads `page` and settles first
  await settle();
  gates[0](); // then the replaced one resumes and reads `page` too
  await settle();
  page.set(1);
  await settle();
  assert.equal(runs, 3, 'the current run’s read still re-runs it');
  owner.dispose();
});

test('a replaced run’s read is ignored while the current run is still waiting', async () => {
  const trigger = new Signal.State(0);
  const old = new Signal.State(0);
  const gates = [];
  let runs = 0;
  const owner = scope(() => {
    resource(async ({ track }) => {
      const mine = runs++ === 0;
      trigger.get();
      if (mine) { await later(); track(() => old.get()); }
      await new Promise((resolve) => gates.push(resolve));
      return null;
    });
  });
  await settle(); // run 1 has read `old` and waits
  trigger.set(1); // run 2 replaces it and waits, unsettled
  await settle();
  old.set(1);
  await settle();
  assert.equal(runs, 2, 'no re-run from the replaced run’s read');
  gates.forEach((go) => go());
  await settle();
  assert.equal(Signal.subtle.hasSinks(old), false, 'once the current run settles, the replaced run’s read is let go');
  owner.dispose();
});

test('a change while the run is still waiting replaces it', async () => {
  const page = new Signal.State(1);
  const signals = [];
  const gates = [];
  const owner = scope(() => {
    resource(async ({ signal, track }) => {
      signals.push(signal);
      await later();
      track(() => page.get());
      await new Promise((resolve) => gates.push(resolve));
      return null;
    });
  });
  await settle();
  page.set(2); // the run has read `page` and is waiting on its second await
  await settle();
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true, 'the stale run is aborted');
  gates.forEach((go) => go());
  owner.dispose();
});

test('concurrent resources follow only their own reads', async () => {
  const a = new Signal.State(1);
  const b = new Signal.State(1);
  const runs = { a: 0, b: 0 };
  const owner = scope(() => {
    resource(async ({ track }) => { runs.a++; await later(); return track(() => a.get()); });
    resource(async ({ track }) => { runs.b++; await later(); return track(() => b.get()); });
  });
  await settle();
  a.set(2);
  await settle();
  assert.deepEqual(runs, { a: 2, b: 1 });
  owner.dispose();
});

test('a read that throws rethrows from track(), and is still followed', async () => {
  const ready = new Signal.State(false);
  let r;
  const owner = scope(() => {
    r = resource(async ({ track }) => {
      await later();
      return track(() => { if (!ready.get()) throw new Error('not yet'); return 'ok'; });
    });
  });
  await settle();
  assert.equal(r.status, 'error');
  assert.equal(r.error.message, 'not yet');
  ready.set(true);
  await settle();
  assert.equal(r.status, 'ready');
  assert.equal(r.value, 'ok');
  owner.dispose();
});

test('reads in a callback (not an async function) are followed too', async () => {
  const page = new Signal.State(1);
  let runs = 0;
  const owner = scope(() => {
    resource(({ track }) => { runs++; return later().then(() => track(() => page.get())); });
  });
  await settle();
  page.set(2);
  await settle();
  assert.equal(runs, 2);
  owner.dispose();
});

test('after dispose, nothing re-runs and the later reads are let go', async () => {
  const page = new Signal.State(1);
  let runs = 0;
  const owner = scope(() => {
    resource(async ({ track }) => { runs++; await later(); return track(() => page.get()); });
  });
  await settle();
  assert.equal(Signal.subtle.hasSinks(page), true);
  owner.dispose();
  page.set(2);
  await settle();
  assert.equal(runs, 1);
  assert.equal(Signal.subtle.hasSinks(page), false, 'no watcher keeps `page`');
});

test('dispose() on the resource itself lets the later reads go', async () => {
  const page = new Signal.State(1);
  let r;
  const owner = scope(() => {
    r = resource(async ({ track }) => { await later(); return track(() => page.get()); });
  });
  await settle();
  r.dispose();
  await tick();
  assert.equal(Signal.subtle.hasSinks(page), false);
  owner.dispose();
});

test('a disposed resource’s fetcher still reads, without subscribing', async () => {
  const page = new Signal.State(7);
  let seen;
  const owner = scope(() => {
    resource(async ({ track }) => { await later(); seen = track(() => page.get()); });
  });
  owner.dispose();
  await settle();
  assert.equal(seen, 7);
  assert.equal(Signal.subtle.hasSinks(page), false);
});

test('a paused owner stops following later reads until it resumes', async () => {
  const page = new Signal.State(1);
  let runs = 0;
  const owner = scope(() => {
    resource(async ({ track }) => { runs++; await later(); return track(() => page.get()); });
  });
  await settle();
  owner.pause();
  assert.equal(Signal.subtle.hasSinks(page), false, 'a detached element holds nothing');
  page.set(2);
  await settle();
  assert.equal(runs, 1);
  owner.resume();
  await settle();
  assert.equal(runs, 2, 'it catches up on resume');
  owner.dispose();
});

test('a resource without an async fetcher is unchanged by tracked()', async () => {
  const id = new Signal.State(1);
  let r;
  const owner = scope(() => { r = resource(({ track }) => track(() => id.get()) * 2); });
  await settle();
  assert.equal(r.value, 2);
  id.set(3);
  await settle();
  assert.equal(r.value, 6);
  owner.dispose();
});

test('a read after the run settled (a timer the fetcher left) does not subscribe', async () => {
  const late = new Signal.State(0);
  let runs = 0;
  const owner = scope(() => {
    resource(async ({ track }) => {
      runs++;
      await later();
      if (runs === 1) setTimeout(() => track(() => late.get()), 10);
      return null;
    });
  });
  await settle(); await settle(); await later(); await later();
  late.set(1);
  await settle();
  assert.equal(runs, 1);
  assert.equal(Signal.subtle.hasSinks(late), false);
  owner.dispose();
});
