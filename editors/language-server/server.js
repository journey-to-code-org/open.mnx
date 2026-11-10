#!/usr/bin/env node
// zubra language server: diagnostics from the compiler as you type, completion of directives,
// imported components, their props and events, hover documentation from their manifests, and
// go to definition for imported components, and formatting (`zubra fmt`). Speaks LSP over stdio
// (`--stdio`).
//
// initializationOptions: { compiler?: "/path/to/zubra", printWidth?: number } — otherwise
// @zubra/compiler (WebAssembly) when installed, else `zubra` on PATH. printWidth is the width a
// tag is fitted into when formatting (default 100); indentation comes from the editor.
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
let printWidth;
let toldAboutVersion = false;
let toldAboutRangeVersion = false;
const manifests = new Map(); // path → { mtime, component }

connection.onInitialize(async (params) => {
  const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  backend = await createBackend({ ...params.initializationOptions, root: folder ? fileURLToPath(folder) : undefined });
  printWidth = Number(params.initializationOptions?.printWidth) || undefined;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['<', ' ', '{'] },
      hoverProvider: true,
      definitionProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
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

documents.listen(connection);
connection.listen();
