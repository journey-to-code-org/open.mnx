// How the extension starts the language server: as a Node module, which vscode-languageclient
// forks with ELECTRON_RUN_AS_NODE=1. Inside VS Code process.execPath is Electron, so a
// `command: process.execPath` server only ran as Node by accident of the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Activate extension.js with stand-ins for `vscode` and the client, and return what it passed. */
function activated() {
  const Module = require('node:module');
  const seen = {};
  const stubs = {
    vscode: { workspace: { getConfiguration: () => ({ get: () => undefined }) } },
    'vscode-languageclient/node': {
      TransportKind: { stdio: 0, ipc: 1 },
      LanguageClient: class {
        constructor(id, name, serverOptions, clientOptions) { Object.assign(seen, { serverOptions, clientOptions }); }
        start() { return Promise.resolve(); }
        stop() {}
      },
    },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request in stubs ? stubs[request] : load.call(this, request, ...rest); };
  try {
    const path = join(here, '../extension.js');
    delete require.cache[path];
    require(path).activate({ subscriptions: [] });
  } finally {
    Module._load = load;
  }
  return seen;
}

test('the server is a Node module the client forks, not the editor binary as a command', () => {
  const { serverOptions } = activated();
  for (const options of [serverOptions.run, serverOptions.debug]) {
    assert.equal(options.command, undefined, 'no command: process.execPath is Electron in VS Code');
    assert.match(options.module, /language-server[\\/]server\.js$/);
    assert.equal(options.transport, 0, 'stdio');
  }
});

test('forked as the client forks it, the server starts and offers formatting', async () => {
  const { serverOptions } = activated();
  // What vscode-languageclient does for a stdio module with no runtime: fork it with --stdio.
  const child = fork(serverOptions.run.module, ['--stdio'], { silent: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const reply = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const start = buffer.indexOf('\r\n\r\n');
      if (start >= 0) {
        try { resolve(JSON.parse(buffer.slice(start + 4))); } catch { /* not all of it yet */ }
      }
    });
    child.on('exit', (code) => reject(new Error(`the server exited (${code})`)));
    setTimeout(() => reject(new Error('no reply to initialize')), 10000);
  });
  child.kill();
  assert.equal(reply.result.capabilities.documentFormattingProvider, true);
});
