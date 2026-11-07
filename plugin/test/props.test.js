// `mnx-props` for Svelte and Solid's server builds (src/props.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addProps, mnxImports, readAttributes } from '../src/props.js';

const tags = new Map([
  ['streak-grid', new Set(['log', 'today', 'weeks', 'label'])],
  ['choice-cards', new Set(['items', 'value', 'name', 'label'])],
]);

test('Svelte: props set by expression, shorthand and bind: go into mnx-props', () => {
  const out = addProps('<streak-grid log={data.log} {today} weeks={8} label="Days" bind:value={x} onpick={(e) => go({ a: e })}></streak-grid>', tags, 'svelte');
  assert.equal(out, '<streak-grid mnx-props={JSON.stringify({ "log": (data.log), today, "weeks": (8) })} log={data.log} {today} weeks={8} label="Days" bind:value={x} onpick={(e) => go({ a: e })}></streak-grid>');
});

test('Solid: prop: and plain attributes; on: handlers and attributes that are no prop are left out', () => {
  const out = addProps('<choice-cards name="course" prop:items={items} prop:value={course()} on:valuechange={(event) => set(event.detail)} class={`a ${b ? "}" : ""}`} />', tags, 'solid');
  assert.equal(out, '<choice-cards mnx-props={JSON.stringify({ "items": (items), "value": (course()) })} name="course" prop:items={items} prop:value={course()} on:valuechange={(event) => set(event.detail)} class={`a ${b ? "}" : ""}`} />');
});

test('hosts that already have mnx-props, or set no prop by expression, are left alone', () => {
  assert.equal(addProps('<streak-grid mnx-props={x} log={y}></streak-grid>', tags, 'svelte'), null);
  assert.equal(addProps('<streak-grid label="Days"></streak-grid><other-tag log={y}>', tags, 'svelte'), null);
  assert.equal(addProps('<streak-grid log={y}>', new Map(), 'svelte'), null);
});

test('every host in the file, and braces inside strings', () => {
  const out = addProps('<p>{"<streak-grid"}</p>\n<streak-grid log={a}/>\n<streak-grid log={{ "}": 1 }}/>', tags, 'svelte');
  assert.equal((out.match(/mnx-props/g) ?? []).length, 2);
  assert.match(out, /"log": \(\{ "\}": 1 \}\)/);
});

test('reading attributes and imports', () => {
  assert.deepEqual(readAttributes('<x a b="1" c={2}>', 2).list.map((a) => [a.name, a.expression]), [['a', null], ['b', null], ['c', '2']]);
  assert.equal(readAttributes('<x a={unclosed', 2), null);
  assert.deepEqual(mnxImports("import '../mnx/a.mnx';\nimport B from \"./b.mnx.jsx\";\nimport { c } from './c.js';"), ['../mnx/a.mnx', './b.mnx.jsx']);
});
