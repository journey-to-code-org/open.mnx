// The runtime's typings for Explicit Resource Management, checked with the TypeScript compiler:
// with a `lib` that has it, `using` and DisposableStack accept effects, scopes and resources;
// with an older `lib`, the same typings still type-check (they mention Symbol.dispose only when
// the project's `lib` has it). Run with `npm run test:tools`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = join(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
let dir;

const USING = `import { effect, scope, resource } from '@zubra/runtime';
export function block() {
  using owner = scope(() => {});
  using stop = effect(() => {});
  using data = resource(async () => 1);
  const stack = new DisposableStack();
  stack.use(scope());
  stack.use(effect(() => {}));
  stack.use(resource(async () => 2));
  owner.pause();
  // @ts-expect-error a number isn't disposable
  using wrong = 5;
  return [stop, data, wrong, stack];
}
`;

const PLAIN = `import { effect, scope, resource } from '@zubra/runtime';
const owner = scope(() => {});
owner.pause(); owner.resume(); owner.dispose();
const stop: () => void = effect(() => {});
stop();
resource(async () => 1).dispose();
`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'zb-dispose-types-'));
  mkdirSync(join(dir, 'node_modules/@zubra'), { recursive: true });
  symlinkSync(runtime, join(dir, 'node_modules/@zubra/runtime'), 'dir');
  writeFileSync(join(dir, 'using.ts'), USING);
  writeFileSync(join(dir, 'plain.ts'), PLAIN);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const check = (file, lib) => spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--module', 'nodenext',
  '--moduleResolution', 'nodenext', '--target', 'es2022', '--lib', lib, file], { cwd: dir, encoding: 'utf8' });

test('with Explicit Resource Management in lib, using and DisposableStack accept effects, scopes and resources', () => {
  const result = check('using.ts', 'esnext,dom');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('with an older lib, the typings still type-check', () => {
  const result = check('plain.ts', 'es2022,dom');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
