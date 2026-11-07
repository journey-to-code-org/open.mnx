// VS Code client: starts @mnx/language-server for .mnx files.
const path = require('node:path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  const server = path.join(path.dirname(require.resolve('@mnx/language-server/package.json')), 'server.js');
  const run = { command: process.execPath, args: [server, '--stdio'], transport: TransportKind.stdio };
  const compiler = vscode.workspace.getConfiguration('mnx').get('compiler') || undefined;
  client = new LanguageClient('mnx', 'mnx', { run, debug: run }, {
    documentSelector: [{ scheme: 'file', language: 'mnx' }],
    initializationOptions: { compiler },
  });
  context.subscriptions.push(client);
  return client.start();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
