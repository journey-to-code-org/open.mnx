// Components from a package: where packageFile finds one (the rule the CLI's Rust follows too),
// and how sources() keys a package's files, by specifier, with its own imports under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageFile, sources } from '../index.js';
import { packageFile as languageServerCopy } from '../../editors/language-server/packages.js';

function project(exports) {
  const root = mkdtempSync(join(tmpdir(), 'zubra-packages-'));
  const kit = join(root, 'node_modules/@acme/kit');
  mkdirSync(join(kit, 'components'), { recursive: true });
  writeFileSync(join(kit, 'package.json'), JSON.stringify({ name: '@acme/kit', ...(exports !== undefined && { exports }) }));
  writeFileSync(join(kit, 'components/dot.zb'), '<kit-dot><i></i></kit-dot>\n');
  writeFileSync(join(kit, 'components/cart-panel.zb'), "<script>\n  import './dot.zb'\n</script>\n<cart-panel><kit-dot></kit-dot></cart-panel>\n");
  mkdirSync(join(root, 'node_modules/plain/ui'), { recursive: true });
  writeFileSync(join(root, 'node_modules/plain/ui/badge.zb'), '<plain-badge></plain-badge>\n');
  mkdirSync(join(root, 'src/pages'), { recursive: true });
  const page = join(root, 'src/pages/shop-page.zb');
  writeFileSync(page, "<script>\n  import '@acme/kit/components/cart-panel.zb'\n  import 'plain/ui/badge.zb'\n</script>\n<shop-page><cart-panel></cart-panel><plain-badge></plain-badge></shop-page>\n");
  return { root, kit, page, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('without "exports", any file of the package, found from any folder below node_modules', () => {
  const { root, kit, done } = project();
  try {
    assert.deepEqual(packageFile(join(root, 'src/pages'), '@acme/kit/components/cart-panel.zb'), { path: join(kit, 'components/cart-panel.zb') });
    assert.deepEqual(packageFile(join(root, 'src/pages'), 'plain/ui/badge.zb'), { path: join(root, 'node_modules/plain/ui/badge.zb') });
  } finally {
    done();
  }
});

test('"exports" decides, as Node does: exact keys, patterns, conditions in their order', () => {
  const cases = [
    [{ './components/*': './components/*' }, '@acme/kit/components/cart-panel.zb', 'components/cart-panel.zb'],
    [{ './ui/*': { require: './nope/*', import: './components/*', default: './nope/*' } }, '@acme/kit/ui/cart-panel.zb', 'components/cart-panel.zb'],
    [{ './ui/*': { default: './components/*', import: './nope/*' } }, '@acme/kit/ui/cart-panel.zb', 'components/cart-panel.zb'],
    [{ './cart.zb': ['./components/cart-panel.zb'] }, '@acme/kit/cart.zb', 'components/cart-panel.zb'],
    [{ './ui/*.zb': './components/*.zb' }, '@acme/kit/ui/dot.zb', 'components/dot.zb'],
  ];
  for (const [exports, specifier, expected] of cases) {
    const { root, kit, done } = project(exports);
    try {
      assert.deepEqual(packageFile(root, specifier), { path: join(kit, expected) }, JSON.stringify(exports));
    } finally {
      done();
    }
  }
});

test('each refusal says why', () => {
  const { root, done } = project({ './components/*': './components/*' });
  try {
    assert.deepEqual(packageFile(root, '@acme/kit/secret/x.zb'), { error: '@acme/kit doesn\'t export ./secret/x.zb (its package.json "exports")' });
    assert.deepEqual(packageFile(root, '@acme/kit/components/zz.zb'), { error: '@acme/kit has no components/zz.zb' });
    assert.match(packageFile(root, '@acme/nope/x.zb').error, /^@acme\/nope isn't installed: it isn't in any node_modules above /);
    assert.deepEqual(packageFile(root, '@acme/kit'), { error: '`@acme/kit` names a package, not a component in it' });
  } finally {
    done();
  }
});

test("a pattern whose two ends overlap doesn't match a path shorter than both", () => {
  const { root, done } = project({ './c*c.zb': './components/c*c.zb' });
  try {
    assert.deepEqual(packageFile(root, '@acme/kit/c.zb'), { error: '@acme/kit doesn\'t export ./c.zb (its package.json "exports")' });
  } finally {
    done();
  }
});

test("sources() keys a package's files by specifier, and its own imports under it", () => {
  const { page, done } = project();
  try {
    assert.deepEqual(Object.keys(sources(page)), [page, '@acme/kit/components/cart-panel.zb', '@acme/kit/components/dot.zb', 'plain/ui/badge.zb']);
  } finally {
    done();
  }
});

test("the language server's copy of the rule gives the same answers", () => {
  const specifiers = ['@acme/kit/components/cart-panel.zb', '@acme/kit/ui/cart-panel.zb', '@acme/kit/cart.zb', '@acme/kit/secret/x.zb', '@acme/kit/components/zz.zb', '@acme/nope/x.zb', '@acme/kit', 'plain/ui/badge.zb', '@acme/kit/c.zb', '@acme/kit/components/'];
  for (const exports of [undefined, { './components/*': './components/*' }, { './ui/*': { require: './nope/*', import: './components/*' } }, { './ui/*': { import: './components/*', default: './nope/*' } }, { './cart.zb': ['./components/cart-panel.zb'] }, { './c*c.zb': './x/c*c.zb' }]) {
    const { root, done } = project(exports);
    try {
      for (const specifier of specifiers) assert.deepEqual(languageServerCopy(join(root, 'src'), specifier), packageFile(join(root, 'src'), specifier), `${JSON.stringify(exports)} ${specifier}`);
    } finally {
      done();
    }
  }
});
