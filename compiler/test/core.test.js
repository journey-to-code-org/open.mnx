// @zubra/compiler/wasm: the compiler without a host. It must do what the Node entry does, byte for
// byte, and must not depend on anything a Worker lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompiler, CompileError, CompilerCrash, over, requestWith as createCompilerRaw, restarting } from '../core.js';
import * as node from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const registry = join(here, '../../registry/components');
if (process.env.ZUBRA_REQUIRE_WASM && !node.available()) throw new Error('ZUBRA_REQUIRE_WASM is set but zubra.wasm is missing');
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

// ---- a request that traps doesn't cost the process its compiler ----------------------------

// A stand-in for zubra.wasm that traps the way a stack overflow does. A request one byte long
// traps and marks the instance; a marked instance traps on every request after it (the real
// compiler is left with its allocator and stack pointer mid-request). Anything else answers
// {"ok":true,"output":"fine"}.
//
//   (module
//     (memory (export "memory") 1)
//     (data (i32.const 16) "{\"ok\":true,\"output\":\"fine\"}")
//     (func (export "zubra_alloc") (param i32) (result i32) (i32.const 1024))
//     (func (export "zubra_free") (param i32 i32))
//     (func (export "zubra_request") (param $at i32) (param $length i32) (result i64)
//       (if (i32.load8_u (i32.const 0)) (then unreachable))
//       (if (i32.eq (local.get $length) (i32.const 1))
//         (then (i32.store8 (i32.const 0) (i32.const 1)) unreachable))
//       (i64.or (i64.shl (i64.const 16) (i64.const 32)) (i64.const 27))))
const TRAPS = 'AGFzbQEAAAABEQNgAX8Bf2ACf38AYAJ/fwF+AwQDAAECBQMBAAEHNQQGbWVtb3J5AgALenVicmFfYWxsb2MAAAp6dWJyYV9mcmVlAAENenVicmFfcmVxdWVzdAACCi4DBQBBgAgLAgALIwBBAC0AAARAAAsgAUEBRgRAQQBBAToAAAALQhBCIIZCG4QLCyEBAEEQCxt7Im9rIjp0cnVlLCJvdXRwdXQiOiJmaW5lIn0=';
const trapping = () => new WebAssembly.Module(Buffer.from(TRAPS, 'base64'));
const fine = { ok: true, output: 'fine' };

test('the stand-in traps, and stays trapped: what a compiler without restarting is left with', () => {
  const exports = new WebAssembly.Instance(trapping(), {}).exports;
  const plain = over((body) => createCompilerRaw(exports, body));
  assert.deepEqual(plain.request({ emit: 'js' }), fine);
  assert.throws(() => plain.request(7), WebAssembly.RuntimeError);
  assert.throws(() => plain.request({ emit: 'js' }), WebAssembly.RuntimeError, 'the instance is no use after a trap');
});

test('a compiler made from a module starts a fresh instance after a trap', () => {
  const compiler = createCompiler(trapping());
  assert.deepEqual(compiler.request({ emit: 'js' }), fine);
  assert.throws(() => compiler.request(7), (error) => {
    assert.ok(error instanceof CompilerCrash);
    assert.ok(error.cause instanceof WebAssembly.RuntimeError);
    assert.match(error.message, /the compiler stopped on this input \(unreachable/);
    return true;
  });
  assert.deepEqual(compiler.request({ emit: 'js' }), fine, 'the next request is answered');
  // Again and again: each trap costs one instance, never the compiler.
  for (let i = 0; i < 3; i++) {
    assert.throws(() => compiler.request(7), CompilerCrash);
    assert.deepEqual(compiler.request({ emit: 'js' }), fine);
  }
});

test('one made from an instance has nothing to start again from, and says so every time', () => {
  for (const given of [new WebAssembly.Instance(trapping(), {}), new WebAssembly.Instance(trapping(), {}).exports]) {
    const compiler = createCompiler(given);
    assert.deepEqual(compiler.request({ emit: 'js' }), fine);
    assert.throws(() => compiler.request(7), CompilerCrash);
    assert.throws(() => compiler.request({ emit: 'js' }), CompilerCrash, 'not a raw trap from a broken instance');
  }
});

test('restarting() leaves other errors alone and keeps its instance', () => {
  let made = 0;
  const request = restarting(() => {
    made += 1;
    return new WebAssembly.Instance(trapping(), {}).exports;
  });
  assert.deepEqual(request({ emit: 'js' }), fine);
  // Not a trap: JSON.stringify refuses a BigInt before the compiler is called.
  assert.throws(() => request(1n), TypeError);
  assert.deepEqual(request({ emit: 'js' }), fine);
  assert.equal(made, 1);
  assert.throws(() => request(7), CompilerCrash);
  assert.deepEqual(request({ emit: 'js' }), fine);
  assert.equal(made, 2);
});

test('markup nested past the limit is a CompileError, and the compiler goes on answering', { skip }, () => {
  const compiler = createCompiler(wasm());
  const path = '/app/deep.zb';
  const page = { [path]: '<x-deep><zb-slot></zb-slot></x-deep>' };
  const nested = (depth) => `${'<div>'.repeat(depth)}x${'</div>'.repeat(depth)}`;
  // At the limit: rendered, in the WebAssembly build's own stack.
  assert.match(compiler.renderToString(path, { files: page, slots: { default: nested(256) } }), /x<\/div>/);
  for (const depth of [257, 800, 5000, 100000]) {
    assert.throws(() => compiler.renderToString(path, { files: page, slots: { default: nested(depth) } }), (error) => {
      assert.ok(error instanceof CompileError, `${depth}: ${error.name}: ${error.message.slice(0, 80)}`);
      assert.match(error.message, /nested more than 256 elements deep/);
      return true;
    });
    assert.match(compiler.renderToString(path, { files: page, slots: { default: '<b>ok</b>' } }), /<b>ok<\/b>/);
  }
  assert.throws(() => compiler.renderToString(path, { files: { [path]: `<x-deep>${nested(300)}</x-deep>` } }), /nested more than 256/);
});
