// TEMPORARY: how each engine applies @scope limits that appear after the first style pass.
import { test } from 'node:test';
import { useBrowser, open } from './harness.js';

useBrowser({});

test('diagnose @scope limits', async (t) => {
  const { page } = await open(`<style>@scope (x-card) to ([data-s]) { h2 { color: rgb(255, 0, 0) } }</style>
    <x-card id="a"><h2 data-s>static limit</h2></x-card>
    <x-card id="b"><h2>later limit</h2></x-card>
    <x-card id="c"><h2>later limit, host touched</h2></x-card>
    <x-card id="d"><h2>later limit, reinserted</h2></x-card>
    <x-card id="e"><h2>later limit, class toggled on h2</h2></x-card>`);
  const result = await page.evaluate(async () => {
    const color = (id) => getComputedStyle(document.querySelector(`#${id} h2`)).color;
    const before = ['a', 'b', 'c', 'd', 'e'].map(color);
    for (const id of ['b', 'c', 'd', 'e']) document.querySelector(`#${id} h2`).setAttribute('data-s', '');
    document.querySelector('#c').setAttribute('data-x', '');
    const d = document.querySelector('#d h2'); d.parentNode.insertBefore(d, d.nextSibling);
    const e = document.querySelector('#e h2'); e.classList.add('x'); e.classList.remove('x');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { before, after: ['a', 'b', 'c', 'd', 'e'].map(color) };
  });
  t.diagnostic(JSON.stringify(result));
  await page.close();
});
