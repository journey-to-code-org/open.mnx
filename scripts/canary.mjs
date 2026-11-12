#!/usr/bin/env node
// Moves an example's frameworks to newer releases than the ones it pins, for the weekly canary
// (.github/workflows/canary.yml): the same tests then run against what the frameworks are about to ship.
//
//   node scripts/canary.mjs <folder> --channel latest|next [--dry-run]
//
// `latest` takes each framework's `latest` tag. `next` takes the newest of its pre-release tags (next,
// rc, beta, canary, alpha) when that is newer than `latest`, and `latest` otherwise, so a stale `next`
// tag (React's is often behind its release) never moves a framework backwards. The bundler plugins that
// pair with a framework follow the same channel, since a framework's next major usually needs its
// plugin's (Solid 2 needs vite-plugin-solid 3). Aliases (`react18`: `npm:react@18.3.1`) are left alone, so a pinned second
// version stays a pinned second version. Writes package.json, runs `npm install`, and prints what moved
// (also to $GITHUB_STEP_SUMMARY when it's set).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The frameworks Zubra's adapters and SSR bridge are tested against, by package name or scope. */
export const FRAMEWORKS = [
  'react', 'react-dom', 'vue', 'vue-router', 'svelte', '@sveltejs/kit', 'solid-js', '@solidjs/start', 'lit', '@lit/context',
  'preact', 'next', 'nuxt', 'react-router', '@react-router/*', '@angular/*', 'astro', '@11ty/eleventy',
];

/** Their bundler plugins and build tools, moved on the same channel. */
export const COMPANIONS = [
  '@vitejs/plugin-react', '@vitejs/plugin-vue', '@sveltejs/vite-plugin-svelte', 'vite-plugin-solid', '@preact/preset-vite',
  '@analogjs/vite-plugin-angular', '@astrojs/*',
];

/** Families released in lockstep: each member takes its leader's version when that version exists for it. */
export const LOCKSTEP = { '@angular/*': '@angular/core' };

export const PRERELEASE_TAGS = ['next', 'rc', 'beta', 'canary', 'alpha'];

const matches = (name, patterns) => patterns.some((pattern) => (pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));

/** Semver order, prereleases before their release: -1, 0 or 1. Build metadata is ignored. */
export function compareVersions(a, b) {
  const parse = (version) => {
    const [core, ...pre] = version.split('+')[0].split('-');
    return { core: core.split('.').map(Number), pre: pre.length ? pre.join('-').split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) < (y.core[i] ?? 0) ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    if (x.pre[i] === y.pre[i]) continue;
    const [m, n] = [Number(x.pre[i]), Number(y.pre[i])];
    if (Number.isInteger(m) && Number.isInteger(n)) return m < n ? -1 : 1;
    if (Number.isInteger(m) !== Number.isInteger(n)) return Number.isInteger(m) ? -1 : 1;
    return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

/** The version a channel picks from a package's dist-tags, or undefined when it has no `latest`. */
export function pickVersion(tags, channel) {
  const latest = tags.latest;
  if (!latest || channel === 'latest') return latest;
  let best = latest;
  for (const tag of PRERELEASE_TAGS) if (tags[tag] && compareVersions(tags[tag], best) > 0) best = tags[tag];
  return best;
}

/** What to change in a package.json: [{ field, name, from, to }], for frameworks and companions only. */
export function plan(pkg, channel, distTags, versionExists = () => false) {
  const changes = [];
  const leaders = {};
  for (const [pattern, leader] of Object.entries(LOCKSTEP)) {
    const tags = distTags(leader);
    if (tags) leaders[pattern] = pickVersion(tags, channel);
  }
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, from] of Object.entries(pkg[field] ?? {})) {
      if (from.startsWith('npm:') || from.startsWith('file:') || from.startsWith('workspace:')) continue;
      if (!matches(name, FRAMEWORKS) && !matches(name, COMPANIONS)) continue;
      const tags = distTags(name);
      let to = tags && pickVersion(tags, channel);
      const family = Object.keys(leaders).find((pattern) => matches(name, [pattern]));
      if (to && family && leaders[family] !== to && (name === LOCKSTEP[family] || versionExists(name, leaders[family]))) to = leaders[family];
      if (to && to !== from.replace(/^[\^~]/, '')) changes.push({ field, name, from, to });
    }
  }
  return changes;
}

function npmDistTags(name) {
  try {
    return JSON.parse(execFileSync('npm', ['view', name, 'dist-tags', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return undefined;
  }
}

function npmVersionExists(name, version) {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === version;
  } catch {
    return false;
  }
}

function main(argv) {
  const folder = argv.find((arg) => !arg.startsWith('--'));
  const channel = argv[argv.indexOf('--channel') + 1];
  if (!folder || !['latest', 'next'].includes(channel)) {
    console.error('usage: node scripts/canary.mjs <folder> --channel latest|next [--dry-run]');
    process.exit(2);
  }
  const file = join(resolve(folder), 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const changes = plan(pkg, channel, npmDistTags, npmVersionExists);
  const table = ['| Package | Pinned | Canary |', '|---|---|---|', ...changes.map(({ name, from, to }) => `| \`${name}\` | ${from} | ${to} |`)].join('\n');
  const report = `### ${folder} on \`${channel}\`\n\n${changes.length ? table : 'Every framework is already at this channel.'}\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  if (argv.includes('--dry-run') || !changes.length) return;
  for (const { field, name, to } of changes) pkg[field][name] = to;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  // Peer ranges of a pre-release won't always admit the rest of the tree; the tests are the judge.
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: resolve(folder), stdio: 'inherit' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
