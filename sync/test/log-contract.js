// What every sync log promises (`memoryLog`, `sqliteLog`, `durableObjectLog`, and any other a host
// writes): changes come back in the order they were appended, a cursor marks a place in that order
// and pages from it, and values round-trip as JSON. `transactional` logs also promise that a batch
// that fails part-way adds nothing.
//
// Plain functions that throw, so the same cases run under node:test and inside workerd (the edge
// example runs them against a real Durable Object's storage).
import assert from 'node:assert/strict';

const change = (n, value = n, clock = `${String(1_000 + n).padStart(15, '0')}-00000-a`) => ({ collection: 'tasks', key: `t${n}`, field: 'n', value, clock });

export const logContract = [
  ['an empty log has nothing after 0, and its cursor stays put', async (log) => {
    assert.deepEqual(await log.after(0), { changes: [], cursor: 0 });
  }],
  ['append resolves to the cursor after the batch; after(0) is everything, in order', async (log) => {
    assert.equal(Number(await log.append([change(1), change(2)])), 2);
    assert.equal(Number(await log.append([change(3)])), 3);
    const all = await log.after(0);
    assert.deepEqual(all.changes, [change(1), change(2), change(3)]);
    assert.equal(Number(all.cursor), 3);
  }],
  ['values round-trip: null, strings, numbers, booleans, arrays and nested objects', async (log) => {
    const values = [null, 'Buy milk', 0, -2.5, true, false, ['x', { y: 1 }], { deep: { list: [1, null, 'z'] } }];
    await log.append(values.map((value, n) => change(n, value)));
    assert.deepEqual((await log.after(0)).changes.map((c) => c.value), values);
  }],
  ['pages: a limit, then on from the cursor it returned', async (log) => {
    await log.append([1, 2, 3, 4, 5].map((n) => change(n)));
    const first = await log.after(0, 2);
    assert.deepEqual(first.changes.map((c) => c.value), [1, 2]);
    assert.equal(Number(first.cursor), 2);
    const rest = await log.after(first.cursor, 10);
    assert.deepEqual(rest.changes.map((c) => c.value), [3, 4, 5]);
    assert.equal(Number(rest.cursor), 5);
  }],
  ['at the end: nothing more, and the same cursor back', async (log) => {
    await log.append([change(1), change(2)]);
    assert.deepEqual(await log.after(2), { changes: [], cursor: 2 });
  }],
  ['a cursor from a URL (a string) works like the number', async (log) => {
    await log.append([change(1), change(2), change(3)]);
    assert.deepEqual((await log.after('1')).changes.map((c) => c.value), [2, 3]);
  }],
  ['appends made together keep the order they were made in', async (log) => {
    await Promise.all([log.append([change(1)]), log.append([change(2), change(3)]), log.append([change(4)])]);
    assert.deepEqual((await log.after(0)).changes.map((c) => c.value), [1, 2, 3, 4]);
  }],
  ['a batch that fails part-way adds nothing', async (log) => {
    await log.append([change(1)]);
    await assert.rejects(log.append([change(2), { ...change(3), clock: null }]));
    assert.deepEqual((await log.after(0)).changes.map((c) => c.value), [1]);
    // And the log goes on: the next batch lands after the first, nothing between.
    const cursor = Number(await log.append([change(4)]));
    assert.ok(cursor > 1);
    assert.deepEqual((await log.after(0)).changes.map((c) => c.value), [1, 4]);
    assert.deepEqual((await log.after(1)).changes.map((c) => c.value), [4]);
  }, { transactional: true }],
].map(([name, run, { transactional = false } = {}]) => ({ name, run, transactional }));
