// Server markup with its comments stripped (an HTML minifier's removeComments, a sanitizer, htmx
// in some browsers): which registry components hydrate in place, with their markers put back by
// structure, and which render fresh (each with its reason). `node --test registry/test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useBrowser, open, compiler } from '../../runtime/test/browser/harness.js';
import * as zag from './zag.js';

const here = dirname(fileURLToPath(import.meta.url));
const names = readdirSync(join(here, '../components')).filter((file) => file.endsWith('.mnx')).map((file) => file.slice(0, -4));
useBrowser(Object.fromEntries(names.map((name) => [name, join(here, '../components', `${name}.mnx`)])), zag.files, zag.imports);

// Components that can't be placed without their markers, and why. Everything else must hydrate
// in place.
const FRESH = {};

test('stripped server markup: every registry component hydrates in place, or is listed with its reason', async (t) => {
  const results = {};
  for (const name of names) {
    const html = compiler(join(here, '../components', `${name}.mnx`), '--partial').replace(/<!--[^]*?-->/g, '');
    const { page, messages } = await open(html, {
      beforeModules: `window.kept = [...document.body.querySelectorAll('*')].filter((node) => node.localName !== 'script');`,
      modules: [name],
    });
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await Promise.all([...document.querySelectorAll('*')].filter((el) => el.updateComplete).map((el) => el.updateComplete));
    });
    const kept = await page.evaluate(() => window.kept.every((node) => node.isConnected));
    // (Only mnx's own messages: a component's defaults alone can be meaningless, like a date
    // grid with no dates.)
    const mnx = messages.filter((message) => message.includes('mnx:'));
    results[name] = kept && !mnx.length ? 'in place' : `fresh (${mnx[0] ?? 'nodes replaced'})`;
    await page.close();
  }
  t.diagnostic(Object.entries(results).map(([name, how]) => `${name}: ${how}`).join(', '));
  const fresh = Object.keys(results).filter((name) => results[name] !== 'in place');
  assert.deepEqual(fresh.sort(), Object.keys(FRESH).sort());
});
