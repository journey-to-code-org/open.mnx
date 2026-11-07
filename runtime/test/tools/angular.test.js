// The Angular adapter is published as partial declarations, like Angular's own libraries: the
// Angular CLI's linker turns them into compiled definitions in AOT builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformFileSync } from '@babel/core';
import linker from '@angular/compiler-cli/linker/babel';

const here = dirname(fileURLToPath(import.meta.url));

test('the Angular linker compiles MnxModel ahead of time', () => {
  const { code } = transformFileSync(join(here, '../../fesm2022/mnx-runtime-angular.mjs'), { plugins: [linker], babelrc: false, configFile: false });
  assert.doesNotMatch(code, /ɵɵngDeclare/, 'every partial declaration was linked');
  assert.match(code, /ɵɵdefineDirective\(\{[^]*selectors: \[\["", "mnxModel", ""\]\]/);
  assert.match(code, /inputs: \{\s*mnxModel: "mnxModel"\s*\}/);
  assert.match(code, /ɵɵProvidersFeature\(\[\{\s*provide: NG_VALUE_ACCESSOR/);
});

test("the typings declare the directive the way Angular's compiler reads it from a library", async () => {
  const { readFileSync } = await import('node:fs');
  const types = readFileSync(join(here, '../../types/angular.d.ts'), 'utf8');
  // Without these, a template using mnxModel doesn't compile ahead of time.
  assert.match(types, /static ɵfac: i0\.ɵɵFactoryDeclaration<MnxModel, never>;/);
  assert.match(types, /static ɵdir: i0\.ɵɵDirectiveDeclaration<MnxModel, '\[mnxModel\]', \['mnxModel'\], \{ mnxModel: \{ alias: 'mnxModel'; required: false \} \}/);
  const js = readFileSync(join(here, '../../fesm2022/mnx-runtime-angular.mjs'), 'utf8');
  assert.match(js, /selector: '\[mnxModel\]'/, 'the same selector as the code');
  assert.match(js, /exportAs: \['mnxModel'\]/);
});
