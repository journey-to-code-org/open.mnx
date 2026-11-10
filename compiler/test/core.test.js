// @zubra/compiler/wasm: the compiler without a host. It must do what the Node entry does, byte for
// byte, and must not depend on anything a Worker lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompiler, CompileError, over } from '../core.js';
import * as node from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const registry = join(here, '../../registry/components');
const skip = node.available() ? false : 'zubra.wasm is not built (npm run build)';
const wasm = () => new WebAssembly.Module(readFileSync(join(here, '../zubra.wasm')));

test('core.js depends on nothing a Worker lacks', () => {
  const code = readFileSync(join(here, '../core.js'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /from\s+['"]node:/, 'no Node built-in imports');
  assert.doesNotMatch(code, /\bimport\.meta\b/, 'no import.meta (a Worker has no module URL)');
  assert.doesNotMatch(code, /\bprocess\b|\brequire\(|\bBuffer\b|\b__dirname\b/, 'no Node globals');
});

test('renders every registry component exactly as the Node entry does', { skip }, () => {
  const zubra = createCompiler(wasm());
  const names = readdirSync(registry).filter((name) => name.endsWith('.zb'));
  assert.ok(names.length >= 26, `${names.length} components`);
  for (const name of names) {
    const path = join(registry, name);
    const files = node.sources(path);
    const expected = node.render(path, { files });
    const actual = zubra.render(path, { files });
    assert.deepEqual(actual, expected, name);
  }
});

test('props and slots pass through', { skip }, () => {
  const { renderToString } = createCompiler(wasm()); // used without its object, as a Worker's handler would
  const path = '/app/card.zb';
  const files = { [path]: '<script>const doubled = n * 2</script><x-card n={0}><b>{doubled}</b><zb-slot></zb-slot></x-card>' };
  const options = { files, props: { n: 21 }, slots: { default: '<i>hi</i>' } };
  const html = renderToString(path, options);
  assert.match(html, /<b>42<\/b>/);
  assert.match(html, /<i>hi<\/i>/);
  assert.equal(html, node.renderToString(path, options));
});

test('formats as the Node entry does', { skip }, () => {
  const source = '<script>let a   = 1</script>\n<x-a><p>{ a }</p></x-a>';
  assert.equal(createCompiler(wasm()).format(source), node.format(source));
});

test('compile errors are CompileErrors with diagnostics', { skip }, () => {
  const zubra = createCompiler(wasm());
  assert.throws(() => zubra.renderToString('/app/bad.zb', { files: { '/app/bad.zb': '<x-bad><p></x-bad>' } }), (error) => {
    assert.ok(error instanceof CompileError);
    assert.ok(error instanceof node.CompileError, 'the same class as the Node entry exports');
    assert.ok(error.diagnostics.length > 0);
    return true;
  });
});

test('render says what is missing when it has no files', { skip }, () => {
  assert.throws(() => createCompiler(wasm()).render('/app/x.zb'), /needs `files`/);
});

test('createCompiler takes a module, an instance or exports, and refuses anything else', { skip }, () => {
  const module = wasm();
  const instance = new WebAssembly.Instance(module, {});
  const path = '/app/t.zb';
  const files = { [path]: '<x-t><p>hi</p></x-t>' };
  for (const given of [module, instance, instance.exports]) {
    assert.equal(createCompiler(given).renderToString(path, { files }), '<x-t><p>hi</p></x-t>');
  }
  for (const wrong of [undefined, null, {}, 'zubra.wasm', new Uint8Array(8)]) {
    assert.throws(() => createCompiler(wrong), TypeError, String(wrong));
  }
});

test('over() works on any request function', () => {
  const seen = [];
  const compiler = over((body) => { seen.push(body.emit ?? body.command); return { ok: true, output: 'x', warnings: [], diagnostics: [] }; });
  assert.equal(compiler.renderToString('/a.zb', { files: { '/a.zb': '' } }), 'x');
  assert.equal(compiler.format('', { path: '/a.zb' }), 'x');
  assert.deepEqual(seen, ['html', 'css', 'format']);
});
