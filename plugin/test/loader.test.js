// The webpack-style loader (Turbopack, webpack): an .zb module as the element and, by default,
// as a React client component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const loader = createRequire(import.meta.url)('../src/loader.cjs');
process.env.ZUBRA_COMPILER ??= join(here, '../../target/debug/zubra');

const run = (resourcePath, resourceQuery = '', options = {}) => new Promise((resolve, reject) => {
  const dependencies = [];
  loader.call({
    resourcePath, resourceQuery, rootContext: here,
    getOptions: () => options,
    addDependency: (file) => dependencies.push(file),
    emitWarning: () => {},
    async: () => (error, code) => (error ? reject(error) : resolve({ code, dependencies })),
  });
});

test('the loader: the element plus a React client component; ?element for the element alone', async () => {
  const header = join(here, '../../examples/header.zb');
  const { code } = await run(header);
  assert.match(code, /^'use client';\n/);
  assert.match(code, /const \$element = \$define\(/);
  assert.match(code, /import \{ wrap as \$wrap \} from "@zubra\/runtime\/react";\nexport \{ \$element as Element \};\nexport default \$wrap\(\$element\);/);
  const element = await run(header, '?element');
  assert.match(element.code, /^export default \$define\(/m);
  assert.doesNotMatch(element.code, /use client|\$wrap/);
  // A component's own .zb imports stay imports (for the loader again), and are dependencies.
  const table = await run(join(here, '../../examples/helpdesk/components/ticket-table.zb'));
  assert.match(table.code, /import '\.\/status-badge\.zb'/);
  assert.ok(table.dependencies.some((file) => file.endsWith('status-badge.zb')));
  await assert.rejects(run(join(here, 'nope.zb')));
});
