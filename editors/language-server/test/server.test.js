// The language server over real LSP (JSON-RPC on stdio), against the native CLI.
// Needs `cargo build` at the repository root.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { completions, contextAt, hostOf, offsetAt, positionAt, tagAt } from '../analysis.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const compiler = join(repo, 'target/debug/zubra');

let server, dir, nextId = 1;
const pending = new Map();
const notifications = [];
const waiters = [];

function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ id, method, params });
});
const notify = (method, params) => send({ method, params });
function diagnosticsFor(uri) {
  return new Promise((resolve) => {
    const check = () => {
      const found = notifications.findLast((n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri);
      if (found) { notifications.splice(notifications.indexOf(found), 1); resolve(found.params.diagnostics); return true; }
      return false;
    };
    if (!check()) waiters.push(check);
  });
}

before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  dir = mkdtempSync(join(tmpdir(), 'zb-lsp-'));
  writeFileSync(join(dir, 'badge.zb'), '<!-- A small badge. -->\n<script>\n  import { emit } from \'@zubra/runtime\'\n  emit(\'pick\', 1)\n</script>\n<zb-badge label="new" count={0}>\n  <b>{label}</b><zb-slot name="icon"></zb-slot>\n</zb-badge>\n');
  server = spawn(process.execPath, [join(here, '../server.js'), '--stdio']);
  let buffer = Buffer.alloc(0);
  server.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const header = buffer.indexOf('\r\n\r\n');
      if (header < 0) return;
      const length = Number(buffer.slice(0, header).toString().match(/Content-Length: (\d+)/)[1]);
      if (buffer.length < header + 4 + length) return;
      const message = JSON.parse(buffer.slice(header + 4, header + 4 + length).toString());
      buffer = buffer.slice(header + 4 + length);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message.result);
        pending.delete(message.id);
      } else if (message.method) {
        notifications.push(message);
        for (const waiter of [...waiters]) if (waiter()) waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  });
  const init = await call('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {}, initializationOptions: { compiler } });
  assert.ok(init.capabilities.completionProvider);
  assert.equal(init.capabilities.documentFormattingProvider, true);
  assert.equal(init.capabilities.documentRangeFormattingProvider, true);
  notify('initialized', {});
});
after(() => {
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const PAGE = "<script>\n  import './badge.zb'\n</script>\n<zb-page title=\"x\" items={[]}>\n  <zb-badge lable={1}></zb-badge>\n</zb-page>\n";

test('diagnostics as you type, at the right place, with the fix in the message', async () => {
  const uri = pathToFileURL(join(dir, 'page.zb')).href;
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'zubra', version: 1, text: PAGE } });
  const diagnostics = await diagnosticsFor(uri);
  const error = diagnostics.find((diagnostic) => diagnostic.severity === 1);
  assert.equal(error.message, '<zb-badge> has no prop `lable`\ndid you mean `label`?');
  assert.deepEqual(error.range.start, { line: 4, character: 12 });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.severity === 2 && /prop `title`/.test(diagnostic.message)), 'warnings too');

  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: PAGE.replace('lable={1}', 'label="one"') }] });
  const fixed = await diagnosticsFor(uri);
  assert.deepEqual(fixed.filter((diagnostic) => diagnostic.severity === 1), [], 'cleared once fixed, without saving');
});

test('completion: directives and imported components, their props and events', async () => {
  const uri = pathToFileURL(join(dir, 'complete.zb')).href;
  const text = "<script>\n  import './badge.zb'\n</script>\n<zb-page heading=\"\">\n  <zb-\n  <zb-badge \n  <p>{}</p>\n</zb-page>\n";
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'zubra', version: 1, text } });
  const labels = async (line, character) => (await call('textDocument/completion', { textDocument: { uri }, position: { line, character } })).map((item) => item.label);
  assert.deepEqual((await labels(4, 6)).sort(), ['zb-await', 'zb-badge', 'zb-case', 'zb-catch', 'zb-each', 'zb-else', 'zb-if', 'zb-pending', 'zb-slot', 'zb-switch', 'zb-then']);
  assert.deepEqual(await labels(5, 12), ['label', 'count', 'onpick', 'zb-if', 'zb-else-if', 'zb-else']);
  assert.deepEqual(await labels(6, 6), ['heading'], 'props in expressions');
  const items = await call('textDocument/completion', { textDocument: { uri }, position: { line: 5, character: 12 } });
  assert.equal(items[0].insertText, 'label={$1}');
  assert.equal(items[0].insertTextFormat, 2);
});

test('hover shows the component; go to definition opens it', async () => {
  const uri = pathToFileURL(join(dir, 'page.zb')).href;
  const hover = await call('textDocument/hover', { textDocument: { uri }, position: { line: 4, character: 5 } });
  assert.match(hover.contents.value, /\*\*<zb-badge>\*\*\n\nA small badge\./);
  assert.match(hover.contents.value, /\| `count` \| `number` \| `0` \|/);
  assert.match(hover.contents.value, /Events: `pick`/);
  assert.match(hover.contents.value, /Slots: `icon`/);
  const definition = await call('textDocument/definition', { textDocument: { uri }, position: { line: 4, character: 5 } });
  assert.equal(definition.uri, pathToFileURL(join(dir, 'badge.zb')).href);
  assert.deepEqual(definition.range.start, { line: 5, character: 0 });
  assert.equal(await call('textDocument/hover', { textDocument: { uri }, position: { line: 3, character: 3 } }), null, 'not an imported component');
});

test('Format Document: the whole file as zubra fmt lays it out, with the editor\'s indentation', async () => {
  const init = await call('textDocument/formatting', { textDocument: { uri: 'file:///nowhere.zb' }, options: { tabSize: 2, insertSpaces: true } });
  assert.deepEqual(init, [], 'not an open document');
  const uri = pathToFileURL(join(dir, 'messy.zb')).href;
  const text = '<zb-messy>\n<p>\nhi   {name}\n</p>\n      <input   type = "text"/>\n</zb-messy>';
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'zubra', version: 1, text } });
  const edits = await call('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 4, insertSpaces: true } });
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].range, { start: { line: 0, character: 0 }, end: { line: 5, character: 11 } });
  assert.equal(edits[0].newText, '<zb-messy>\n    <p>\n        hi   {name}\n    </p>\n    <input type="text" />\n</zb-messy>\n');

  const tabs = await call('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 4, insertSpaces: false } });
  assert.match(tabs[0].newText, /^\t<p>$/m);

  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: edits[0].newText }] });
  assert.deepEqual(await call('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 4, insertSpaces: true } }), [], 'already formatted: no edits');

  notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: '<zb-messy>\n<p>\n</zb-messy>' }] });
  assert.deepEqual(await call('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } }), [], 'a file that doesn\'t parse is left alone');
});

test('the analysis knows where the cursor is', () => {
  const text = '<script>const a = "<b"</script>\n<zb-x a="1 {b}" c={d}><zb-if te</zb-x>';
  assert.equal(contextAt(text, 20).kind, 'script');
  assert.deepEqual(contextAt(text, text.indexOf('te</') + 2), { kind: 'attribute', tag: 'zb-if', prefix: 'te' });
  assert.deepEqual(hostOf(text).props, ['a', 'c']);
  assert.deepEqual(completions(text, text.indexOf('te</') + 2, []).map((item) => item.label), ['test']);
  // Any other element can take a condition (4.1).
  const plain = '<zb-x a="1"><p zb-</p></zb-x>';
  assert.deepEqual(completions(plain, plain.indexOf('zb-</') + 3, []).map((item) => item.label), ['zb-if', 'zb-else-if', 'zb-else']);
  assert.deepEqual(tagAt(text, text.indexOf('zb-if') + 2), { name: 'zb-if', start: text.indexOf('zb-if'), end: text.indexOf('zb-if') + 5 });
});

// ---- Format Selection --------------------------------------------------------------------------

function rangeOf(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start) + to.length;
  return { start: positionAt(text, start), end: positionAt(text, end) };
}
function applyEdits(text, edits) {
  let out = text;
  const offsets = edits.map((edit) => ({ ...edit, start: offsetAt(text, edit.range.start), end: offsetAt(text, edit.range.end) })).sort((a, b) => b.start - a.start);
  for (const edit of offsets) out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
  return out;
}
async function open(name, text) {
  const uri = pathToFileURL(join(dir, name)).href;
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'zubra', version: 1, text } });
  return uri;
}

test('Format Selection: only the lines it touches, at their depth in the whole file, after a multibyte character', async () => {
  const text = '<!-- café -->\n<x-r>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n</x-r>\n';
  const uri = await open('range.zb', text);
  const range = rangeOf(text, '<li>one', '</li>');
  const edits = await call('textDocument/rangeFormatting', { textDocument: { uri }, range, options: { tabSize: 4, insertSpaces: true } });
  assert.equal(edits.length, 1);
  assert.equal(applyEdits(text, edits), '<!-- café -->\n<x-r>\n<ul>\n        <li>one</li>\n<li>two</li>\n</ul>\n</x-r>\n');
  // Already formatted: no edit. Tabs.
  const done = '<x-r>\n  <p>a</p>\n</x-r>\n';
  const second = await open('range-b.zb', done);
  assert.deepEqual(await call('textDocument/rangeFormatting', { textDocument: { uri: second }, range: rangeOf(done, '<p>', '</p>'), options: { tabSize: 2, insertSpaces: true } }), []);
  const tabs = await call('textDocument/rangeFormatting', { textDocument: { uri }, range, options: { tabSize: 4, insertSpaces: false } });
  assert.match(applyEdits(text, tabs), /\n\t\t<li>one<\/li>/);
  // A file that doesn't parse is left alone.
  const broken = '<x-r>\n  <p>\n</x-r>\n';
  const third = await open('range-c.zb', broken);
  assert.deepEqual(await call('textDocument/rangeFormatting', { textDocument: { uri: third }, range: rangeOf(broken, '<p>', '<p>'), options: { tabSize: 2, insertSpaces: true } }), []);
});
