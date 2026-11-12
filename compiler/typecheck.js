// `zubra check --types`: the project's own TypeScript checks its components.
//
// The compiler writes each component as a TypeScript file (the script as written, every template
// expression in its scope, each child's props and events typed; see src/virtual_ts.rs), with a
// map back to the component. Those files go in a folder of their own at the project root, a
// tsconfig there extends the project's and joins the two folders with `rootDirs` (so `./badge.zb`
// and `./types` resolve from either), the project's `tsc` runs once, and each error is moved back
// onto the `.zb` line it came from. Nothing is written next to the components.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { request, sources } from './index.js';

/** The `.zb` files in `paths` (files, or folders searched without node_modules, dist, target and dot-folders, as `zubra check` searches). */
export function components(paths) {
  const found = [];
  const walk = (path) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (['node_modules', 'dist', 'target'].includes(entry) || entry.startsWith('.')) continue;
        walk(join(path, entry));
      }
    } else if (path.endsWith('.zb')) found.push(resolve(path));
  };
  for (const path of paths) walk(path);
  return found.sort();
}

/** The `tsc` the project has: its own TypeScript, as vue-tsc and svelte-check use it. */
export function findTsc(from) {
  const require = createRequire(join(from, 'noop.js'));
  let manifest;
  try {
    manifest = require.resolve('typescript/package.json');
  } catch {
    throw new Error('zubra check --types needs TypeScript in the project: npm i -D typescript');
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsc;
  return join(dirname(manifest), bin);
}

/** The nearest tsconfig.json at or above `directory`. */
function nearestTsconfig(directory) {
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, 'tsconfig.json'))) return join(at, 'tsconfig.json');
    if (dirname(at) === at) return null;
  }
}

/** A function from a UTF-8 byte offset in `text` (the compiler's) to a string index (UTF-16). */
function unitsOf(text) {
  const table = new Uint32Array(Buffer.byteLength(text) + 1);
  let bytes = 0;
  let units = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    for (let i = 0; i < size; i++) table[bytes + i] = units;
    bytes += size;
    units += character.length;
  }
  table[bytes] = units;
  return (offset) => table[Math.min(offset, bytes)];
}

/** Whether a process is running (an editor's check that owns a folder). */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The deepest folder containing every one of `paths`. */
function commonFolder(paths) {
  let common = paths[0];
  for (const path of paths) {
    while (common !== dirname(common) && path !== common && !path.startsWith(common + sep)) common = dirname(common);
  }
  return common;
}

/** `offset` in `text` as a line and column, both from 1. */
function position(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

/** A line and column (from 1) in `text` as an offset. */
function offsetOf(text, line, column) {
  let offset = 0;
  for (let at = 1; at < line; at++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset + column - 1;
}

/**
 * Check `paths` (component files or folders). Returns `{ diagnostics, checked }`: each
 * diagnostic is `{ file, line, column, code, message }`, placed in the `.zb` file when it came
 * from one. `tsc` and `root` can be given; by default they're found from the components.
 */
export function checkTypes(paths, { root, tsc, keep = false, out, folder, texts = {} } = {}) {
  const files = components(paths);
  if (!files.length) return { diagnostics: [], checked: 0 };
  const tsconfig = nearestTsconfig(dirname(files[0]));
  root ??= tsconfig ? dirname(tsconfig) : process.cwd();
  tsc ??= findTsc(root);
  // `folder`: a folder of its own inside `.zubra-types`, for a check running beside another (a
  // terminal's is `check`, an editor's `editor-<pid>`), so neither removes the other's files.
  const types = join(root, '.zubra-types');
  out ??= join(types, folder ?? 'check');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // An editor's check that was stopped part way leaves its folder: removed once its process is gone.
  if (existsSync(types)) {
    for (const entry of readdirSync(types)) {
      const pid = Number(/^editor-(\d+)$/.exec(entry)?.[1]);
      if (pid && !running(pid)) rmSync(join(types, entry), { recursive: true, force: true });
    }
  }

  // The components they import too (their files give the importers their types), checked only
  // where they were asked for.
  const all = new Set(files);
  for (const file of files) {
    for (const path of Object.keys(sources(file))) if (/\.zb(\.[jt]sx)?$/.test(path)) all.add(path);
  }
  const asked = new Set(files);
  // The generated files mirror the components from a folder holding all of them (and the
  // project), so one imported from outside the project stays inside `out` too.
  const base = commonFolder([root, ...all]);
  const virtual = new Map(); // the generated .zb.ts path → { source, code, mappings, file }
  const diagnostics = [];
  for (const file of all) {
    // `texts`: an editor's unsaved text, by path.
    const files = sources(file);
    for (const [path, text] of Object.entries(texts)) if (path in files || path === file) files[path] = text;
    const response = request({ command: 'virtual', path: file, files });
    if (!response.ok) {
      if (!asked.has(file)) continue;
      // A component that doesn't compile: `zubra check` reports that; here, it's one error.
      const [first] = response.diagnostics;
      diagnostics.push({ file, line: first?.line ?? 1, column: first?.column ?? 1, code: 'zubra', message: first?.message ?? response.error, help: first?.help ?? null });
      continue;
    }
    const { code, mappings } = JSON.parse(response.output);
    // (A `.zb.tsx` child's typings are imported as `<file>.types`.)
    const target = join(out, `${relative(base, file)}${/\.[jt]sx$/.test(file) ? '.types' : ''}.ts`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);
    const source = (texts[file] ?? readFileSync(file, 'utf8')).replace(/\r\n?/g, '\n');
    // The compiler's offsets are UTF-8 bytes; tsc's positions and the source's are string
    // indexes, which differ after any character outside ASCII.
    const inCode = unitsOf(code);
    const inSource = unitsOf(source);
    const units = mappings.map(([generated, original, length]) => [
      inCode(generated),
      inSource(original),
      inCode(generated + length) - inCode(generated),
    ]);
    virtual.set(target, { source, code, mappings: units, file, asked: asked.has(file) });
  }

  const config = {
    ...(tsconfig ? { extends: tsconfig } : {}),
    compilerOptions: {
      noEmit: true,
      rootDirs: [base, out],
      skipLibCheck: true,
      allowArbitraryExtensions: true,
      // (A component imports a `.zb.tsx` one by its file name.)
      allowImportingTsExtensions: true,
    },
    files: [...virtual.keys()],
    include: [],
  };
  writeFileSync(join(out, 'tsconfig.json'), JSON.stringify(config, null, 2));
  // (From `root`, which tsc's paths are relative to.)
  const result = spawnSync(process.execPath, [tsc, '-p', join(out, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;

  // `path(line,col): error TS1234: message`, with continuation lines indented.
  const pattern = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  let last = null;
  let reportedAny = false;
  for (const line of output.split('\n')) {
    const match = line.match(pattern);
    if (match) reportedAny = true;
    if (!match) {
      if (last && /^\s/.test(line) && line.trim()) last.message += `\n${line.trim()}`;
      continue;
    }
    const [, reported, row, col, code, message] = match;
    const absolute = resolve(root, reported);
    const entry = virtual.get(absolute) ?? virtual.get(resolve(out, reported));
    if (entry && !entry.asked) {
      last = null;
      continue;
    }
    if (!entry) {
      last = { file: absolute, line: Number(row), column: Number(col), code, message };
      diagnostics.push(last);
      continue;
    }
    const at = offsetOf(entry.code, Number(row), Number(col));
    const mapping = entry.mappings.find(([generated, , length]) => at >= generated && at <= generated + length);
    if (!mapping) {
      // Generated scaffolding: on the host tag would be a guess, so the component's first line.
      last = { file: entry.file, line: 1, column: 1, code, message };
    } else {
      const [generated, source] = mapping;
      last = { file: entry.file, ...position(entry.source, source + (at - generated)), code, message };
    }
    diagnostics.push(last);
  }
  if (result.status !== 0 && !reportedAny) throw new Error(`tsc failed:\n${output}`);
  // The same error twice (a switch's value is checked with each case), or an error in the
  // generated scaffolding that's also reported where it was written (a typo in a prop's type
  // shows in the typings too): once is enough.
  const unique = diagnostics.filter((diagnostic, index) => !diagnostics.some((other, at) => at < index
    && other.file === diagnostic.file && other.line === diagnostic.line && other.column === diagnostic.column
    && other.code === diagnostic.code && other.message === diagnostic.message) && !(
    diagnostic.line === 1 && diagnostic.column === 1 && diagnostic.code !== 'zubra'
    && diagnostics.some((other, at) => at !== index && other.file === diagnostic.file && other.code === diagnostic.code
      && other.message === diagnostic.message && (other.line !== 1 || other.column !== 1 || at < index))
  ));
  if (!keep) rmSync(out, { recursive: true, force: true });
  return { diagnostics: unique, checked: files.length, out };
}

/** `file:line:column - error TS1234: message`. */
export function formatDiagnostic({ file, line, column, code, message }, cwd = process.cwd()) {
  const shown = file.startsWith(cwd + sep) ? relative(cwd, file) : file;
  return `${shown}:${line}:${column} - error ${code}: ${message}`;
}
