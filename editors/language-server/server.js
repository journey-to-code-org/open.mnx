#!/usr/bin/env node
// zubra language server: diagnostics from the compiler as you type, completion of directives,
// imported components, their props and events, hover documentation from their manifests, and
// go to definition for imported components, formatting (`zubra fmt`), and the Extract to component
// refactor (a code action, and the `zubra.applyExtractComponent` command that takes a name). Speaks LSP over stdio
// (`--stdio`).
//
// initializationOptions: { compiler?: "/path/to/zubra", printWidth?: number } — otherwise
// @zubra/compiler (WebAssembly) when installed (the nearest above the file), else ZUBRA_COMPILER,
// a cargo build in a zubra checkout, or `zubra` on PATH. A compiler that can't be run is shown once
// as a warning, not as an error in every file. printWidth is the width a
// tag is fitted into when formatting (default 100); indentation comes from the editor.
import { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, DiagnosticSeverity, CompletionItemKind, InsertTextFormat, MarkupKind, CodeActionKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createBackend, importsOf, readText } from './backend.js';
import { completions, documentation, hostOf, interfaceOf, offsetAt, positionAt, tagAt } from './analysis.js';

const EXTRACT_COMMAND = 'zubra.applyExtractComponent'; // not the editor command's name: the client registers the server's commands itself
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let backend;
let printWidth;
let toldAboutVersion = false;
let toldAboutRangeVersion = false;
const manifests = new Map(); // path → { mtime, component }

// What the editor said it can do, for Extract to component: the edit creates a file, which not
// every client applies, and a client that doesn't know disabled actions would show one as usable.
const client = { createsFiles: false, appliesEdits: false, actionLiterals: false, disabledActions: false };

connection.onInitialize(async (params) => {
  const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  backend = await createBackend({
    ...params.initializationOptions,
    root: folder ? fileURLToPath(folder) : undefined,
    onUnavailable: (message) => connection.window.showWarningMessage(message),
  });
  printWidth = Number(params.initializationOptions?.printWidth) || undefined;
  const edits = params.capabilities?.workspace?.workspaceEdit;
  const actions = params.capabilities?.textDocument?.codeAction;
  client.createsFiles = edits?.documentChanges === true && (edits.resourceOperations ?? []).includes('create');
  client.appliesEdits = params.capabilities?.workspace?.applyEdit === true;
  client.actionLiterals = !!actions?.codeActionLiteralSupport;
  client.disabledActions = actions?.disabledSupport === true;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['<', ' ', '{'] },
      hoverProvider: true,
      definitionProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      // Only to an editor that can take the edit: a new file and changes to this one, together.
      ...(client.createsFiles && client.actionLiterals ? { codeActionProvider: { codeActionKinds: [CodeActionKind.RefactorExtract] } } : {}),
      ...(client.createsFiles && client.appliesEdits ? { executeCommandProvider: { commands: [EXTRACT_COMMAND] } } : {}),
    },
    serverInfo: { name: 'zubra-language-server', version: '1.2.0' },
  };
});

const pathOf = (uri) => fileURLToPath(uri);

// Byte offsets (the compiler's) and string indexes (LSP's UTF-16 positions).
const byteOffset = (text, index) => Buffer.byteLength(text.slice(0, index));
const indexOfByte = (text, bytes) => Buffer.from(text).subarray(0, bytes).toString().length;

/** The components a document imports: { tag, …interface, path }. */
function componentsOf(uri, text) {
  const base = dirname(pathOf(uri));
  const found = [];
  for (const specifier of importsOf(text)) {
    const path = resolve(base, specifier);
    let mtime;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    let cached = manifests.get(path);
    if (!cached || cached.mtime !== mtime) {
      cached = { mtime, component: interfaceOf(backend.manifest(path)) };
      manifests.set(path, cached);
    }
    if (cached.component) found.push({ ...cached.component, path });
  }
  return found;
}

const timers = new Map();
function validate(document) {
  clearTimeout(timers.get(document.uri));
  timers.set(document.uri, setTimeout(async () => {
    const path = pathOf(document.uri);
    await backend.prepare?.(path);
    // The newest text, after loading: it may have changed meanwhile, or closed.
    const current = documents.get(document.uri);
    if (!current) return;
    const text = current.getText();
    const diagnostics = backend.check(path, text)
      .filter((diagnostic) => resolve(diagnostic.file) === path || diagnostic.file === path)
      .map((diagnostic) => {
        const line = Math.max(diagnostic.line - 1, 0);
        const character = Math.max(diagnostic.column - 1, 0);
        const lineText = text.split('\n')[line] ?? '';
        const word = lineText.slice(character).match(/^[\w.$-]+|^./)?.[0] ?? '';
        return {
          range: { start: { line, character }, end: { line, character: character + Math.max(word.length, 1) } },
          severity: diagnostic.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
          source: 'zubra',
          message: diagnostic.help ? `${diagnostic.message}\n${diagnostic.help}` : diagnostic.message,
        };
      });
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  }, 100));
}
documents.onDidChangeContent((change) => validate(change.document));
documents.onDidClose((event) => connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }));

const kinds = { directive: CompletionItemKind.Keyword, component: CompletionItemKind.Class, attribute: CompletionItemKind.Property, event: CompletionItemKind.Event, variable: CompletionItemKind.Variable };
connection.onCompletion(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return [];
  const text = document.getText();
  return completions(text, offsetAt(text, position), componentsOf(textDocument.uri, text)).map((item) => ({
    label: item.label,
    kind: kinds[item.kind],
    detail: item.detail,
    documentation: item.documentation ? { kind: MarkupKind.Markdown, value: item.documentation } : undefined,
    insertText: item.insertText,
    insertTextFormat: item.snippet ? InsertTextFormat.Snippet : undefined,
  }));
});

connection.onHover(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return null;
  const text = document.getText();
  const tag = tagAt(text, offsetAt(text, position));
  const component = tag && componentsOf(textDocument.uri, text).find((candidate) => candidate.tag === tag.name);
  if (!component) return null;
  return {
    contents: { kind: MarkupKind.Markdown, value: documentation(component) },
    range: { start: positionAt(text, tag.start), end: positionAt(text, tag.end) },
  };
});

connection.onDefinition(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return null;
  const text = document.getText();
  const tag = tagAt(text, offsetAt(text, position));
  const component = tag && componentsOf(textDocument.uri, text).find((candidate) => candidate.tag === tag.name);
  if (!component) return null;
  const target = readText(component.path) ?? '';
  const at = Math.max(target.search(new RegExp(`<${component.tag}[\\s>]`)), 0);
  const start = positionAt(target, at);
  return { uri: pathToFileURL(component.path).href, range: { start, end: { line: start.line, character: start.character + component.tag.length + 1 } } };
});

// Format Document (and format on save): the whole file, as `zubra fmt` lays it out, with the
// editor's indentation. A file that doesn't parse isn't formatted: its diagnostics say why.
connection.onDocumentFormatting(({ textDocument, options }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return [];
  const text = document.getText();
  const result = backend.format(pathOf(textDocument.uri), text, {
    indentWidth: options.tabSize,
    useTabs: options.insertSpaces === false,
    printWidth,
  });
  if (!result.ok) {
    // A compiler from before `zubra fmt` (5.3 and older) doesn't know the command.
    if (/unknown command|usage: zubra/.test(result.error) && !toldAboutVersion) {
      toldAboutVersion = true;
      connection.window.showInformationMessage('Formatting .zb files needs Zubra 5.4 or later: update @zubra/compiler (or the zubra CLI).');
    }
    return [];
  }
  if (result.output === text) return [];
  return [{ range: { start: { line: 0, character: 0 }, end: positionAt(text, text.length) }, newText: result.output }];
});

// Format Selection (and format on paste): the lines the selection touches, as `zubra fmt` would
// write them in the whole file. One edit, or none when they're already formatted.
connection.onDocumentRangeFormatting(({ textDocument, range, options }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return [];
  const text = document.getText();
  const answer = backend.formatRange?.(
    pathOf(textDocument.uri),
    text,
    { start: byteOffset(text, offsetAt(text, range.start)), end: byteOffset(text, offsetAt(text, range.end)) },
    { indentWidth: options.tabSize, useTabs: options.insertSpaces === false, printWidth },
  );
  if (!answer?.ok) {
    if (answer?.unsupported && !toldAboutRangeVersion) {
      toldAboutRangeVersion = true;
      connection.window.showInformationMessage('Formatting a selection needs a newer Zubra: update @zubra/compiler (or the zubra CLI).');
    }
    return [];
  }
  if (!answer.edit) return [];
  return [{
    range: { start: positionAt(text, indexOfByte(text, answer.edit.start)), end: positionAt(text, indexOfByte(text, answer.edit.end)) },
    newText: answer.edit.text,
  }];
});

// ---- Extract to component -------------------------------------------------------------------
// The compiler (`refactor`, `action: "extract"`) decides what can be extracted and how; offsets
// there are UTF-8 bytes, LSP's are UTF-16 (`byteOffset` and `indexOfByte`, above).

/** A name for the new component that isn't taken beside the document. */
function defaultTag(uri, text) {
  const base = `${hostOf(text)?.tag ?? 'my'}-part`;
  const directory = dirname(pathOf(uri));
  let tag = base;
  for (let n = 2; existsSync(resolve(directory, `${tag}.zb`)); n++) tag = `${base}-${n}`;
  return tag;
}

/** The workspace edit for extracting `range` of the document as `tag`, or why it can't be. */
function extraction(document, range, tag) {
  const text = document.getText();
  const start = byteOffset(text, offsetAt(text, range.start));
  const end = byteOffset(text, offsetAt(text, range.end));
  const made = backend.refactor?.(pathOf(document.uri), text, { start, end, tag });
  if (!made) return { reason: 'This compiler cannot extract components: update @zubra/compiler (or the zubra CLI).' };
  if (!made.ok) {
    return { reason: made.unsupported ? 'Extracting a component needs a newer Zubra: update @zubra/compiler (or the zubra CLI).' : made.reason };
  }
  const { fileName, fileSource, edits } = made.result;
  const newPath = resolve(dirname(pathOf(document.uri)), fileName);
  // The edit creates the file and would fail on one that's there, after the name was chosen.
  if (existsSync(newPath)) return { reason: `${fileName} already exists beside this file: choose another name.` };
  const newUri = pathToFileURL(newPath).href;
  return {
    edit: {
      documentChanges: [
        { kind: 'create', uri: newUri, options: { ignoreIfExists: false } },
        { textDocument: { uri: newUri, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: fileSource }] },
        {
          textDocument: { uri: document.uri, version: document.version },
          edits: edits.map((edit) => ({
            range: { start: positionAt(text, indexOfByte(text, edit.start)), end: positionAt(text, indexOfByte(text, edit.end)) },
            newText: edit.text,
          })),
        },
      ],
    },
    tag: made.result.tag,
  };
}

// The code action: offered on a non-empty selection, with a default name; when the compiler
// refuses, it's shown disabled with the reason, so the rule is discoverable.
connection.onCodeAction(({ textDocument, range, context }) => {
  const document = documents.get(textDocument.uri);
  if (!document || !client.createsFiles || !client.actionLiterals) return [];
  if (context.only && !context.only.some((kind) => CodeActionKind.RefactorExtract.startsWith(kind))) return [];
  if (range.start.line === range.end.line && range.start.character === range.end.character) return [];
  const made = extraction(document, range, defaultTag(textDocument.uri, document.getText()));
  if (!made.edit) {
    // An editor that doesn't know `disabled` would offer this as an action that does nothing.
    if (!client.disabledActions) return [];
    return [{ title: 'Extract to component', kind: CodeActionKind.RefactorExtract, disabled: { reason: made.reason } }];
  }
  return [{ title: `Extract to component <${made.tag}>`, kind: CodeActionKind.RefactorExtract, edit: made.edit }];
});

// For editors that ask for the name first (the VS Code extension): [uri, range, tag].
connection.onExecuteCommand(async ({ command, arguments: args }) => {
  if (command !== EXTRACT_COMMAND) return null;
  const [uri, range, tag] = args ?? [];
  const document = documents.get(uri);
  if (!document || !range || !tag) return { error: 'Extract to component needs a document, a selection and a name.' };
  if (!client.createsFiles || !client.appliesEdits) return { error: 'This editor did not say it can apply an edit that creates a file, which extracting a component needs.' };
  const made = extraction(document, range, tag);
  if (!made.edit) {
    connection.window.showErrorMessage(made.reason);
    return { error: made.reason };
  }
  const applied = await connection.workspace.applyEdit(made.edit);
  if (!applied.applied) connection.window.showErrorMessage(`Couldn't extract: ${applied.failureReason ?? 'the editor refused the edit'}`);
  return { applied: applied.applied, tag: made.tag };
});

documents.listen(connection);
connection.listen();
