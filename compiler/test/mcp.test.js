// The MCP server (mcp.js, `zubra mcp`): a client's session over standard input and output, the
// components loaded from a folder, a built library's manifest and an installed package, the
// usage it writes per framework, and the markup check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLibrary } from '../library.js';
import { check, loadComponents, usage } from '../mcp.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'zb-mcp-'));
const components = join(dir, 'components');

before(() => {
  mkdirSync(components);
  for (const name of ['star-rating', 'modal-dialog', 'tag-input']) cpSync(join(repo, 'registry/components', `${name}.zb`), join(components, `${name}.zb`));
  // A built library, installed under node_modules as a package.
  buildLibrary(components, { out: join(dir, 'dist'), name: '@acme/ui', version: '1.0.0' });
  mkdirSync(join(dir, 'app/node_modules/@acme'), { recursive: true });
  symlinkSync(join(dir, 'dist'), join(dir, 'app/node_modules/@acme/ui'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A client session: send requests, read responses by id. */
function session(args, cwd) {
  const child = spawn(process.execPath, [cli, 'mcp', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let buffer = '';
  const waiting = new Map();
  const extra = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (waiting.has(message.id)) waiting.get(message.id)(message);
      else extra.push(message);
    }
  });
  let id = 0;
  return {
    child,
    extra,
    send: (method, params) => new Promise((resolve) => {
      const mine = ++id;
      waiting.set(mine, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
    }),
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    raw: (text) => child.stdin.write(text + '\n'),
    close: () => new Promise((resolve) => { child.on('close', resolve); child.stdin.end(); }),
  };
}

test('a client session: initialize, list the tools, call each', async () => {
  const client = session([components], dir);
  const init = await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'zubra-components');
  assert.match(init.result.instructions, /3 web components/);
  client.notify('notifications/initialized');

  const { result: { tools } } = await client.send('tools/list');
  assert.deepEqual(tools.map((tool) => tool.name), ['list_components', 'describe_component', 'component_usage', 'check_markup']);
  for (const tool of tools) assert.equal(tool.inputSchema.type, 'object');

  const list = (await client.send('tools/call', { name: 'list_components', arguments: {} })).result;
  assert.deepEqual(list.structuredContent.components.map((c) => c.tag), ['modal-dialog', 'star-rating', 'tag-input']);
  assert.match(list.content[0].text, /^<modal-dialog> \(ModalDialog\): A modal dialog/);

  const described = (await client.send('tools/call', { name: 'describe_component', arguments: { tag: 'modal-dialog' } })).result;
  assert.equal(described.isError, false);
  assert.deepEqual(described.structuredContent.events, [{ name: 'openchange', detail: 'boolean', description: '`open` changed; `detail` is the new value.' }]);
  assert.deepEqual(described.structuredContent.slots, ['default', 'actions', 'heading']);
  assert.deepEqual(described.structuredContent.models, ['open']);
  assert.match(described.content[0].text, /- open: boolean, default false, two-way/);
  assert.doesNotMatch(described.structuredContent.description, /@slot/, 'the @slot lines are in slots, not the description');

  const vue = (await client.send('tools/call', { name: 'component_usage', arguments: { tag: 'star-rating', framework: 'vue' } })).result;
  assert.match(vue.content[0].text, /<StarRating v-model="value"/);

  const checked = (await client.send('tools/call', { name: 'check_markup', arguments: { markup: '<star-rating vlaue="3" onvaluechnage="x()"></star-rating>' } })).result;
  assert.deepEqual(checked.structuredContent.problems.map((p) => [p.problem, p.suggestion]), [
    ['<star-rating> has no prop "vlaue"', 'value'],
    ['<star-rating> doesn\'t fire "valuechnage"', 'valuechange'],
  ]);

  const missing = (await client.send('tools/call', { name: 'describe_component', arguments: { tag: 'star-ratin' } })).result;
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /no component "star-ratin"; did you mean "star-rating"\?/);

  assert.deepEqual((await client.send('ping')).result, {});
  assert.equal((await client.send('resources/list')).error.code, -32601);
  client.raw('{not json');
  await client.send('ping');
  assert.deepEqual(client.extra, [{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }], 'a bad line gets a parse error; notifications get nothing');
  await client.close();
});

test('components from a built library\'s manifest and from an installed package', () => {
  const fromManifest = loadComponents([join(dir, 'dist/custom-elements.json')]);
  const fromPackage = loadComponents(['@acme/ui'], { cwd: join(dir, 'app') });
  assert.deepEqual(fromPackage.map((c) => c.tag), fromManifest.map((c) => c.tag));
  assert.equal(fromPackage[0].origin, '@acme/ui');
  assert.throws(() => loadComponents(['@acme/nope'], { cwd: join(dir, 'app') }), /not a file, a folder or an installed package/);
  assert.throws(() => loadComponents([], { cwd: join(dir, 'app') }), /say where the components are/);
});

test('usage per framework, from an installed package', () => {
  const [, rating] = loadComponents(['@acme/ui'], { cwd: join(dir, 'app') });
  assert.equal(rating.tag, 'star-rating');
  const react = usage(rating, 'react');
  assert.match(react, /^import StarRating from '@acme\/ui\/react\/star-rating';/);
  assert.match(react, /<StarRating value=\{value\} onValueChange=\{\(event\) => setValue\(event\.detail\)\}/);
  assert.match(usage(rating, 'vue'), /^import StarRating from '@acme\/ui\/vue\/star-rating';\n<StarRating v-model="value" :max='5' label="Rating">/);
  assert.match(usage(rating, 'svelte'), /<star-rating value=\{value\} onvaluechange=\{\(event\) => \(value = event\.detail\)\}/);
  assert.match(usage(rating, 'solid'), /prop:value=\{value\(\)\} on:valuechange=/);
  assert.match(usage(rating, 'angular'), /\[value\]="value" \(valuechange\)="value = \$event\.detail"/);
  const html = usage(rating, 'html');
  assert.match(html, /^import '@acme\/ui\/star-rating';/);
  assert.match(html, /<star-rating max="5" label="Rating"><\/star-rating>/, 'false booleans are left out');
  assert.match(html, /addEventListener\('valuechange'/);
  assert.throws(() => usage(rating, 'qwik'), /framework must be one of/);
  // Every usage passes the check.
  const all = loadComponents(['@acme/ui'], { cwd: join(dir, 'app') });
  for (const component of all) {
    for (const framework of ['html', 'react', 'vue', 'svelte', 'solid', 'angular']) {
      assert.deepEqual(check(all, usage(component, framework)), [], `${component.tag} in ${framework}`);
    }
  }
});

test('the check knows global attributes, native events and two-way bindings', () => {
  const all = loadComponents([components]);
  assert.deepEqual(check(all, '<star-rating id="r" class="x" aria-label="y" data-k="1" slot="s" onclick={f} @focus="g" max={5}></star-rating>'), []);
  assert.deepEqual(check(all, '<StarRating v-model:max="m" />').map((p) => p.problem), ['no two-way prop "max"']);
  assert.deepEqual(check(all, '<ModalDialog v-model:open="o" @openchange="h"></ModalDialog>'), []);
  assert.deepEqual(check(all, '<other-thing vlaue="1"></other-thing>'), [], 'unknown elements are not this library\'s');
});
