import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { format as zubraFormat, request, sources } from '@zubra/compiler';
import * as prettier from 'prettier';
import { bodies, parserFor } from '../src/index.js';

const plugin = fileURLToPath(new URL('../src/index.js', import.meta.url));
const run = (source, options = {}) => prettier.format(source, { parser: 'zubra', plugins: [plugin], ...options });

const SAMPLE = `<script>
const   a = {b:1}
let count=0
const t = \`x
   y\`
</script>
<style>
.a{color:red}
</style>
<my-x><button onclick={count++}>{count}</button></my-x>
`;

test('script and style bodies are formatted and indented one level', async () => {
  const out = await run(SAMPLE);
  assert.match(out, /<script>\n {2}const a = \{ b: 1 \};\n {2}let count = 0;/);
  assert.match(out, /<style>\n {2}\.a \{\n {4}color: red;\n {2}\}\n<\/style>/);
});

test('template literal contents are not re-indented', async () => {
  assert.match(await run(SAMPLE), /const t = `x\n {3}y`;/);
});

test('the template is laid out exactly as zubra fmt does', async () => {
  const masked = SAMPLE.replace(/<script>[\s\S]*?<\/script>/, '<script>S</script>').replace(/<style>[\s\S]*?<\/style>/, '<style>S</style>');
  const out = await run(masked);
  assert.equal(out.replace(/<script>[\s\S]*?<\/script>/, '<script>S</script>').replace(/<style>[\s\S]*?<\/style>/, '<style>S</style>'), zubraFormat(masked, { indentWidth: 2, printWidth: 80 }));
});

test('honours tabWidth and useTabs', async () => {
  assert.match(await run(SAMPLE, { tabWidth: 4 }), /<script>\n {4}const a/);
  assert.match(await run(SAMPLE, { useTabs: true }), /<script>\n\tconst a/);
});

test('lang="ts" goes through the TypeScript parser', async () => {
  const out = await run('<script lang="ts">\nlet n:number=1\n</script>\n<my-x>{n}</my-x>\n');
  assert.match(out, /let n: number = 1;/);
});

test('lang="scss" goes through the SCSS parser', async () => {
  const out = await run('<style lang="scss">\n.a{.b{color:red}}\n</style>\n<my-x></my-x>\n');
  assert.match(out, /\.a \{\n {4}\.b \{/);
});

test('a body that does not parse is left as written', async () => {
  const broken = '<script>\nconst = = 1\n</script>\n<my-x></my-x>\n';
  assert.match(await run(broken), /<script>\nconst = = 1\n<\/script>\n<my-x><\/my-x>/);
});

test('embeddedLanguageFormatting off leaves bodies as written', async () => {
  const out = await run(SAMPLE, { embeddedLanguageFormatting: 'off' });
  assert.match(out, /const {3}a = \{b:1\}/);
});

test('a file that does not parse is an error', async () => {
  await assert.rejects(run('<my-x><div></my-x>\n'));
});

test('formatting is idempotent', async () => {
  const once = await run(SAMPLE);
  assert.equal(await run(once), once);
});

test('parserFor', () => {
  assert.equal(parserFor('script', ''), 'babel');
  assert.equal(parserFor('script', ' lang="ts"'), 'typescript');
  assert.equal(parserFor('script', " type='importmap'"), 'json');
  assert.equal(parserFor('script', ' type="text/x-template"'), null);
  assert.equal(parserFor('style', ''), 'css');
  assert.equal(parserFor('style', ' lang=less'), 'less');
  assert.equal(parserFor('style', ' lang="stylus"'), null);
});

test('bodies skips comments and stops at the host tag', () => {
  const text = '<!-- <script>no</script> --><script>a</script><my-x><script>b</script></my-x>';
  assert.deepEqual(bodies(text).map((b) => text.slice(b.start, b.end)), ['a']);
});

// Every component in the repository (compared ignoring whitespace, quote style, semicolons and trailing commas, which Prettier chooses): the plugin's output compiles to the same thing.
function* zbFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* zbFiles(path);
    else if (name.endsWith('.zb')) yield path;
  }
}

test('every .zb in the repository formats, idempotently, to the same compiled output', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const compiled = async (path, text) => {
    const absolute = resolve(path);
    const files = { ...sources(absolute), [absolute]: text };
    const outputs = [];
    for (const emit of ['js', 'css']) {
      try {
        const reply = request({ path: absolute, files, emit });
        if (!reply.ok) return null;
        outputs.push(emit === 'js' ? await prettier.format(reply.output ?? '', { parser: 'babel' }) : (reply.output ?? ''));
      } catch {
        return null;
      }
    }
    return outputs.map((output) => output.replace(/(\s|\\+n)+|["'\\;]/g, '').replace(/,(?=[)\]}])/g, '')).join('\n');
  };
  let count = 0;
  for (const path of zbFiles(root)) {
    const source = readFileSync(path, 'utf8');
    const before = await compiled(path, source);
    if (before === null) continue;
    const out = await run(source);
    assert.equal(await run(out), out, `${path}: not idempotent`);
    assert.equal(await compiled(path, out), before, `${path}: compiled output changed`);
    count += 1;
  }
  assert.ok(count > 100, `only ${count} files checked`);
});

test('the template follows tabWidth and useTabs too', async () => {
  const source = '<my-x>\n<div>\n<p>\nhi\n</p>\n</div>\n</my-x>\n';
  const wide = zubraFormat(source, { indentWidth: 4, printWidth: 80 });
  const tabbed = zubraFormat(source, { indentWidth: 2, useTabs: true, printWidth: 80 });
  assert.notEqual(wide, zubraFormat(source, { indentWidth: 2, printWidth: 80 }));
  assert.equal(await run(source, { tabWidth: 4 }), wide);
  assert.equal(await run(source, { useTabs: true }), tabbed);
});

test('a body in a language Prettier has no parser for is left as written', async () => {
  const source = '<style lang="stylus">\n.a\n  color red\n</style>\n<my-x></my-x>\n';
  assert.match(await run(source), /<style lang="stylus">\n\.a\n {2}color red\n<\/style>/);
});
