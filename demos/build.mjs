// Builds the demo gallery for GitHub Pages:
//
//   node demos/build.mjs [--out _site] [--base /zubra/] [--require-wasm] [--only id,id]
//
//   <base>                 the gallery (index.html): every example, with a screenshot
//   <base>playground/      the playground (playground/build.mjs)
//   <base>docs/            the documentation (docs/site/build.mjs; `npm ci` in docs/site)
//   <base>demos/<id>/      each static example, built to be served from there
//
// --base defaults to /<repository>/ on GitHub Actions (Pages serves a project site there), and
// to / elsewhere. The static examples need their dependencies installed: `npm ci` in
// examples/frameworks (all seven framework apps), examples/todo, examples/planner,
// examples/recipes and examples/meta/eleventy-trails. Without compiler/zubra.wasm the examples
// are compiled with the CLI (`cargo build` at the root).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
writeFileSync(join(out, 'index.html'), gallery({ base, built: present, shots: existsSync(shots) }));
writeFileSync(join(out, '.nojekyll'), '');
console.log(`demos: ${out} (${present.length} live examples, served from ${base})`);

function gallery({ built, shots }) {
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const source = (demo) => `https://github.com/${repository ?? 'journey-to-code-org/zubra'}/tree/main/${demo.dir}`;
  const groups = [...new Set(demos.map((demo) => demo.group))];
  const card = (demo) => {
    const live = built.includes(demo.id);
    const image = shots && existsSync(join(here, 'shots', `${demo.id}.jpg`))
      ? `<img src="shots/${demo.id}.jpg" alt="" width="1280" height="800" loading="lazy">`
      : '<div class="placeholder" aria-hidden="true"></div>';
    const open = live ? `demos/${demo.id}/` : source(demo);
    return `<article class="card">
      <a class="shot" href="${open}" tabindex="-1" aria-hidden="true">${image}</a>
      <div class="body">
        <p class="stack">${escape(demo.stack)}</p>
        <h3><a href="${open}">${escape(demo.title)}</a></h3>
        <p>${escape(demo.blurb)}</p>
        <p class="links">${live ? `<a href="demos/${demo.id}/">Open the demo</a>` : '<span class="server">Needs a server: run it locally</span>'} <a href="${source(demo)}">Source</a></p>
      </div>
    </article>`;
  };
  const version = JSON.parse(readFileSync(join(repo, 'runtime/package.json'), 'utf8')).version;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Zubra demos</title>
  <meta name="description" content="Web components written like JSX, compiled by Zubra, in every framework: live demos and their source.">
  <style>
    :root {
      --bg: #f6f7fb; --surface: #ffffff; --ink: #1c2030; --muted: #61677a; --line: #dfe2ea; --accent: #4f5df5; --on-accent: #ffffff;
      color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #12141b; --surface: #1a1d27; --ink: #e8eaf2; --muted: #9aa0b4; --line: #2c3040; --accent: #8b95ff; --on-accent: #12141b; color-scheme: dark; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 system-ui, sans-serif; }
    a { color: var(--accent); }
    .wrap { max-width: 72rem; margin: 0 auto; padding: 0 1rem; }
    header { padding: 3rem 0 1.5rem; }
    header h1 { margin: 0 0 0.5rem; font-size: clamp(1.8rem, 4vw, 2.6rem); letter-spacing: -0.02em; }
    header p { margin: 0 0 1rem; max-width: 42rem; color: var(--muted); font-size: 1.1rem; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }
    .actions a { padding: 0.5rem 0.9rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); text-decoration: none; font-weight: 600; }
    .actions a.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    h2 { margin: 2.5rem 0 1rem; font-size: 1.15rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); gap: 1rem; }
    .card { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: 0.75rem; background: var(--surface); }
    .shot { display: block; aspect-ratio: 16 / 10; border-bottom: 1px solid var(--line); background: var(--bg); overflow: hidden; }
    .shot img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; transition: transform 0.2s; }
    .card:hover .shot img { transform: scale(1.02); }
    .placeholder { width: 100%; height: 100%; }
    .body { display: flex; flex-direction: column; flex: 1; padding: 0.9rem 1rem 1rem; }
    .body p { margin: 0 0 0.6rem; color: var(--muted); font-size: 0.95rem; }
    .body h3 { margin: 0 0 0.35rem; font-size: 1.05rem; }
    .body h3 a { color: inherit; text-decoration: none; }
    .body h3 a:hover { color: var(--accent); }
    .stack { font-size: 0.8rem !important; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent) !important; }
    .links { display: flex; flex-wrap: wrap; gap: 1rem; margin: auto 0 0 !important; font-size: 0.9rem !important; }
    .server { color: var(--muted); }
    footer { margin: 3rem 0; color: var(--muted); font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Zubra demos</h1>
      <p>Web components written like JSX and compiled ahead of time, used in every framework and on every kind of server. Each one is a complete app, tested in a browser on every change.</p>
      <div class="actions">
        <a class="primary" href="playground/">Try the playground</a>
        <a href="docs/">Read the docs</a>
        <a href="https://github.com/${repository ?? 'journey-to-code-org/zubra'}">Source on GitHub</a>
      </div>
    </header>
    <main>
${groups.map((group) => `      <section>
        <h2>${escape(group)}</h2>
        <div class="grid">
          ${demos.filter((demo) => demo.group === group).map(card).join('\n          ')}
        </div>
      </section>`).join('\n')}
    </main>
    <footer>Zubra ${escape(version)}. The apps marked “needs a server” run locally: each one’s README has the commands.</footer>
  </div>
</body>
</html>
`;
}
