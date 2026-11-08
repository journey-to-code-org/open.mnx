// Which variant of a component an import gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variantFor } from '../src/index.js';

test('the importer decides: React files, Vue files, components, everything else', () => {
  for (const project of ['react', 'vue', 'element']) {
    assert.equal(variantFor('', '/app/App.tsx', project), project === 'vue' ? 'vue' : 'react', 'Vue JSX in a Vue project');
    assert.equal(variantFor('', '/app/App.jsx', project), project === 'vue' ? 'vue' : 'react');
    assert.equal(variantFor('', '/app/App.vue', project), 'vue');
    assert.equal(variantFor('', '/app/App.vue?vue&type=script&setup=true&lang.ts', project), 'vue', 'a .vue file\'s script block');
    assert.equal(variantFor('', '/app/inbox.zb', project), 'element', 'components import elements');
    assert.equal(variantFor('', '/app/badge.zb?zubra=react', project), 'element', 'a wrapper imports its element');
    assert.equal(variantFor('', '/app/util.ts', project), project, 'plain files get the project\'s framework');
    assert.equal(variantFor('', undefined, project), project, 'an entry point too');
  }
});

test('in Solid, Preact and Svelte projects, components are the elements themselves', () => {
  for (const project of ['solid', 'preact', 'svelte']) {
    assert.equal(variantFor('', '/app/App.tsx', project), 'element');
    assert.equal(variantFor('', '/app/App.svelte', project), 'element');
    assert.equal(variantFor('', '/app/util.ts', project), 'element');
    assert.equal(variantFor('react', '/app/App.tsx', project), 'react', 'unless asked');
  }
});

test('a query picks the variant explicitly', () => {
  assert.equal(variantFor('element', '/app/App.tsx', 'react'), 'element');
  assert.equal(variantFor('vue', '/app/App.tsx', 'react'), 'vue');
  assert.equal(variantFor('react', '/app/main.js', 'element'), 'react');
  assert.equal(variantFor('import', '/app/App.tsx', 'react'), 'react', 'other queries are ignored');
});

test('resolveId keeps a variant that is already chosen, with no importer to go by', async () => {
  const { unplugin } = await import('../src/index.js');
  const plugin = unplugin.raw({ framework: 'react' }, { framework: 'vite' });
  const here = new URL('.', import.meta.url).pathname;
  const file = `${here}apps/react/src/App.tsx`.replace('App.tsx', '../../../../../runtime/test/browser/fixtures/card.zb');
  const { resolve } = await import('node:path');
  const path = resolve(file);
  assert.equal(await plugin.resolveId.call({}, `${path}?zubra=element`, undefined), `${path}?zubra=element`);
  assert.equal(await plugin.resolveId.call({}, path, undefined), `${path}?zubra=react`, 'otherwise the project\'s framework');
  assert.equal(await plugin.resolveId.call({}, './x.js', '/app/App.tsx'), null, 'not a component');
});
