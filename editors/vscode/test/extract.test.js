// "Zubra: Extract to Component…": the editor's side of it. The extension asks for the new
// component's name and hands the document, the selection and the name to the language server,
// which decides what can be extracted and applies the edit (editors/language-server tests that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activated } from './stub.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'));

const selection = { isEmpty: false, start: { line: 7, character: 2 }, end: { line: 11, character: 7 } };
const editorOn = (languageId = 'zubra', chosen = selection) => ({
  selection: chosen,
  document: { languageId, uri: { toString: () => 'file:///app/list.zb' } },
});

test('activating registers the command the manifest contributes', () => {
  const { commands, subscriptions } = activated();
  const contributed = manifest.contributes.commands.map((command) => command.command);
  assert.deepEqual(contributed, ['zubra.extractComponent']);
  assert.deepEqual([...commands.keys()], contributed);
  assert.equal(typeof commands.get('zubra.extractComponent'), 'function');
  assert.equal(subscriptions.length, 2, 'the client and the command are disposed with the extension');
  // It's in the editor's context menu for .zb files with a selection.
  const [menu] = manifest.contributes.menus['editor/context'];
  assert.equal(menu.command, 'zubra.extractComponent');
  assert.match(menu.when, /editorLangId == zubra/);
  assert.match(menu.when, /editorHasSelection/);
});

test('with a selection and a name, the server is asked to extract it', async () => {
  const seen = activated({ editor: editorOn(), input: 'people-list' });
  await seen.commands.get('zubra.extractComponent')();
  assert.equal(seen.prompts.length, 1);
  assert.deepEqual(seen.requests, [{
    method: 'workspace/executeCommand',
    params: {
      // The server's command, not the editor's: the client registers the server's itself.
      command: 'zubra.applyExtractComponent',
      arguments: ['file:///app/list.zb', { start: selection.start, end: selection.end }, 'people-list'],
    },
  }]);
  assert.notEqual(seen.requests[0].params.command, 'zubra.extractComponent');
});

test('the name prompt accepts custom element names only', async () => {
  const seen = activated({ editor: editorOn(), input: undefined });
  await seen.commands.get('zubra.extractComponent')();
  const { validateInput } = seen.prompts[0];
  for (const name of ['price-tag', 'x-a', 'people-list-2', 'a1-b2']) assert.equal(validateInput(name), null, name);
  for (const name of ['', 'pricetag', 'Price-Tag', '-tag', 'tag-', 'price--tag', '1-tag', 'price tag', 'price_tag']) {
    assert.equal(typeof validateInput(name), 'string', name);
  }
});

test('Escape at the prompt, no selection, no editor or another language: nothing is sent', async () => {
  const cancelled = activated({ editor: editorOn(), input: undefined });
  await cancelled.commands.get('zubra.extractComponent')();
  assert.deepEqual(cancelled.requests, []);

  const empty = activated({ editor: editorOn('zubra', { ...selection, isEmpty: true }), input: 'x-y' });
  await empty.commands.get('zubra.extractComponent')();
  assert.deepEqual(empty.requests, []);
  assert.equal(empty.prompts.length, 0, 'no prompt for a name without something to extract');
  assert.deepEqual(empty.messages, ['Select the markup to extract first.']);

  for (const editor of [undefined, editorOn('html')]) {
    const other = activated({ editor, input: 'x-y' });
    await other.commands.get('zubra.extractComponent')();
    assert.deepEqual(other.requests, []);
    assert.equal(other.prompts.length, 0);
  }
});
