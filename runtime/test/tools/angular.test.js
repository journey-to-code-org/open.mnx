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
  const { code } = transformFileSync(join(here, '../../src/angular.js'), { plugins: [linker], babelrc: false, configFile: false });
  assert.doesNotMatch(code, /ɵɵngDeclare/, 'every partial declaration was linked');
  assert.match(code, /ɵɵdefineDirective\(\{[^]*selectors: \[\["", "mnxModel", ""\]\]/);
  assert.match(code, /inputs: \{\s*mnxModel: "mnxModel"\s*\}/);
  assert.match(code, /ɵɵProvidersFeature\(\[\{\s*provide: NG_VALUE_ACCESSOR/);
});
