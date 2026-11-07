// resource(): async data as signals. Runs in Node (no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Signal } from '../src/signal.js';
import { effect, scope, tick } from '../src/effect.js';
import { resource } from '../src/resource.js';

const later = () => new Promise((resolve) => setTimeout(resolve, 5));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('loads, re-runs when what it read changes, and keeps the latest result', async () => {
  const id = new Signal.State(1);
  const requests = [];
  let user;
  const owner = scope(() => {
    user = resource(({ signal }) => {
      const request = { id: id.get(), signal, ...deferred() };
      requests.push(request);
      return request.promise;
    }, { initial: null });
  });
  assert.deepEqual([user.status, user.loading, user.value], ['pending', true, null]);

  const seen = [];
  owner.run(() => effect(() => { seen.push(`${user.status}:${user.value?.name ?? '-'}`); }));
  requests[0].resolve({ name: 'Ada' });
  await later(); await tick();
  assert.deepEqual([user.status, user.value], ['ready', { name: 'Ada' }]);

  id.set(2);
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].id, 2);
  assert.equal(user.loading, true);
  assert.deepEqual(user.value, { name: 'Ada' }, 'the previous value stays while the next one loads');

  // A third request before the second answers: the second is aborted and its answer dropped.
  id.set(3);
  await tick();
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve({ name: 'Linus' });
  requests[2].resolve({ name: 'Grace' });
  await later(); await tick();
  assert.deepEqual(user.value, { name: 'Grace' });
  assert.deepEqual(seen, ['pending:-', 'ready:Ada', 'pending:Ada', 'ready:Grace']);

  assert.deepEqual(await user, { name: 'Grace' }, 'awaitable');
  owner.dispose();
  assert.equal(requests[2].signal.aborted, true, 'disposing aborts');
});

test('errors, refresh, and fetchers that throw or return plain values', async () => {
  let fail = true;
  let calls = 0;
  let data;
  scope(() => {
    data = resource(() => {
      calls++;
      if (fail) throw new Error('offline');
      return 42;
    });
  });
  await later();
  assert.equal(data.status, 'error');
  assert.equal(data.error.message, 'offline');
  assert.equal(data.value, undefined);
  fail = false;
  data.refresh();
  await tick(); await later();
  assert.deepEqual([data.status, data.value, data.error, calls], ['ready', 42, undefined, 2]);
  assert.throws(() => resource(42), /takes a function/);
});
