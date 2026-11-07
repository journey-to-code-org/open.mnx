// TEMPORARY: how each engine applies @scope (and its limits) from a <style> and an adopted sheet.
import { test } from 'node:test';
import { useBrowser, open } from './harness.js';

useBrowser({});

test('diagnose @scope', async (t) => {
  const { page } = await open(`<style>
      @scope (x-a) { h2 { color: rgb(255, 0, 0) } }
      @scope (x-b) to ([data-s]) { h2 { color: rgb(255, 0, 0) } }
      @layer components { @scope (x-c) to ([data-s]) { h2 { color: rgb(255, 0, 0) } } }
    </style>
    <x-a><h2>a</h2></x-a><x-b><h2>b</h2><h2 data-s>b-limit</h2></x-b><x-c><h2>c</h2><h2 data-s>c-limit</h2></x-c>
    <x-d><h2>d</h2><h2 data-s>d-limit</h2></x-d><x-e><h2>e</h2><h2 data-s="x-e">e-limit</h2></x-e>`);
  const result = await page.evaluate(async () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('@layer components { @scope (x-d) to ([data-s]) { h2 { color: rgb(255, 0, 0) } } } @scope (x-e) to ([data-s="x-e"]) { h2 { color: rgb(255, 0, 0) } }');
    document.adoptedStyleSheets = [sheet];
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const colors = Object.fromEntries([...document.querySelectorAll('h2')].map((h) => [h.textContent, getComputedStyle(h).color]));
    return {
      ua: navigator.userAgent,
      CSSScopeRule: typeof CSSScopeRule,
      styleRules: [...document.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.constructor.name + ':' + r.cssText.slice(0, 50))),
      adoptedRules: [...sheet.cssRules].map((r) => r.constructor.name + ':' + r.cssText.slice(0, 80)),
      colors,
    };
  });
  t.diagnostic(JSON.stringify(result));
  await page.close();
});
