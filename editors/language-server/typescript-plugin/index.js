// A TypeScript server plugin: `.ts` and `.tsx` files that import a component (`./badge.zb`,
// `./badge.zb?react`, `./card.zb.tsx`) get its real typings, straight from the compiler, without
// waiting for the build plugin to write `badge.d.zb.ts` and without `allowArbitraryExtensions`.
//
// The VS Code extension registers it with tsserver. Elsewhere, add it to tsconfig.json:
//
//   { "compilerOptions": { "plugins": [{ "name": "@zubra/language-server/typescript-plugin" }] } }
//
// Options (in that entry, or from the extension's `zubra.compiler` setting): `compiler`, a zubra
// CLI to use instead of the project's @zubra/compiler; `framework` (`react`, `vue`, `svelte`,
// `solid` or `none`), the variant a plain `./badge.zb` import gets, when the project's
// package.json doesn't say.
//
// An import resolves to a file that isn't on disk, `<component>.<framework>.zubra.d.ts`, whose
// text is the compiler's `--emit dts`. Its version is the component's modification time, and
// the component is watched, so saving it updates the files that import it. tsserver runs this
// synchronously, so the typings are made by a short-lived Node process (`typings.mjs`), all
// that are missing at once, and kept until the component changes.
'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, statSync, watch: watchFile } = require('node:fs');
const { dirname, isAbsolute, join, resolve } = require('node:path');

/** A component import, with an optional variant: `./x.zb`, `./x.zb.tsx`, `./x.zb?react`. */
const COMPONENT = /^(.+\.zb(?:\.[jt]sx)?)(?:\?(element|react|vue))?$/;
/** A file this plugin makes up. */
const VIRTUAL = /^(.+\.zb(?:\.[jt]sx)?)\.(react|vue|svelte|solid|none)\.zubra\.d\.ts$/;
const FRAMEWORKS = ['react', 'vue', 'svelte', 'solid'];

/** The framework of the nearest package.json above `dir` that names one, or `none`. */
function projectFramework(dir) {
  for (let at = dir; at && dirname(at) !== at; at = dirname(at)) {
    const file = join(at, 'package.json');
    if (!existsSync(file)) continue;
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies });
      // The same order as the build plugin: Vue before React (a Vue project may pull React in for
      // a tool), then the others.
      const found = ['vue', 'react', 'svelte', 'solid-js'].find((name) => names.includes(name));
      if (found) return found === 'solid-js' ? 'solid' : found;
    } catch {
      // A package.json that doesn't parse names nothing.
    }
  }
  return 'none';
}

function init({ typescript: ts }) {
  /** Options from the extension (`configurePlugin`), under each project's own (tsconfig.json). */
  const external = {};

  function create(info) {
    const host = info.languageServiceHost;
    const project = info.project;
    const own = { ...info.config };
    const config = new Proxy(own, { get: (target, key) => target[key] ?? external[key] });
    const log = (message) => project?.projectService?.logger?.info?.(`[zubra] ${message}`);
    /** Typings by virtual file name: `{ stamp, text }`. */
    const typings = new Map();
    const watched = new Map();

    const stampOf = (path) => {
      try {
        return String(statSync(path).mtimeMs);
      } catch {
        return 'missing';
      }
    };

    /** The framework a component imported from `importer` with `variant` is typed for. */
    function frameworkFor(variant, importer) {
      if (variant === 'element') return 'none';
      if (variant) return variant;
      if (FRAMEWORKS.includes(config.framework) || config.framework === 'none') return config.framework;
      return projectFramework(dirname(importer));
    }

    /** The virtual file an import of a component resolves to, or undefined for anything else. */
    function resolveComponent(specifier, importer) {
      const match = COMPONENT.exec(specifier);
      if (!match) return undefined;
      const [, file, variant] = match;
      // (A package's components come with the package's own typings.)
      if (!file.startsWith('.') && !isAbsolute(file)) return undefined;
      const path = resolve(dirname(importer), file);
      if (!existsSync(path)) return undefined;
      const name = `${path}.${frameworkFor(variant, importer)}.zubra.d.ts`;
      watch(path, name);
      return {
        resolvedFileName: name,
        extension: ts.Extension.Dts,
        isExternalLibraryImport: false,
      };
    }

    /** Saving a component updates the files that import it: its typings are read again. */
    function watch(path, name) {
      const entry = watched.get(path);
      if (entry) {
        entry.names.add(name);
        return;
      }
      const names = new Set([name]);
      const changed = (event) => {
        // Saved by replacing the file (as many editors save): watch the new one.
        if (event === 'rename') {
          watched.get(path)?.watcher?.close();
          watched.delete(path);
          setTimeout(() => {
            if (existsSync(path)) for (const virtual of names) watch(path, virtual);
          }, 50);
        }
        const service = project?.projectService;
        for (const virtual of names) {
          const script = service?.getScriptInfo?.(virtual);
          if (script?.delayReloadNonMixedContentFile) script.delayReloadNonMixedContentFile();
          else script?.reloadFromFile?.();
        }
        project?.markAsDirty?.();
        service?.delayEnsureProjectForOpenFiles?.();
      };
      // (Node's own watcher: tsserver's may be handed to the editor, which watches only what it
      // knows of.)
      let watcher = null;
      try {
        watcher = watchFile(path, { persistent: false }, changed);
      } catch {
        // A file that can't be watched is read again when it's next resolved.
      }
      watched.set(path, { names, watcher });
    }

    /** Makes every missing or stale typing among `names` (one Node process for all of them). */
    function make(names) {
      const wanted = [];
      for (const name of names) {
        const [, path, framework] = VIRTUAL.exec(name);
        const stamp = stampOf(path);
        if (typings.get(name)?.stamp !== stamp) wanted.push({ name, path, framework, stamp });
      }
      if (!wanted.length) return;
      const script = join(__dirname, '..', 'typings.mjs');
      // Under VS Code, tsserver runs on Electron, which is Node with this set.
      const run = spawnSync(process.execPath, [script], {
        input: JSON.stringify({ components: wanted.map(({ path, framework }) => ({ path, framework })), compiler: config.compiler || undefined }),
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        maxBuffer: 1 << 28,
      });
      let results = [];
      try {
        results = JSON.parse(run.stdout);
      } catch {
        log(`couldn't make typings: ${run.error?.message ?? run.stderr}`);
      }
      wanted.forEach(({ name, path, stamp }, index) => {
        const result = results[index];
        if (result?.error) log(`${path}: ${result.error}`);
        // A component that doesn't compile still imports: as `any`, until it does.
        const text = result?.text ?? `// ${path} doesn't compile; see its errors.\ndeclare const component: any;\nexport default component;\nexport declare const tag: string;\n`;
        typings.set(name, { stamp, text });
      });
    }

    /** Virtual files resolved but not made yet: made together when the first is read. */
    const pending = new Set();

    // Resolution: a component import goes to its virtual file; everything else as before.
    if (host.resolveModuleNameLiterals) {
      const original = host.resolveModuleNameLiterals.bind(host);
      host.resolveModuleNameLiterals = (literals, containingFile, ...rest) => {
        const resolved = original(literals, containingFile, ...rest);
        return literals.map((literal, index) => {
          const component = resolveComponent(literal.text, containingFile);
          if (!component) return resolved[index];
          pending.add(component.resolvedFileName);
          return { resolvedModule: component };
        });
      };
    }
    if (host.resolveModuleNames) {
      const original = host.resolveModuleNames.bind(host);
      host.resolveModuleNames = (names, containingFile, ...rest) => {
        const resolved = original(names, containingFile, ...rest);
        return names.map((name, index) => {
          const component = resolveComponent(name, containingFile);
          if (!component) return resolved[index];
          pending.add(component.resolvedFileName);
          return component;
        });
      };
    }

    const isVirtual = (name) => VIRTUAL.test(name);
    const read = (name) => {
      make([...pending, name]);
      pending.clear();
      return typings.get(name)?.text;
    };

    // tsserver keeps a record of every file a program has (a script info), read through the
    // server's own host: there, a virtual file reads as its typings, and is as old as its
    // component.
    const server = project?.projectService?.host;
    if (server && !server.zubraTypings) {
      const readers = [];
      server.zubraTypings = readers;
      const owner = (name) => readers.find((reader) => reader.owns(name));
      const { fileExists, readFile, getModifiedTime } = server;
      server.fileExists = (name) => (isVirtual(name) ? Boolean(owner(name)) || fileExists.call(server, name) : fileExists.call(server, name));
      server.readFile = (name, encoding) => (isVirtual(name) && owner(name) ? owner(name).read(name) : readFile.call(server, name, encoding));
      if (getModifiedTime) server.getModifiedTime = (name) => getModifiedTime.call(server, isVirtual(name) ? VIRTUAL.exec(name)[1] : name);
    }
    if (server?.zubraTypings) server.zubraTypings.push({ owns: (name) => pending.has(name) || typings.has(name), read });

    // Any other host (a language service of one's own): the same, on the host.
    if (server) {
      log('ready');
      return decorate(info.languageService);
    }
    const getScriptSnapshot = host.getScriptSnapshot.bind(host);
    host.getScriptSnapshot = (name) => (isVirtual(name) ? ts.ScriptSnapshot.fromString(read(name) ?? '') : getScriptSnapshot(name));
    const getScriptVersion = host.getScriptVersion.bind(host);
    host.getScriptVersion = (name) => (isVirtual(name) ? stampOf(VIRTUAL.exec(name)[1]) : getScriptVersion(name));
    if (host.fileExists) {
      const fileExists = host.fileExists.bind(host);
      host.fileExists = (name) => isVirtual(name) || fileExists(name);
    }
    if (host.readFile) {
      const readFile = host.readFile.bind(host);
      host.readFile = (name, encoding) => (isVirtual(name) ? read(name) : readFile(name, encoding));
    }
    if (host.getScriptKind) {
      const getScriptKind = host.getScriptKind.bind(host);
      host.getScriptKind = (name) => (isVirtual(name) ? ts.ScriptKind.TS : getScriptKind(name));
    }

    log('ready');
    return decorate(info.languageService);
  }

  /** Go to definition on an import lands in the component, not its typings. */
  function decorate(service) {
    const proxy = Object.create(null);
    for (const key of Object.keys(service)) proxy[key] = (...args) => service[key](...args);
    const toComponent = (definition) => {
      const match = VIRTUAL.exec(definition.fileName);
      return match ? { ...definition, fileName: match[1], textSpan: { start: 0, length: 0 }, contextSpan: undefined } : definition;
    };
    proxy.getDefinitionAndBoundSpan = (fileName, position) => {
      const result = service.getDefinitionAndBoundSpan(fileName, position);
      return result?.definitions ? { ...result, definitions: result.definitions.map(toComponent) } : result;
    };
    proxy.getDefinitionAtPosition = (fileName, position) => service.getDefinitionAtPosition(fileName, position)?.map(toComponent);
    return proxy;
  }

  /** The VS Code extension passes its `zubra.compiler` setting. */
  function onConfigurationChanged(settings) {
    for (const key of Object.keys(external)) delete external[key];
    Object.assign(external, settings);
  }

  return { create, onConfigurationChanged };
}

module.exports = init;
module.exports.projectFramework = projectFramework;
