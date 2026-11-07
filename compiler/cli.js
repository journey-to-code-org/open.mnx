#!/usr/bin/env node
// `mnx` from npm (@mnx/compiler): the WebAssembly compiler on the command line, with no Rust.
//
//   mnx build --lib <dir> [--out dist] [--name <package>] [--version <x.y.z>]
//   mnx add <component>... [--dir src/components] [--force]     copy registry components in
//   mnx add --list
//   mnx compile <file> [--emit js|html|css|dts|manifest] [--framework react|vue|svelte|solid] [--partial]
//   mnx check <file>...
//   mnx convert <Component.jsx> [--prefix <word>] [--out <file> | --stdout]   React → mnx JSX
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFile, request } from './index.js';
import { buildLibrary } from './library.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The component registry: shipped in the package, or the repository's when run from a checkout. */
export function registryDir() {
  for (const dir of [join(here, 'registry'), join(here, '../registry')]) {
    if (existsSync(join(dir, 'index.json'))) return dir;
  }
  throw new Error('mnx add: the component registry is missing from this install');
}

export function readRegistry(dir = registryDir()) {
  return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
}

/**
 * Copy registry components (and those they use) into `target`. Returns the files written.
 * An existing file is an error unless `force`, so your edits are never overwritten.
 */
export function add(names, { target = 'src/components', force = false, registry = registryDir() } = {}) {
  const { components } = readRegistry(registry);
  const byName = new Map(components.map((component) => [component.name, component]));
  const wanted = new Set();
  const visit = (name) => {
    const component = byName.get(name);
    if (!component) {
      const near = [...byName.keys()].filter((candidate) => candidate.startsWith(name.slice(0, 3)) || distance(candidate, name) <= 2);
      throw new Error(`mnx add: no component "${name}" in the registry${near.length ? `; did you mean ${near.join(', ')}?` : ''} (mnx add --list)`);
    }
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const dependency of component.dependencies ?? []) visit(dependency);
  };
  for (const name of names) visit(name);
  const files = [...wanted].flatMap((name) => byName.get(name).files);
  mkdirSync(target, { recursive: true });
  const clashes = files.filter((file) => existsSync(join(target, file)));
  if (clashes.length && !force) throw new Error(`mnx add: ${clashes.map((file) => join(target, file)).join(', ')} already exists (--force replaces it)`);
  for (const file of files) copyFileSync(join(registry, 'components', file), join(target, file));
  return files.map((file) => join(target, file));
}

/** Edit distance, for "did you mean". */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

function options(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) rest.push(arg);
    else if (['--lib', '--force', '--list', '--partial', '--stdout'].includes(arg)) flags[arg.slice(2)] = true;
    else flags[arg.slice(2)] = args[++i];
  }
  return { flags, rest };
}

function main(argv) {
  const [command, ...args] = argv;
  const { flags, rest } = options(args);
  if (command === 'build') {
    if (!flags.lib || rest.length !== 1) throw new Error('usage: mnx build --lib <components dir> [--out dist] [--name <package>] [--version <x.y.z>]');
    const out = flags.out ?? 'dist';
    const { components, warnings } = buildLibrary(rest[0], { out, name: flags.name, version: flags.version });
    for (const warning of warnings) process.stderr.write(warning);
    console.log(`mnx: built ${components.length} component${components.length === 1 ? '' : 's'} into ${relative(process.cwd(), resolve(out)) || '.'}: ${components.map(({ tag }) => `<${tag}>`).join(' ')}`);
  } else if (command === 'add') {
    if (flags.list) {
      for (const component of readRegistry().components) console.log(`${component.name.padEnd(20)} ${component.description}`);
      return;
    }
    if (!rest.length) throw new Error('usage: mnx add <component>... [--dir src/components] [--force]   (mnx add --list)');
    const files = add(rest, { target: flags.dir ?? 'src/components', force: flags.force });
    console.log(`mnx: added ${files.join(', ')}. They're yours now: edit them as you like.`);
  } else if (command === 'convert') {
    if (rest.length !== 1) throw new Error('usage: mnx convert <Component.jsx> [--prefix <word>] [--out <file> | --stdout]');
    const path = resolve(rest[0]);
    const response = request({ command: 'convert', path, files: { [path]: readFileSync(path, 'utf8') }, prefix: flags.prefix });
    if (!response.ok) throw new Error(response.error);
    for (const change of response.changes) process.stderr.write(`${rest[0]}: ${change}\n`);
    if (flags.stdout) process.stdout.write(response.output);
    else {
      const target = flags.out ?? relative(process.cwd(), response.file);
      writeFileSync(target, response.output);
      process.stderr.write(`${rest[0]}: wrote ${target} (<${response.tag}>)\n`);
    }
    for (const warning of response.warnings) process.stderr.write(warning);
    if (!response.complete) {
      process.stderr.write(`${response.diagnostics.length} thing${response.diagnostics.length === 1 ? '' : 's'} to finish by hand (above)\n`);
      process.exitCode = 1;
    }
  } else if (command === 'compile' || command === 'check') {
    if (!rest.length) throw new Error(`usage: mnx ${command} <file>${command === 'check' ? '...' : ''}`);
    let failed = false;
    for (const file of command === 'check' ? rest : rest.slice(0, 1)) {
      const response = compileFile(file, {
        command, emit: flags.emit ?? 'html', framework: flags.framework, runtime: flags.runtime, partial: flags.partial,
        props: flags.props ? JSON.parse(readFileSync(flags.props, 'utf8')) : undefined,
      });
      for (const warning of response.warnings) process.stderr.write(warning);
      if (!response.ok) {
        process.stderr.write(response.error);
        failed = true;
      } else if (command === 'compile') {
        if (flags.output) writeFileSync(flags.output, response.output);
        else process.stdout.write(response.output);
      }
    }
    if (command === 'check' && !failed) console.log(`checked ${rest.length} file${rest.length === 1 ? '' : 's'}: no errors`);
    if (failed) process.exitCode = 1;
  } else {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 9).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
