// The webpack-style loader (Turbopack, webpack): an .mnx module as the element and, by default,
// as a React client component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const loader = createRequire(import.meta.url)('../src/loader.cjs');
process.env.MNX_COMPILER ??= join(here, '../../target/debug/mnx');

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
  const header = join(here, '../../examples/header.mnx');
  const { code } = await run(header);
  assert.match(code, /^'use client';\n/);
  assert.match(code, /const \$element = \$define\(/);
  assert.match(code, /import \{ wrap as \$wrap \} from "@mnx\/runtime\/react";\nexport \{ \$element as Element \};\nexport default \$wrap\(\$element\);/);
  const element = await run(header, '?element');
  assert.match(element.code, /^export default \$define\(/m);
  assert.doesNotMatch(element.code, /use client|\$wrap/);
  // A component's own .mnx imports stay imports (for the loader again), and are dependencies.
  const table = await run(join(here, '../../examples/helpdesk/components/ticket-table.mnx'));
  assert.match(table.code, /import '\.\/status-badge\.mnx'/);
  assert.ok(table.dependencies.some((file) => file.endsWith('status-badge.mnx')));
  await assert.rejects(run(join(here, 'nope.mnx')));
});
