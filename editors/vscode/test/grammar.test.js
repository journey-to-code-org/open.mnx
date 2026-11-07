// The TextMate grammar, tokenized with the same engine VS Code uses (vscode-textmate +
// Oniguruma). Embedded languages (JavaScript, CSS) are empty stand-ins here, so the checks are on
// mnx's own scopes and on which embedded language each region is handed to.
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
    loadGrammar: async (scope) => (scope === 'text.html.mnx'
      ? textmate.parseRawGrammar(readFileSync(join(here, '../syntaxes/mnx.tmLanguage.json'), 'utf8'), 'mnx.tmLanguage.json')
      : { scopeName: scope, patterns: [], repository: { expression: { patterns: [] } } }),
  });
  return registry.loadGrammar('text.html.mnx');
}

/** Each token's text and scopes, for a whole document. */
async function tokens(text) {
  const mnx = await grammar();
  let state = textmate.INITIAL;
  const out = [];
  for (const line of text.split('\n')) {
    const result = mnx.tokenizeLine(line, state);
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
<mnx-card heading={heading} open={true} class="card {kind}" onpick={handle}>
  <mnx-if test={open}><h2>{heading.toUpperCase()}</h2></mnx-if>
  <mnx-each items={[{ id: 1 }]} as="item"><p>&amp; {item.id}</p></mnx-each>
  <mnx-await value={load()}><p>…</p><mnx-then as="data">{data}</mnx-then></mnx-await>
</mnx-card>`;

test('script, style, directives, components, expressions and events get their scopes', async () => {
  const all = await tokens(SOURCE);
  assert.ok(scopesOf(all, '@fires').includes('storage.type.class.jsdoc'), '@fires in the description');
  assert.ok(scopesOf(all, 'const heading').includes('source.ts'), 'lang="ts" is TypeScript');
  assert.ok(scopesOf(all, 'h2 { color').includes('source.css'), '<style> is CSS');
  assert.ok(scopesOf(all, 'mnx-card').includes('entity.name.tag.custom.mnx'));
  assert.ok(scopesOf(all, 'mnx-if').includes('keyword.control.directive.mnx'));
  assert.ok(scopesOf(all, 'mnx-each').includes('keyword.control.directive.mnx'));
  assert.ok(scopesOf(all, 'mnx-await').includes('keyword.control.directive.mnx'));
  assert.ok(scopesOf(all, 'onpick').includes('entity.other.attribute-name.event.mnx'));
  assert.ok(all.find((token) => token.text === 'h2' && token.scopes.includes('entity.name.tag.html')), 'plain HTML tags');
  for (const expression of ['heading.toUpperCase()', 'item.id', 'kind']) {
    assert.ok(scopesOf(all, expression).includes('meta.embedded.expression.mnx'), expression);
  }
  assert.ok(scopesOf(all, '&amp;').includes('constant.character.entity.html'));
});

test('nested braces in an expression stay inside it', async () => {
  const all = await tokens('<mnx-x items={[{ id: 1 }]} as="item"></mnx-x>');
  const as = all.find((token) => token.text === 'as');
  assert.ok(as.scopes.includes('entity.other.attribute-name.html'), 'the attribute after the object literal is an attribute again');
  assert.ok(!as.scopes.includes('meta.embedded.expression.mnx'));
});

test('a plain <script> is JavaScript and <style lang="scss"> is SCSS', async () => {
  const all = await tokens('<script>\n  const a = 1\n</script>\n<style lang="scss">\n  $c: red;\n</style>\n<mnx-x></mnx-x>');
  assert.ok(scopesOf(all, 'const a').includes('source.js'));
  assert.ok(scopesOf(all, '$c: red').includes('source.css.scss'));
  assert.ok(scopesOf(all, 'mnx-x').includes('entity.name.tag.custom.mnx'), 'the template after the blocks');
});

test('the extension manifest points at the grammar and language configuration', () => {
  const manifest = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'));
  const [language] = manifest.contributes.languages;
  assert.deepEqual(language.extensions, ['.mnx']);
  JSON.parse(readFileSync(join(here, '..', language.configuration), 'utf8'));
  const [grammarEntry] = manifest.contributes.grammars;
  assert.equal(JSON.parse(readFileSync(join(here, '..', grammarEntry.path), 'utf8')).scopeName, grammarEntry.scopeName);
});

test('event modifiers, class:/style: directives and ref get their own scopes', async () => {
  const all = await tokens('<mnx-x>\n  <form onsubmit.prevent={add} class:open={open} style:--tone={tone} ref={form}></form>\n</mnx-x>');
  assert.ok(scopesOf(all, 'onsubmit').includes('entity.other.attribute-name.event.mnx'));
  assert.ok(scopesOf(all, '.prevent').includes('keyword.other.modifier.mnx'));
  assert.ok(scopesOf(all, 'open').some((scope) => scope.includes('directive.mnx')) || all.some((t) => t.text === 'open' && t.scopes.includes('entity.other.attribute-name.directive.mnx')));
  assert.ok(all.some((token) => token.text === '--tone' && token.scopes.includes('entity.other.attribute-name.directive.mnx')));
  assert.ok(scopesOf(all, 'ref').includes('entity.other.attribute-name.ref.mnx'));
});
