// VS Code client: starts @zubra/language-server for .zb files. Formatting comes from the server
// (documentFormattingProvider), and package.json makes it the default formatter for .zb.
//
// The server is started as a Node module, not as a command: inside VS Code, process.execPath is
// the editor's own Electron binary, and only the module form has the client fork it with
// ELECTRON_RUN_AS_NODE=1 so that it runs as Node. As a command, whether the server started at all
// depended on the extension host's environment, and without it .zb had no formatter.
//
// "Zubra: Extract to Component…" asks for the new component's name, then has the server do it
// (the code action in the lightbulb menu does the same with a default name).
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
  context.subscriptions.push(vscode.commands.registerCommand('zubra.extractComponent', extractComponent));
  return client.start();
}

/** The tag of a new component: lowercase words joined by hyphens. */
const validTag = (value) => (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(value) ? null : 'A custom element name: lowercase words joined by hyphens, such as price-tag');

async function extractComponent() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'zubra') return;
  const { selection, document } = editor;
  if (selection.isEmpty) {
    vscode.window.showInformationMessage('Select the markup to extract first.');
    return;
  }
  const tag = await vscode.window.showInputBox({
    title: 'Extract to component',
    prompt: 'Name of the new component (a file with this name is created beside this one)',
    placeHolder: 'price-tag',
    validateInput: validTag,
  });
  if (!tag) return;
  // The server answers with the edit and applies it, or says why not.
  await client.sendRequest('workspace/executeCommand', {
    command: 'zubra.applyExtractComponent',
    arguments: [document.uri.toString(), client.code2ProtocolConverter.asRange(selection), tag],
  });
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
