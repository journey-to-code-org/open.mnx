// extension.js with stand-ins for `vscode` and the language client, for tests that run it
// without an editor. `activated()` loads and activates it, and returns what it did: the client's
// options, the commands it registered, the requests it sent, and the messages it showed.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * `editor`: what `vscode.window.activeTextEditor` is. `input`: what the name prompt answers (a
 * string, or undefined for Escape), or a function given the prompt's options.
 */
export function activated({ editor, input } = {}) {
  const Module = require('node:module');
  const seen = { commands: new Map(), requests: [], messages: [], prompts: [], subscriptions: [] };
  const stubs = {
    vscode: {
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
      commands: {
        registerCommand(name, handler) {
          seen.commands.set(name, handler);
          return { dispose() {} };
        },
      },
      window: {
        get activeTextEditor() { return editor; },
        showInformationMessage(message) { seen.messages.push(message); },
        async showInputBox(options) {
          seen.prompts.push(options);
          return typeof input === 'function' ? input(options) : input;
        },
      },
    },
    'vscode-languageclient/node': {
      TransportKind: { stdio: 0, ipc: 1 },
      LanguageClient: class {
        constructor(id, name, serverOptions, clientOptions) { Object.assign(seen, { serverOptions, clientOptions }); }
        start() { return Promise.resolve(); }
        stop() {}
        // What the real client's converter does to a selection: its start and end as positions.
        get code2ProtocolConverter() { return { asRange: (range) => ({ start: range.start, end: range.end }) }; }
        async sendRequest(method, params) { seen.requests.push({ method, params }); return { applied: true }; }
      },
    },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request in stubs ? stubs[request] : load.call(this, request, ...rest); };
  try {
    const path = join(here, '../extension.js');
    delete require.cache[path];
    require(path).activate({ subscriptions: seen.subscriptions });
  } finally {
    Module._load = load;
  }
  return seen;
}
