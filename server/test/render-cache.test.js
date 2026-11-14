// A render asked for again with the same props is answered from the last one: a component's HTML
// is a function of its sources and what it is rendered with (plan: roadmap-footprint F3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '../src/index.js';
import { createCore } from '../src/core.js';

const components = join(dirname(fileURLToPath(import.meta.url)), 'components');

/** A core over a compiler that counts what it is asked and answers with what it was asked. */
function counting(options = {}, respond = (body) => ({ ok: true, output: `<x-card>${JSON.stringify([body.props, body.slots, body.idPrefix ?? '', body.context ?? {}])}</x-card>` })) {
  const asked = [];
  const core = createCore({
    request: (body) => {
      asked.push(body);
      return respond(body);
    },
    files: new Map([['x-card', '/c/x-card.zb'], ['y-card', '/c/y-card.zb']]),
    sourcesOf: (path) => ({ [path]: '<x-card></x-card>' }),
    base: '/_zubra',
    warn: () => {},
    ...options,
  });
  const renders = () => asked.filter((body) => body.emit === 'html').length;
  return { core, renders, asked };
}

test('the same render is asked of the compiler once, and anything that differs is its own', () => {
  const { core, renders } = counting();
  const first = core.render('x-card', { title: 'Dune', tags: ['a', 'b'] });
  assert.equal(core.render('x-card', { title: 'Dune', tags: ['a', 'b'] }), first, 'the same HTML');
  assert.equal(renders(), 1, 'from one render');
  core.render('x-card', { title: 'Emma', tags: ['a', 'b'] });
  core.render('x-card', { title: 'Dune', tags: ['a'] });
  core.render('x-card', { title: 'Dune', tags: ['a', 'b'] }, { default: '<b>x</b>' });
  core.render('y-card', { title: 'Dune', tags: ['a', 'b'] });
  assert.equal(renders(), 5, 'other props, other slots, another component');
  core.render('x-card', { title: 'Dune', tags: ['a', 'b'] }, { default: '<b>x</b>' });
  core.render('y-card', { title: 'Dune', tags: ['a', 'b'] });
  assert.equal(renders(), 5, 'each of those is kept too');
});

test("a page's later renders, and a provided context, are not mistaken for the first", () => {
  const { core, renders } = counting();
  const one = core.page();
  const a = one.render('x-card', { n: 1 });
  const b = one.render('x-card', { n: 1 }); // the second on the page: its ids get a prefix
  assert.notEqual(a, b);
  assert.equal(renders(), 2);
  const two = core.page();
  assert.equal(two.render('x-card', { n: 1 }), a);
  assert.equal(two.render('x-card', { n: 1 }), b);
  assert.equal(renders(), 2, 'another page asks the same two');
  const themed = core.page();
  themed.provide({ module: './theme.js', export: 'theme' }, 'dark');
  assert.notEqual(themed.render('x-card', { n: 1 }), a);
  assert.equal(renders(), 3, 'with a context provided, it is another render');
});

test('cache: false asks every time, and a promise prop is never kept', () => {
  const uncached = counting({ cache: false });
  uncached.core.render('x-card', { n: 1 });
  uncached.core.render('x-card', { n: 1 });
  assert.equal(uncached.renders(), 2);

  const { core, renders } = counting();
  for (let i = 0; i < 2; i++) {
    const page = core.page();
    page.render('x-card', { n: 1, reviews: Promise.resolve([]) });
    assert.equal(page.pending, true);
  }
  assert.equal(renders(), 2, 'the shell of a streamed component is rendered each time');
});

test('what a render said is said again: a dropped URL is warned about on each page', () => {
  const warnings = [];
  const { core, renders } = counting({ warn: (message) => warnings.push(message) }, () => ({ ok: true, output: '<x-card></x-card>', omitted: ['left out href "javascript:x"'] }));
  core.render('x-card', { href: 'javascript:x' });
  core.render('x-card', { href: 'javascript:x' });
  assert.equal(renders(), 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /<x-card>: left out href/);
});

test('an error is not kept', () => {
  let fail = true;
  const { core, renders } = counting({}, () => (fail ? { ok: false, error: 'no' } : { ok: true, output: '<x-card></x-card>' }));
  assert.throws(() => core.render('x-card', {}), /no/);
  fail = false;
  assert.equal(core.render('x-card', {}), '<x-card></x-card>');
  assert.equal(renders(), 2);
});

test('the least recently used go first: by count, by size, and an answer too large is never kept', () => {
  const { core, renders } = counting();
  core.render('x-card', { n: 0 });
  for (let n = 1; n <= 499; n++) core.render('x-card', { n });
  core.render('x-card', { n: 0 }); // used again: now the most recent
  assert.equal(renders(), 500);
  core.render('x-card', { n: 500 }); // one more than is kept: the oldest (n: 1) goes
  core.render('x-card', { n: 0 });
  assert.equal(renders(), 501, 'the one used again is still there');
  core.render('x-card', { n: 1 });
  assert.equal(renders(), 502, 'the oldest was asked again');

  // By size: each answer here is 300,000 characters, and 8 MB holds 27 of them with their keys.
  const large = counting({}, () => ({ ok: true, output: 'x'.repeat(300_000) }));
  for (let n = 0; n < 30; n++) large.core.render('x-card', { n });
  assert.equal(large.renders(), 30);
  large.core.render('x-card', { n: 29 });
  assert.equal(large.renders(), 30, 'a recent one is kept');
  large.core.render('x-card', { n: 0 });
  assert.equal(large.renders(), 31, 'the first went to make room');

  const huge = counting({}, () => ({ ok: true, output: 'x'.repeat(600_000) }));
  huge.core.render('x-card', { n: 1 });
  huge.core.render('x-card', { n: 1 });
  assert.equal(huge.renders(), 2, 'over half a megabyte: rendered each time');
});

test('with the real compiler: the kept HTML is the HTML a fresh render gives', () => {
  const kept = createZubra({ components });
  const fresh = createZubra({ components, cache: false });
  const props = { name: 'Ada', items: [{ label: 'a', on: true }, { label: 'b' }] };
  const first = kept.render('hello-there', props);
  assert.equal(kept.render('hello-there', { ...props }), first);
  assert.equal(fresh.render('hello-there', props), first);
  assert.notEqual(kept.render('hello-there', { ...props, name: 'Bo' }), first);
});
