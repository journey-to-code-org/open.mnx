// How the language server reaches the compiler: the WebAssembly build (@zubra/compiler) when it's
// installed in the project (the nearest one above the file being edited, or above the workspace),
// otherwise a CLI: the one named, ZUBRA_COMPILER, a cargo build in a zubra checkout, or `zubra` on
// PATH. Both give the same diagnostics, and both format (`format` answers { ok, output } or
// { ok: false, error }).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

const parent = (dir) => (dirname(dir) === dir ? null : dirname(dir));

/**
 * Where @zubra/compiler is installed for a folder: every node_modules above `root` that has it,
 * nearest first. The server can't rely on its own location for this: in the VS Code extension it
 * sits inside the extension's folder, and the compiler is in the project being edited.
 */
export function compilerEntries(root) {
  const found = [];
  for (let dir = root && resolve(root); dir; dir = parent(dir)) {
    const entry = join(dir, 'node_modules/@zubra/compiler/index.js');
    if (existsSync(entry)) found.push(entry);
  }
  return found;
}

/**
 * A CLI that `cargo build` made in a zubra checkout at or above `root` (target/debug or
 * target/release, the newer of the two), as @zubra/server finds it. Null when there's none.
 */
export function checkoutCompiler(root, { exe = process.platform === 'win32' ? '.exe' : '' } = {}) {
  for (let dir = root && resolve(root); dir; dir = parent(dir)) {
    const built = ['debug', 'release'].map((profile) => join(dir, 'target', profile, `zubra${exe}`)).filter((cli) => existsSync(cli));
    if (built.length) return built.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  }
  return null;
}

/**
 * The file to run for `command`. On Windows, spawning without a shell neither searches PATHEXT nor
 * runs a `.cmd`, so `zubra` installed from npm (a `zubra.cmd` shim) was never found: look it up
 * here. Elsewhere the command is run as given.
 */
export function resolveCommand(command, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32' || win32.extname(command)) return command;
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const folders = /[\\/]/.test(command) ? [''] : (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const folder of folders) {
    for (const extension of extensions) {
      const candidate = folder ? win32.join(folder, command + extension) : command + extension;
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * The backend for a workspace. Without a compiler named, a file below the workspace that has its
 * own @zubra/compiler (an app with its own node_modules) is answered by that one once `prepare`
 * has loaded it; everything else by the workspace's. `onUnavailable(message)` is told once when
 * the CLI can't be run, instead of every file getting an error that isn't about the file.
 */
export async function createBackend({ compiler, root, onUnavailable = (message) => console.error(message) } = {}) {
  if (compiler) return cliBackend(() => resolveCommand(compiler), onUnavailable);
  const loaded = new Map(); // entry → its backend, or null when its WebAssembly isn't built
  const load = async (entry) => {
    if (!loaded.has(entry)) loaded.set(entry, await wasmFrom(pathToFileURL(entry).href));
    return loaded.get(entry);
  };
  let fallback = null;
  for (const entry of compilerEntries(root)) if ((fallback = await load(entry))) break;
  fallback ??= await wasmFrom('@zubra/compiler');
  fallback ??= cliBackend(() => {
    if (process.env.ZUBRA_COMPILER) return resolveCommand(process.env.ZUBRA_COMPILER);
    return checkoutCompiler(root) ?? resolveCommand('zubra');
  }, onUnavailable);
  const nearest = (path) => {
    for (const entry of compilerEntries(dirname(resolve(path)))) {
      const backend = loaded.get(entry);
      if (backend) return backend;
    }
    return fallback;
  };
  return {
    name: fallback.name,
    /** Loads the @zubra/compiler nearest `path`, if there's one: call before working on a file. */
    async prepare(path) {
      for (const entry of compilerEntries(dirname(resolve(path)))) if (await load(entry)) return;
    },
    check: (path, ...rest) => nearest(path).check(path, ...rest),
    manifest: (path, ...rest) => nearest(path).manifest(path, ...rest),
    format: (path, ...rest) => nearest(path).format(path, ...rest),
    formatRange: (path, ...rest) => nearest(path).formatRange(path, ...rest),
    refactor: (path, ...rest) => nearest(path).refactor(path, ...rest),
  };
}

async function wasmFrom(specifier) {
  try {
    const wasm = await import(specifier);
    if (wasm.available()) return wasmBackend(wasm);
  } catch {
    // Not installed there, or its WebAssembly isn't built.
  }
  return null;
}

function wasmBackend(wasm) {
  return {
    name: 'wasm',
    check(path, text) {
      const files = wasm.sources(path);
      files[resolve(path)] = text;
      // Imports of the unsaved text, too.
      for (const specifier of importsOf(text)) {
        // SPIKE: a package's component, keyed by its specifier.
        if (!specifier.startsWith('.')) { const found = wasm.packageFile?.(dirname(path), specifier); if (found) wasm.sources(found, files, specifier); }
        else wasm.sources(resolve(dirname(path), specifier), files);
      }
      return wasm.request({ command: 'check', path: resolve(path), files }).diagnostics;
    },
    manifest(path) {
      const response = wasm.compileFile(path, { emit: 'manifest' });
      return response.ok ? JSON.parse(response.output) : null;
    },
    format(path, text, options) {
      const absolute = resolve(path);
      const response = wasm.request({ command: 'format', path: absolute, files: { [absolute]: text }, ...options });
      return response.ok ? { ok: true, output: response.output } : { ok: false, error: response.error ?? '' };
    },
    formatRange(path, text, range, options) {
      const absolute = resolve(path);
      const response = wasm.request({ command: 'formatRange', path: absolute, files: { [absolute]: text }, ...range, ...options });
      return rangeEdit(response?.ok ? { ok: true, output: response.output } : { ok: false, error: response?.error ?? '' });
    },
    refactor(path, text, extraction) {
      const absolute = resolve(path);
      const files = wasm.sources(absolute);
      files[absolute] = text;
      for (const specifier of importsOf(text)) {
        // SPIKE: a package's component, keyed by its specifier.
        if (!specifier.startsWith('.')) { const found = wasm.packageFile?.(dirname(absolute), specifier); if (found) wasm.sources(found, files, specifier); }
        else wasm.sources(resolve(dirname(absolute), specifier), files);
      }
      return refactored(wasm.request({ command: 'refactor', action: 'extract', path: absolute, files, ...extraction }));
    },
  };
}

/**
 * A `formatRange` answer as { ok, edit } (edit: null when nothing changes) or { ok: false, error,
 * unsupported? }. A compiler from before the command compiles the file instead: its answer isn't
 * the command's.
 */
function rangeEdit(answer) {
  if (!answer.ok) return { ok: false, error: answer.error, unsupported: /unknown command|usage: zubra/.test(answer.error) };
  try {
    const parsed = JSON.parse(answer.output);
    if (parsed && typeof parsed === 'object' && 'edit' in parsed) return { ok: true, edit: parsed.edit };
  } catch {
    // Not the command's answer.
  }
  return { ok: false, error: 'this compiler does not know range formatting', unsupported: true };
}

/** A `refactor` response as { ok, result } or { ok: false, reason, unsupported? }. */
function refactored(response) {
  if (response?.ok) {
    // A compiler from before the command doesn't know it and compiles the file instead.
    try {
      const result = JSON.parse(response.output);
      if (typeof result?.fileSource === 'string' && Array.isArray(result.edits)) return { ok: true, result };
    } catch {
      // Not the command's answer.
    }
    return { ok: false, unsupported: true, reason: 'this compiler does not know the refactor command' };
  }
  return { ok: false, reason: response?.diagnostics?.[0]?.message ?? response?.error ?? 'the compiler did not answer' };
}

/** How to run a CLI: a `.cmd` or `.bat` (an npm shim on Windows) only runs through the shell. */
function runner(command) {
  if (/\.(cmd|bat)$/i.test(command)) {
    const quote = (text) => `"${String(text).replace(/"/g, '""')}"`;
    return (args, input) => spawnSync(quote(command), args.map(quote), { encoding: 'utf8', input, shell: true, windowsHide: true });
  }
  return (args, input) => spawnSync(command, args, { encoding: 'utf8', input, windowsHide: true });
}

/**
 * The CLI `locate()` names. It's looked for again when it can't be run, so building or installing
 * it works without restarting the editor. That it can't be run is said once, through
 * `onUnavailable`, and isn't a diagnostic: it's about the setup, not the file.
 */
function cliBackend(locate, onUnavailable) {
  let command = locate();
  let told = false;
  const run = (args, input) => {
    let result = runner(command)(args, input);
    if (result.error) {
      const again = locate();
      if (again !== command) {
        command = again;
        result = runner(command)(args, input);
      }
    }
    if (!result.error) told = false;
    else if (!told) {
      told = true;
      onUnavailable?.(`zubra: couldn't run the compiler \`${command}\` (${result.error.code ?? result.error.message}), so .zb files aren't checked or formatted. Install @zubra/compiler in the project (npm i -D @zubra/compiler), run \`cargo build\` in a zubra checkout, or set the zubra.compiler setting to the CLI's path.`);
    }
    return result;
  };
  return {
    name: 'cli',
    check(path, text) {
      const result = run(['check', path, '--stdin', '--format', 'json'], text);
      if (result.error) return [];
      try { return JSON.parse(result.stdout); } catch { return []; }
    },
    manifest(path) {
      const result = run(['compile', path, '--emit', 'manifest']);
      if (result.status !== 0) return null;
      try { return JSON.parse(result.stdout); } catch { return null; }
    },
    format(path, text, { indentWidth, useTabs, printWidth } = {}) {
      const args = ['fmt', '--stdin', path];
      if (useTabs) args.push('--tabs');
      else if (indentWidth) args.push('--indent', String(indentWidth));
      if (printWidth) args.push('--width', String(printWidth));
      const result = run(args, text);
      if (result.error) return { ok: false, error: result.error.message };
      return result.status === 0 ? { ok: true, output: result.stdout } : { ok: false, error: result.stderr };
    },
    formatRange(path, text, range, { indentWidth, useTabs, printWidth } = {}) {
      const absolute = resolve(path);
      const request = { command: 'formatRange', path: absolute, files: { [absolute]: text }, ...range, indentWidth, useTabs, printWidth };
      const result = run(['request'], JSON.stringify(request));
      if (result.error) return { ok: false, error: result.error.message };
      try {
        const response = JSON.parse(result.stdout);
        return rangeEdit(response.ok ? { ok: true, output: response.output } : { ok: false, error: response.error ?? '' });
      } catch {
        return { ok: false, error: result.stderr, unsupported: true };
      }
    },
    refactor(path, text, extraction) {
      const absolute = resolve(path);
      const files = { [absolute]: text };
      for (const specifier of importsOf(text)) {
        const imported = resolve(dirname(absolute), specifier);
        const source = readText(imported);
        if (source !== null) files[imported] = source;
      }
      const result = run(['request'], JSON.stringify({ command: 'refactor', action: 'extract', path: absolute, files, ...extraction }));
      if (result.error) return { ok: false, reason: result.error.message };
      try { return refactored(JSON.parse(result.stdout)); } catch { return { ok: false, reason: result.stderr || 'the compiler did not answer', unsupported: true }; }
    },
  };
}

/** `.zb` files a component's script imports (relative specifiers). */
export function importsOf(text) {
  const script = text.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  return [...script.matchAll(/import\s+(?:[^'"]*?from\s+)?['"](\.{1,2}\/[^'"]+\.zb)['"]/g)].map((match) => match[1]);
}

export const readText = (path) => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};
