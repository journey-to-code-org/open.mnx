// TypeScript inside `.zb` files: hover, completion and go to definition in `<script lang="ts">`
// and in every `{…}` of the template, from TypeScript's language service.
//
// The compiler writes each component as a TypeScript file with a map back to it (the file
// `zubra check --types` checks; src/virtual_ts.rs). Here those files live in memory, at
// `<component>.zb.ts` beside each component, so `import './badge.zb'` finds the badge's types,
// and a language service asks TypeScript about a position in the component by asking about the
// same position in its file. This is TypeScript 5.9's own language service, shipped with the
// server: the native TypeScript 7 has no JavaScript language service API yet. Type errors still
// come from the project's own TypeScript (`zubra check --types`), when a file is saved.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

let ts = null;
async function typescript() {
  ts ??= (await import('typescript')).default;
  return ts;
}

/** A source offset in the component as an offset in its TypeScript file, or null outside any mapped stretch. */
export function toGenerated(mappings, offset) {
  for (const [generated, source, length] of mappings) {
    if (offset >= source && offset <= source + length) return generated + (offset - source);
  }
  return null;
}

/** An offset in the TypeScript file as one in the component, or null in generated scaffolding. */
export function toSource(mappings, offset) {
  for (const [generated, source, length] of mappings) {
    if (offset >= generated && offset <= generated + length) return source + (offset - generated);
  }
  return null;
}

/**
 * The compiler reads a component with its line endings as `\n`, so its map is in that text; an
 * editor's offsets are in the text as it is, where `\r\n` is two units. These convert.
 */
export function toNormalized(text, offset) {
  let removed = 0;
  for (let at = text.indexOf('\r\n'); at !== -1 && at < offset; at = text.indexOf('\r\n', at + 2)) {
    if (at + 1 < offset) removed++;
  }
  return offset - removed;
}

export function toRaw(text, offset) {
  let added = 0;
  for (let at = text.indexOf('\r\n'); at !== -1 && at - added < offset; at = text.indexOf('\r\n', at + 2)) added++;
  return offset + added;
}

/**
 * Language services, one per tsconfig.json. `virtual(path, text)` is the backend's: the component
 * as a TypeScript file. `textOf(path)` is an open editor's text, or null for what's on disk.
 */
export function createTypeScriptServices({ virtual, textOf }) {
  const services = new Map(); // tsconfig (or folder) → { service, files }
  const generated = new Map(); // `<component>.zb.ts` → { text, code, mappings, version }
  const pinned = new Map(); // component → text used for one request in place of the editor's

  /**
   * The component's TypeScript file, regenerated when its text changed (`text` in place of the
   * editor's, for a completion that needs a placeholder). Null when the text doesn't compile: a
   * stale file would put every position in the wrong place.
   */
  function fileFor(component, text = pinned.get(component) ?? textOf(component) ?? readOrNull(component)) {
    if (text === null) return null;
    const path = `${component}.ts`;
    const current = generated.get(path);
    if (current && current.text === text) return current;
    const made = virtual(component, text);
    if (!made) return null;
    // The compiler's map is in bytes; TypeScript and the editor count UTF-16 code units.
    const source = text.replace(/\r\n?/g, '\n');
    const mappings = made.mappings.map(([generatedAt, sourceAt, length]) => {
      const start = units(made.code, generatedAt);
      return [start, units(source, sourceAt), units(made.code, generatedAt + length) - start];
    });
    const next = { text, code: made.code, mappings, version: (current?.version ?? 0) + 1 };
    generated.set(path, next);
    return next;
  }

  async function serviceFor(component) {
    const ts = await typescript();
    const config = ts.findConfigFile(dirname(component), ts.sys.fileExists);
    const key = config ?? dirname(component);
    if (services.has(key)) return services.get(key);
    let options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] };
    if (config) {
      const read = ts.readConfigFile(config, ts.sys.readFile);
      if (!read.error) options = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config)).options;
    }
    options = { ...options, noEmit: true, allowArbitraryExtensions: true, allowImportingTsExtensions: true };
    const roots = new Set();
    // A component's file: on disk, or only open in the editor (not saved yet).
    const isGenerated = (path) => path.endsWith('.zb.ts') && (generated.has(path) || textOf(path.slice(0, -3)) !== null || existsSync(path.slice(0, -3)));
    const host = {
      getCompilationSettings: () => options,
      getScriptFileNames: () => [...roots],
      getScriptVersion: (path) => {
        if (isGenerated(path)) return String(fileFor(path.slice(0, -3))?.version ?? 0);
        try { return String(statSync(path).mtimeMs); } catch { return '0'; }
      },
      getScriptSnapshot: (path) => {
        if (isGenerated(path)) {
          const file = fileFor(path.slice(0, -3));
          return file ? ts.ScriptSnapshot.fromString(file.code) : undefined;
        }
        const text = readOrNull(path);
        return text === null ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => (config ? dirname(config) : dirname(component)),
      getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
      fileExists: (path) => isGenerated(path) || ts.sys.fileExists(path),
      readFile: (path) => (isGenerated(path) ? fileFor(path.slice(0, -3))?.code : ts.sys.readFile(path)),
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    };
    const entry = { service: ts.createLanguageService(host, ts.createDocumentRegistry()), roots };
    services.set(key, entry);
    return entry;
  }

  /** The service, the component's file and the generated offset for `offset`, or null outside TypeScript. */
  async function at(component, offset, text) {
    const { service, roots } = await serviceFor(component);
    const file = fileFor(component, text);
    if (!file) return null;
    const path = `${component}.ts`;
    roots.add(path);
    const position = toGenerated(file.mappings, toNormalized(file.text, offset));
    if (position === null) return null;
    return { service, file, path, position };
  }

  /** Map a span in a TypeScript file to `{ path, start, end }` in the component it came from, or in a real file. */
  function back(fileName, start, length) {
    if (generated.has(fileName)) {
      const file = generated.get(fileName);
      const from = file && toSource(file.mappings, start);
      const to = file && toSource(file.mappings, start + length);
      if (from === null || to === null || !file) return null;
      return { path: fileName.slice(0, -3), start: toRaw(file.text, from), end: toRaw(file.text, to), text: file.text };
    }
    const text = readOrNull(fileName);
    return text === null ? null : { path: fileName, start, end: start + length, text };
  }

  return {
    /** `{ markdown, start, end }` for the symbol at `offset`, or null. */
    async hover(component, offset) {
      const found = await at(component, offset);
      if (!found) return null;
      const info = found.service.getQuickInfoAtPosition(found.path, found.position);
      if (!info) return null;
      const ts = await typescript();
      const signature = ts.displayPartsToString(info.displayParts).replace(/__zubraScript_/g, '');
      const docs = ts.displayPartsToString(info.documentation);
      const tags = (info.tags ?? []).map((tag) => `*@${tag.name}* ${ts.displayPartsToString(tag.text ?? [])}`).join('\n\n');
      const start = toSource(found.file.mappings, info.textSpan.start);
      const end = toSource(found.file.mappings, info.textSpan.start + info.textSpan.length);
      return {
        markdown: ['```ts\n' + signature + '\n```', docs, tags].filter(Boolean).join('\n\n'),
        start: start === null ? offset : toRaw(found.file.text, start),
        end: end === null ? offset : toRaw(found.file.text, end),
      };
    },

    /** Completion entries at `offset`, or null outside TypeScript. */
    async completions(component, offset, text) {
      if (text !== undefined) pinned.set(component, text);
      let result;
      try {
        const found = await at(component, offset, text);
        if (!found) return null;
        result = found.service.getCompletionsAtPosition(found.path, found.position, {
          includeCompletionsWithInsertText: true,
          includeCompletionsForModuleExports: false,
        });
      } finally {
        pinned.delete(component);
      }
      if (!result) return [];
      return result.entries
        .filter((entry) => !entry.name.startsWith('__zubra') && !entry.name.startsWith('__P') && !entry.name.startsWith('__M'))
        .map((entry) => ({ label: entry.name, kind: entry.kind, sortText: entry.sortText, insertText: entry.insertText }));
    },

    /** Where the symbol at `offset` is defined: `[{ path, start, end, text }]`, or null outside TypeScript. */
    async definition(component, offset) {
      const found = await at(component, offset);
      if (!found) return null;
      let definitions = found.service.getDefinitionAtPosition(found.path, found.position) ?? [];
      // The template reads a script name through `const name = __zubraValue(…)` (a signal is its
      // value there): follow it to the script's own declaration.
      definitions = definitions.flatMap((definition) => {
        if (definition.fileName !== found.path) return [definition];
        const name = found.file.code.slice(definition.textSpan.start, definition.textSpan.start + definition.textSpan.length);
        const alias = `const __zubraScript_${name} = ${name};`;
        const at = found.file.code.indexOf(alias);
        if (toSource(found.file.mappings, definition.textSpan.start) !== null || at < 0) return [definition];
        return found.service.getDefinitionAtPosition(found.path, at + alias.length - 1 - name.length) ?? [];
      });
      return definitions
        .map((definition) => back(definition.fileName, definition.textSpan.start, definition.textSpan.length))
        .filter(Boolean);
    },
  };
}

/** `bytes` UTF-8 bytes into `text`, in UTF-16 code units. */
function units(text, bytes) {
  return Buffer.from(text).subarray(0, bytes).toString().length;
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

