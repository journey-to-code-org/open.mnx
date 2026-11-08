// Builds the demo gallery for GitHub Pages:
//
//   node demos/build.mjs [--out _site] [--base /zubra/] [--require-wasm] [--only id,id]
//
//   <base>                 the landing page (site/, built with Eleventy): the idea, the compiler's real
//                          output, and the gallery of every example, with a screenshot
//   <base>playground/      the playground (playground/build.mjs)
//   <base>docs/            the documentation (docs/site/build.mjs; `npm ci` in docs/site)
//   <base>demos/<id>/      each static example, built to be served from there
//
// --base defaults to /<repository>/ on GitHub Actions (Pages serves a project site there), and
// to / elsewhere. The static examples need their dependencies installed: `npm ci` in
// examples/frameworks (all seven framework apps), examples/todo, examples/planner,
// examples/recipes and examples/meta/eleventy-trails, and in site/ (the landing page). Without compiler/zubra.wasm the examples
// are compiled with the CLI (`cargo build` at the root).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demos } from './list.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = resolve(option('--out', join(repo, '_site')));
const repository = process.env.GITHUB_REPOSITORY;
const base = option('--base', process.env.GITHUB_ACTIONS && repository ? `/${repository.split('/')[1]}/` : '/');
const only = option('--only', '')?.split(',').filter(Boolean);
if (!base.startsWith('/') || !base.endsWith('/')) throw new Error(`demos: --base must start and end with / (got ${base})`);

const wasm = existsSync(join(repo, 'compiler/zubra.wasm'));
if (!wasm) {
  if (args.includes('--require-wasm')) throw new Error('demos: compiler/zubra.wasm is missing (run `npm run build` in compiler/)');
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  process.env.ZUBRA_COMPILER ??= join(repo, 'target/debug/zubra');
}

// --only rebuilds those into an existing build; otherwise it starts clean.
if (!only?.length) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const run = (command, argv, cwd, env = {}) => execFileSync(command, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
const local = (dir, bin) => join(repo, dir, 'node_modules/.bin', bin);

// The playground.
if (!only?.length || only.includes('playground')) {
  run(process.execPath, [join(repo, 'playground/build.mjs'), '--out', join(out, 'playground'), ...(args.includes('--require-wasm') ? ['--require-wasm'] : [])], repo);
}

// The documentation: the guide, topics, reference and migration notes, as pages.
if (!only?.length || only.includes('docs')) {
  const { buildDocs } = await import(pathToFileURL(join(repo, 'docs/site/build.mjs')).href);
  console.log(`demos: docs → ${base}docs/ (${buildDocs({ out, base, repository })} pages)`);
}

// The static examples.
const built = [];
let ui = false;
for (const demo of demos.filter((demo) => demo.build && (!only?.length || only.includes(demo.id)))) {
  const target = join(out, 'demos', demo.id);
  const path = `${base}demos/${demo.id}/`;
  const root = join(repo, demo.dir);
  console.log(`demos: ${demo.id} → ${path}`);
  if (demo.build === 'frameworks' || demo.build === 'vite') {
    // The framework apps resolve their toolchain from examples/frameworks; the others have their own.
    const toolchain = createRequire(join(repo, demo.build === 'frameworks' ? 'examples/frameworks' : demo.dir, 'package.json'));
    if (demo.build === 'frameworks' && !ui) {
      run(process.execPath, [join(repo, 'examples/frameworks/test/build-ui.mjs')], repo);
      ui = true;
    }
    const { build } = await import(pathToFileURL(toolchain.resolve('vite')).href);
    await build({ root, configFile: join(root, 'vite.config.js'), configLoader: 'native', logLevel: 'warn', base: path, build: { outDir: target, emptyOutDir: true } });
  } else if (demo.build === 'astro') {
    const dist = join(root, 'dist');
    run(local(demo.dir, 'astro'), ['build', '--silent'], root, { DEMO_BASE: path });
    cpSync(dist, target, { recursive: true });
    rmSync(dist, { recursive: true, force: true });
  } else if (demo.build === 'eleventy') {
    run(local(demo.dir, 'eleventy'), ['--quiet'], root, { DEMO_BASE: path, OUT: target });
  } else {
    throw new Error(`demos: ${demo.id}: unknown build "${demo.build}"`);
  }
  built.push(demo.id);
}

// Screenshots (demos/shots/, from demos/screenshots.mjs) and the gallery.
const shots = join(here, 'shots');
if (existsSync(shots)) cpSync(shots, join(out, 'shots'), { recursive: true });
const present = demos.filter((demo) => existsSync(join(out, 'demos', demo.id, 'index.html'))).map((demo) => demo.id);
// The landing page. It compiles its sample with the compiler found above and links the examples
// that are in this build.
run(local('site', 'eleventy'), ['--quiet'], join(repo, 'site'), { OUT: out, BASE: base, LANDING_OUT: out });
writeFileSync(join(out, '.nojekyll'), '');
console.log(`demos: ${out} (${present.length} live examples, served from ${base})`);
