// The TextMate grammar, tokenized with the same engine VS Code uses (vscode-textmate +
// Oniguruma). Embedded languages (JavaScript, CSS) are empty stand-ins here, so the checks are on
// zubra's own scopes and on which embedded language each region is handed to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import textmate from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

async function grammar() {
  const wasm = readFileSync(join(dirname(require.resolve('vscode-oniguruma')), 'onig.wasm')).buffer;
  await oniguruma.loadWASM(wasm);
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns), createOnigString: (text) => new oniguruma.OnigString(text) }),
    // The embedded languages' grammars ship with VS Code; empty stand-ins are enough here.
    loadGrammar: async (scope) => (scope === 'text.html.zb'
      ? textmate.parseRawGrammar(readFileSync(join(here, '../syntaxes/zubra.tmLanguage.json'), 'utf8'), 'zubra.tmLanguage.json')
      : { scopeName: scope, patterns: [], repository: { expression: { patterns: [] } } }),
  });
  return registry.loadGrammar('text.html.zb');
}

/** Each token's text and scopes, for a whole document. */
async function tokens(text) {
  const zubra = await grammar();
  let state = textmate.INITIAL;
  const out = [];
  for (const line of text.split('\n')) {
    const result = zubra.tokenizeLine(line, state);
    for (const token of result.tokens) out.push({ text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes });
    state = result.ruleStack;
  }
  return out;
}

const scopesOf = (all, text) => all.find((token) => token.text.includes(text))?.scopes ?? [];

const SOURCE = `<!-- A card.
  @fires pick - Picked. -->
<script lang="ts">
  const heading: string = "Card"
</script>
<style>
  h2 { color: red }
</style>
<zb-card heading={heading} open={true} class="card {kind}" onpick={handle}>
  <zb-if test={open}><h2>{heading.toUpperCase()}</h2></zb-if>
  <zb-each items={[{ id: 1 }]} as="item"><p>&amp; {item.id}</p></zb-each>
  <zb-await value={load()}><p>…</p><zb-then as="data">{data}</zb-then></zb-await>
</zb-card>`;

test('script, style, directives, components, expressions and events get their scopes', async () => {
  const all = await tokens(SOURCE);
  assert.ok(scopesOf(all, '@fires').includes('storage.type.class.jsdoc'), '@fires in the description');
  assert.ok(scopesOf(all, 'const heading').includes('source.ts'), 'lang="ts" is TypeScript');
  assert.ok(scopesOf(all, 'h2 { color').includes('source.css'), '<style> is CSS');
  assert.ok(scopesOf(all, 'zb-card').includes('entity.name.tag.custom.zb'));
  assert.ok(scopesOf(all, 'zb-if').includes('keyword.control.directive.zb'));
  assert.ok(scopesOf(all, 'zb-each').includes('keyword.control.directive.zb'));
  assert.ok(scopesOf(all, 'zb-await').includes('keyword.control.directive.zb'));
  assert.ok(scopesOf(all, 'onpick').includes('entity.other.attribute-name.event.zb'));
  assert.ok(all.find((token) => token.text === 'h2' && token.scopes.includes('entity.name.tag.html')), 'plain HTML tags');
  for (const expression of ['heading.toUpperCase()', 'item.id', 'kind']) {
    assert.ok(scopesOf(all, expression).includes('meta.embedded.expression.zb'), expression);
  }
  assert.ok(scopesOf(all, '&amp;').includes('constant.character.entity.html'));
});

test('nested braces in an expression stay inside it', async () => {
  const all = await tokens('<zb-x items={[{ id: 1 }]} as="item"></zb-x>');
  const as = all.find((token) => token.text === 'as');
  assert.ok(as.scopes.includes('entity.other.attribute-name.html'), 'the attribute after the object literal is an attribute again');
  assert.ok(!as.scopes.includes('meta.embedded.expression.zb'));
});

test('a plain <script> is JavaScript and <style lang="scss"> is SCSS', async () => {
  const all = await tokens('<script>\n  const a = 1\n</script>\n<style lang="scss">\n  $c: red;\n</style>\n<zb-x></zb-x>');
  assert.ok(scopesOf(all, 'const a').includes('source.js'));
  assert.ok(scopesOf(all, '$c: red').includes('source.css.scss'));
  assert.ok(scopesOf(all, 'zb-x').includes('entity.name.tag.custom.zb'), 'the template after the blocks');
});

test('the extension manifest points at the grammar and language configuration', () => {
  const manifest = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'));
  const [language] = manifest.contributes.languages;
  assert.deepEqual(language.extensions, ['.zb']);
  JSON.parse(readFileSync(join(here, '..', language.configuration), 'utf8'));
  const [grammarEntry] = manifest.contributes.grammars;
  assert.equal(JSON.parse(readFileSync(join(here, '..', grammarEntry.path), 'utf8')).scopeName, grammarEntry.scopeName);
});

test('event modifiers, class:/style: directives and ref get their own scopes', async () => {
  const all = await tokens('<zb-x>\n  <form onsubmit.prevent={add} class:open={open} style:--tone={tone} ref={form}></form>\n</zb-x>');
  assert.ok(scopesOf(all, 'onsubmit').includes('entity.other.attribute-name.event.zb'));
  assert.ok(scopesOf(all, '.prevent').includes('keyword.other.modifier.zb'));
  assert.ok(scopesOf(all, 'open').some((scope) => scope.includes('directive.zb')) || all.some((t) => t.text === 'open' && t.scopes.includes('entity.other.attribute-name.directive.zb')));
  assert.ok(all.some((token) => token.text === '--tone' && token.scopes.includes('entity.other.attribute-name.directive.zb')));
  assert.ok(scopesOf(all, 'ref').includes('entity.other.attribute-name.ref.zb'));
});

test('conditions as attributes and markup in braces (4.1)', async () => {
  const all = await tokens('<zb-x>\n  <p zb-if={a}>A</p><p zb-else>B</p>\n  {done && <b class="ok">Saved</b>}\n  {n < 3}\n</zb-x>');
  assert.ok(all.some((token) => token.text === 'zb-if' && token.scopes.includes('keyword.control.directive.zb')));
  assert.ok(all.some((token) => token.text === 'zb-else' && token.scopes.includes('keyword.control.directive.zb')));
  assert.ok(all.some((token) => token.text === 'b' && token.scopes.includes('entity.name.tag.html') && token.scopes.includes('meta.embedded.expression.zb')), 'a tag in braces is a tag');
  assert.ok(!all.some((token) => token.text.trim() === '3' && token.scopes.includes('entity.name.tag.html')), 'a comparison is not');
});
