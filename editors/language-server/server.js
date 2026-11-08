#!/usr/bin/env node
// zubra language server: diagnostics from the compiler as you type, completion of directives,
// imported components, their props and events, hover documentation from their manifests, and
// go to definition for imported components. Speaks LSP over stdio (`--stdio`).
//
// initializationOptions: { compiler?: "/path/to/zubra" } — otherwise @zubra/compiler (WebAssembly)
// when installed, else `zubra` on PATH.
import { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, DiagnosticSeverity, CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { createBackend, importsOf, readText } from './backend.js';
import { completions, documentation, interfaceOf, offsetAt, positionAt, tagAt } from './analysis.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let backend;
const manifests = new Map(); // path → { mtime, component }

connection.onInitialize(async (params) => {
  const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  backend = await createBackend({ ...params.initializationOptions, root: folder ? fileURLToPath(folder) : undefined });
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['<', ' ', '{'] },
      hoverProvider: true,
      definitionProvider: true,
    },
    serverInfo: { name: 'zubra-language-server', version: '1.2.0' },
  };
});

const pathOf = (uri) => fileURLToPath(uri);

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
  timers.set(document.uri, setTimeout(() => {
    const path = pathOf(document.uri);
    const text = document.getText();
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

documents.listen(connection);
connection.listen();
