#!/usr/bin/env node
// create-zubra: write a working app that uses zubra components.
//
//   npm create zubra                         asks for a directory and a framework
//   npm create zubra my-app -- --framework react
//
// The app has one component (src/components/hello-counter.zb), the plugin wired up, typings,
// and a browser test (`npm test`). Nothing is installed: the last lines say what to run.
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const FRAMEWORKS = {
  vanilla: 'No framework (plain HTML and JavaScript)',
  react: 'React',
  vue: 'Vue',
  svelte: 'Svelte',
  solid: 'Solid',
  preact: 'Preact',
  lit: 'Lit',
  angular: 'Angular',
  astro: 'Astro (server-rendered pages)',
};

const templates = fileURLToPath(new URL('./templates/', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** Write the app for `framework` into `dir` (which must be empty or missing); returns the files written. */
export function create(dir, framework, { name = basename(resolve(dir)) } = {}) {
  if (!(framework in FRAMEWORKS)) throw new Error(`create-zubra: unknown framework "${framework}"; one of ${Object.keys(FRAMEWORKS).join(', ')}`);
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`create-zubra: ${dir} isn't empty`);
  cpSync(join(templates, 'shared'), target, { recursive: true });
  cpSync(join(templates, framework), target, { recursive: true });
  // npm drops .gitignore files from packages, so the template's is named _gitignore.
  renameSync(join(target, '_gitignore'), join(target, '.gitignore'));
  const files = walk(target);
  const values = { name: packageName(name), title: name.replace(/[<>{}"'`&\\$]/g, '') || 'Zubra app', version, framework: FRAMEWORKS[framework].replace(/ \(.*/, '') };
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const filled = text.replace(/\{\{(name|title|version|framework)\}\}/g, (_, key) => values[key]);
    if (filled !== text) writeFileSync(file, filled);
  }
  return files.map((file) => relative(target, file)).sort();
}

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

const packageName = (name) => name.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || 'zb-app';

/** `[dir] [--framework <name>] [--yes]` → `{ dir, framework, yes, help }`. */
export function parse(argv) {
  const options = { dir: null, framework: null, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--framework' || arg === '-f' || arg === '--template' || arg === '-t') options.framework = argv[++i];
    else if (arg.startsWith('--framework=') || arg.startsWith('--template=')) options.framework = arg.slice(arg.indexOf('=') + 1);
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-') && !options.dir) options.dir = arg;
    else throw new Error(`create-zubra: unexpected argument ${arg}`);
  }
  return options;
}

async function main(argv) {
  const options = parse(argv);
  if (options.help) {
    console.log(`usage: npm create zubra [directory] -- [--framework ${Object.keys(FRAMEWORKS).join('|')}] [--yes]`);
    return;
  }
  const ask = !options.yes && process.stdin.isTTY;
  const prompt = ask ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    let { dir, framework } = options;
    if (!dir) dir = ask ? (await prompt.question('Directory (zb-app): ')).trim() || 'zb-app' : 'zb-app';
    if (!framework) {
      const names = Object.keys(FRAMEWORKS);
      if (ask) {
        console.log(names.map((key, i) => `  ${i + 1}. ${FRAMEWORKS[key]}`).join('\n'));
        const answer = (await prompt.question('Framework (1): ')).trim();
        framework = names[Number(answer || 1) - 1] ?? answer;
      } else {
        framework = 'vanilla';
      }
    }
    create(dir, framework);
    const cd = relative(process.cwd(), resolve(dir)) || '.';
    console.log(`\nA Zubra app (${FRAMEWORKS[framework]}) is in ${cd}. Next:\n\n${cd === '.' ? '' : `  cd ${cd}\n`}  npm install\n  npm run dev     edit src/components/hello-counter.zb: it updates in place\n  npm test        builds the app and clicks through it in Chromium\n`);
  } finally {
    prompt?.close();
  }
}

// Run as a command (npm's bin is a link to this file), not imported.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
