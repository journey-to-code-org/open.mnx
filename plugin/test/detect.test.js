// What the plugin works out from a component's source alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLightDom } from '../src/index.js';

test('isLightDom: light DOM unless the host tag says `shadow` (comments, scripts and styles aside)', () => {
  assert.equal(isLightDom('<my-el value={1}><p>x</p></my-el>'), true);
  assert.equal(isLightDom('<my-el shadow value={1}><p>x</p></my-el>'), false);
  assert.equal(isLightDom('<my-el\n  form-associated\n  shadow\n>x</my-el>'), false);
  assert.equal(isLightDom('<!-- <a-b shadow> -->\n<script>const tag = "<c-d shadow>"</script>\n<style>p { color: red }</style>\n<my-el shadowy={1}>x</my-el>'), true);
});
