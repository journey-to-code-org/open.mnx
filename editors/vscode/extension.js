// VS Code client: starts @zubra/language-server for .zb files. Formatting comes from the server
// (documentFormattingProvider), and package.json makes it the default formatter for .zb.
//
// The server is started as a Node module, not as a command: inside VS Code, process.execPath is
// the editor's own Electron binary, and only the module form has the client fork it with
// ELECTRON_RUN_AS_NODE=1 so that it runs as Node. As a command, whether the server started at all
// depended on the extension host's environment, and without it .zb had no formatter.
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  // The package's main entry: its exports map has no './package.json', so resolving that threw
  // and the server never started.
  const server = require.resolve('@zubra/language-server');
  const run = { module: server, transport: TransportKind.stdio };
  const settings = vscode.workspace.getConfiguration('zubra');
  const compiler = settings.get('compiler') || undefined;
  const printWidth = settings.get('format.printWidth') || undefined;
  client = new LanguageClient('zubra', 'zubra', { run, debug: run }, {
    documentSelector: [{ scheme: 'file', language: 'zubra' }],
    initializationOptions: { compiler, printWidth },
  });
  context.subscriptions.push(client);
  return client.start();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
