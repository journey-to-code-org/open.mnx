// VS Code client: starts @zubra/language-server for .zb files.
const path = require('node:path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  const server = path.join(path.dirname(require.resolve('@zubra/language-server/package.json')), 'server.js');
  const run = { command: process.execPath, args: [server, '--stdio'], transport: TransportKind.stdio };
  const compiler = vscode.workspace.getConfiguration('zubra').get('compiler') || undefined;
  client = new LanguageClient('zubra', 'zubra', { run, debug: run }, {
    documentSelector: [{ scheme: 'file', language: 'zubra' }],
    initializationOptions: { compiler },
  });
  context.subscriptions.push(client);
  return client.start();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
