// A device whose cursor is past the end of the log (the log was replaced, compacted, or is another
// one) starts over: pull and live answer from the beginning, with reset: true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backends } from './backends.js';

const at = (n) => `${String(n).padStart(15, '0')}-00000-dev1`;
const change = (key, value, n) => ({ collection: 'seats', key, field: 'v', value, clock: at(n) });
const url = (path) => `http://shop/_zb/sync${path}`;
const push = (sync, changes) => sync.fetch(new Request(url('/push'), { method: 'POST', body: JSON.stringify({ changes }), headers: { 'content-type': 'application/json' } }));
const pull = async (sync, since, scope) => (await sync.fetch(new Request(url(`/pull?since=${since}${scope ? `&scope=${encodeURIComponent(JSON.stringify(scope))}` : ''}`)))).json();
async function firstEvent(response) {
  const reader = response.body.getReader();
  let text = '';
  while (!/event: changes\ndata: .*\n\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  return JSON.parse(/event: changes\ndata: (.*)\n\n/.exec(text)[1]);
}

for (const backend of backends) {
  test(`${backend.name}: pull from past the end starts over, within the scope`, async () => {
    const sync = await backend.start();
    await push(sync, [change('s1/A1', 'held', 1), change('s2/A1', 'other', 2), change('s1/A2', 'free', 3)]);
    const atEnd = await pull(sync, 3);
    assert.deepEqual(atEnd, { changes: [], cursor: 3 }, 'at the end: nothing, and no reset');
    const past = await pull(sync, 999);
    assert.equal(past.reset, true);
    assert.deepEqual(past.changes.map((c) => c.value), ['held', 'other', 'free']);
    assert.equal(past.cursor, 3);
    const scoped = await pull(sync, 999, { seats: 's1/' });
    assert.deepEqual([scoped.reset, scoped.changes.map((c) => c.value)], [true, ['held', 'free']]);
    assert.equal((await pull(sync, 2)).reset, undefined, 'behind the end is the usual pull');
    sync.close();
  });

  test(`${backend.name}: the live stream from past the end starts over, and says so once`, { timeout: 5000 }, async () => {
    const sync = await backend.start();
    await push(sync, [change('s1/A1', 'held', 1), change('s1/A2', 'free', 2)]);
    const first = await firstEvent(await sync.fetch(new Request(url('/live?since=50&peer=p1'))));
    assert.deepEqual([first.reset, first.changes.map((c) => c.value), first.cursor], [true, ['held', 'free'], 2]);
    const usual = await firstEvent(await sync.fetch(new Request(url('/live?since=2&peer=p2'))));
    assert.equal(usual.reset, undefined);
    sync.close();
  });
}
