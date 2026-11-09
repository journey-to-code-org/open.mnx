// Server markup with its markers stripped (a sanitizer that removes processing instructions, or
// an HTML minifier's removeComments on a 4.x server's comment markers): which registry components
// hydrate in place, with their markers put back by structure, and which render fresh (each with
// its reason). `node --test registry/test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useBrowser, open, compiler, runtimeOnly } from '../../runtime/test/browser/harness.js';
import * as zag from './zag.js';

const here = dirname(fileURLToPath(import.meta.url));
const names = readdirSync(join(here, '../components')).filter((file) => file.endsWith('.zb')).map((file) => file.slice(0, -3));
useBrowser(Object.fromEntries(names.map((name) => [name, join(here, '../components', `${name}.zb`)])), zag.files, zag.imports);

// Components that can't be placed without their markers, and why. Everything else must hydrate
// in place.
const FRESH = {};

test('stripped server markup: every registry component hydrates in place, or is listed with its reason', { skip: runtimeOnly }, async (t) => {
  // In place means the same server nodes survive as when the markers are kept: a region the
  // server left to the element (a pending zb-await) is rendered by it either way.
  const survivors = async (html, name) => {
    const { page, messages } = await open(html, {
      beforeModules: `window.kept = [...document.body.querySelectorAll('*')].filter((node) => node.localName !== 'script');`,
      modules: [name],
    });
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await Promise.all([...document.querySelectorAll('*')].filter((el) => el.updateComplete).map((el) => el.updateComplete));
    });
    const kept = await page.evaluate(() => window.kept.map((node) => node.isConnected));
    await page.close();
    // (Only zubra's own messages: a component's defaults alone can be meaningless, like a date
    // grid with no dates.)
    return { kept, zubra: messages.filter((message) => message.includes('zubra:')) };
  };
  const results = {};
  for (const name of names) {
    const marked = compiler(join(here, '../components', `${name}.zb`), '--partial');
    const withMarkers = await survivors(marked, name);
    // With its markers, every component hydrates without a word.
    assert.deepEqual(withMarkers.zubra, [], `${name} with its markers`);
    const stripped = await survivors(marked.replace(/<\?zb [^]*?\?>/g, ''), name);
    const same = stripped.kept.length === withMarkers.kept.length && stripped.kept.every((connected, i) => connected === withMarkers.kept[i]);
    results[name] = same && !stripped.zubra.length ? 'in place' : `fresh (${stripped.zubra[0] ?? 'nodes replaced'})`;
  }
  t.diagnostic(Object.entries(results).map(([name, how]) => `${name}: ${how}`).join(', '));
  const fresh = Object.keys(results).filter((name) => results[name] !== 'in place');
  assert.deepEqual(fresh.sort(), Object.keys(FRESH).sort());
});
