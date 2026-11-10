// VS Code client: starts @zubra/language-server for .zb files. Formatting comes from the server
// (documentFormattingProvider), and package.json makes it the default formatter for .zb.
const path = require('node:path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  const server = path.join(path.dirname(require.resolve('@zubra/language-server/package.json')), 'server.js');
  const run = { command: process.execPath, args: [server, '--stdio'], transport: TransportKind.stdio };
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
