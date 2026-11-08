// The Angular adapter is published as partial declarations, like Angular's own libraries: the
// Angular CLI's linker turns them into compiled definitions in AOT builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformFileSync } from '@babel/core';
import linker from '@angular/compiler-cli/linker/babel';

const here = dirname(fileURLToPath(import.meta.url));

test('the Angular linker compiles ZubraModel ahead of time', () => {
  const { code } = transformFileSync(join(here, '../../fesm2022/zubra-runtime-angular.mjs'), { plugins: [linker], babelrc: false, configFile: false });
  assert.doesNotMatch(code, /ɵɵngDeclare/, 'every partial declaration was linked');
  assert.match(code, /ɵɵdefineDirective\(\{[^]*selectors: \[\["", "zubraModel", ""\]\]/);
  assert.match(code, /inputs: \{\s*zubraModel: "zubraModel"\s*\}/);
  assert.match(code, /ɵɵProvidersFeature\(\[\{\s*provide: NG_VALUE_ACCESSOR/);
});

test("the typings declare the directive the way Angular's compiler reads it from a library", async () => {
  const { readFileSync } = await import('node:fs');
  const types = readFileSync(join(here, '../../types/angular.d.ts'), 'utf8');
  // Without these, a template using zubraModel doesn't compile ahead of time.
  assert.match(types, /static ɵfac: i0\.ɵɵFactoryDeclaration<ZubraModel, never>;/);
  assert.match(types, /static ɵdir: i0\.ɵɵDirectiveDeclaration<ZubraModel, '\[zubraModel\]', \['zubraModel'\], \{ zubraModel: \{ alias: 'zubraModel'; required: false \} \}/);
  const js = readFileSync(join(here, '../../fesm2022/zubra-runtime-angular.mjs'), 'utf8');
  assert.match(js, /selector: '\[zubraModel\]'/, 'the same selector as the code');
  assert.match(js, /exportAs: \['zubraModel'\]/);
});
