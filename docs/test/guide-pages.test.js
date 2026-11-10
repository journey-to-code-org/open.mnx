// The "Zubra for … developers" pages: their code is the code the example apps run in CI, their links
// resolve, and they all have the same sections. (The checks live in snippets.mjs; this file runs them
// over the pages and tests the checks.)
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brokenLinks, claimProblems, dedent, pageSnippets, regions, shapeProblems, snippetProblems } from './snippets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const guide = join(root, 'docs/guide');

/** The framework pages this repository has (added to as each page takes the shared shape). */
export const PAGES = ['for-angular-developers.md'];

for (const name of PAGES) {
  test(`${name}: snippets match the example apps, links resolve, sections are all there`, () => {
    const file = join(guide, name);
    const markdown = readFileSync(file, 'utf8');
    assert.deepEqual(snippetProblems(markdown, root, name), []);
    assert.deepEqual(brokenLinks(markdown, file), []);
    assert.deepEqual([...shapeProblems(markdown, name), ...claimProblems(markdown, name)], []);
  });
}

test('dedent removes shared indentation and blank edges', () => {
  assert.equal(dedent('\n    a\n      b\n\n    c  \n\n'), 'a\n  b\n\nc');
  assert.equal(dedent(''), '');
});

test('regions are read between markers, in any kind of comment, dedented', () => {
  const source = ['<template>', '  <!-- zubra-snippet:start stepper -->', '  <Stepper v-model="n" />', '  <!-- zubra-snippet:end stepper -->', '</template>',
    '// zubra-snippet:start b', '  let x = 1', '// zubra-snippet:end b'].join('\n');
  const found = regions(source);
  assert.equal(found.get('stepper'), '<Stepper v-model="n" />');
  assert.equal(found.get('b'), 'let x = 1');
});

test('badly marked files are errors, not silent', () => {
  assert.throws(() => regions('// zubra-snippet:start a\nx'), /never closed/);
  assert.throws(() => regions('// zubra-snippet:end a'), /without its start/);
  assert.throws(() => regions('// zubra-snippet:start a\n// zubra-snippet:start b'), /still open/);
  assert.throws(() => regions('// zubra-snippet:start a\n// zubra-snippet:end a\n// zubra-snippet:start a\n// zubra-snippet:end a'), /defined twice/);
  assert.throws(() => regions('// zubra-snippet:start a\n// zubra-snippet:end b'), /without its start/);
});

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-pages-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const PAGE = (code, source = 'app/App.vue#stepper') => `# Zubra for Vue developers\n\n<!-- snippet: ${source} -->\n\`\`\`vue\n${code}\n\`\`\`\n`;
const APP = '<template>\n  <!-- zubra-snippet:start stepper -->\n  <Stepper v-model="n" :max="4" />\n  <!-- zubra-snippet:end stepper -->\n</template>\n';

test('a block equal to its region passes, ignoring indentation', () => {
  const dir = project({ 'app/App.vue': APP });
  assert.deepEqual(snippetProblems(PAGE('<Stepper v-model="n" :max="4" />'), dir), []);
  assert.deepEqual(snippetProblems(PAGE('    <Stepper v-model="n" :max="4" />'), dir), []);
});

test('a block that drifted from its region is reported with both versions', () => {
  const dir = project({ 'app/App.vue': APP });
  const problems = snippetProblems(PAGE('<Stepper v-model="n" :max="5" />'), dir, 'vue.md');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /differs from the file/);
  assert.match(problems[0], /:max="4"/);
  assert.match(problems[0], /:max="5"/);
});

test('a missing file, a missing region and a dangling comment are each reported', () => {
  const dir = project({ 'app/App.vue': APP });
  assert.match(snippetProblems(PAGE('x', 'app/Nope.vue#stepper'), dir)[0], /doesn't exist/);
  assert.match(snippetProblems(PAGE('x', 'app/App.vue#other'), dir)[0], /no snippet "other"/);
  assert.match(snippetProblems('<!-- snippet: app/App.vue#stepper -->\n\nno block here\n', dir)[0], /isn't followed directly by a code block/);
});

test('pageSnippets finds blocks by their comment', () => {
  assert.deepEqual(pageSnippets(PAGE('a\nb')), [{ path: 'app/App.vue', name: 'stepper', code: 'a\nb' }]);
  assert.deepEqual(pageSnippets('```js\nplain\n```\n'), []);
});

test('links: relative targets must exist; anchors, http and code are ignored', () => {
  const dir = project({ 'docs/guide/a.md': '', 'docs/x.md': '' });
  const page = join(dir, 'docs/guide/page.md');
  const text = '[ok](a.md) [up](../x.md#h) [web](https://example.com) [anchor](#top) [gone](missing.md)\n```\n[code](nowhere.md)\n```\n';
  assert.deepEqual(brokenLinks(text, page), ['missing.md']);
});

const SHAPE = `# Zubra for Vue developers

| Vue | Zubra |
|---|---|
| a | b |

## Using Zubra components in a Vue app

text

## What you get that Vue's own custom-element output doesn't

- A measured fact ([test](../../runtime/test/x.test.js)).

## What doesn't cross

See [what crosses the boundary](../what-crosses-the-boundary.md).

**Which framework do you use alongside Zubra, and what would a page written for you need to show?** [Tell us](https://example.com).
`;

test('a page with the shared shape has no problems', () => {
  assert.deepEqual([...shapeProblems(SHAPE), ...claimProblems(SHAPE)], []);
});

test('each part of the shape is required, and in order', () => {
  const without = (pattern) => SHAPE.replace(pattern, '');
  assert.match(shapeProblems(SHAPE.replace('# Zubra for Vue developers', '# Vue'))[0], /title/);
  assert.match(shapeProblems(without(/\| Vue \| Zubra \|\n\|---\|---\|\n\| a \| b \|\n/))[0], /translation table/);
  assert.match(shapeProblems(SHAPE.replace('## Using Zubra components in a Vue app', '## Usage'))[0], /Using/);
  assert.match(shapeProblems(SHAPE.replace('## What you get', '## Benefits'))[0], /What you get/);
  assert.match(shapeProblems(SHAPE.replace("## What doesn't cross", '## Limits'))[0], /What doesn't cross/);
  assert.match(shapeProblems(SHAPE.replace('what-crosses-the-boundary.md', 'x.md'))[0], /what-crosses/);
  assert.match(shapeProblems(without(/\*\*Which framework[^\n]*\n/))[0], /survey question/);
  // Order: the "doesn't cross" section can't come before "What you get".
  const swapped = SHAPE.replace('## What you get that Vue\'s own custom-element output doesn\'t', '## Z').replace("## What doesn't cross", "## What doesn't cross\n\n## What you get later");
  assert.ok(shapeProblems(swapped).length > 0);
});

test('every claim links its test or example', () => {
  const unlinked = SHAPE.replace('- A measured fact ([test](../../runtime/test/x.test.js)).', '- A measured fact.\n- A linked one ([row](../framework-matrix.md)).');
  const problems = claimProblems(unlinked);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /A measured fact/);
  assert.match(claimProblems(SHAPE.replace(/- A measured[^\n]*\n/, ''))[0], /no claims/);
});
