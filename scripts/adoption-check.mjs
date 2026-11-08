// The adoption check (plan/roadmap-adoption.md): the first ten minutes, scripted. From
// `npm create zubra` to a component library packed for publishing, with every step a newcomer
// takes, timed. CI runs it and fails over the budget.
//
//   node scripts/adoption-check.mjs [--budget-minutes 10]
//
// It runs in examples/frameworks (so the toolchain is there: dependency downloads aren't timed,
// as they depend on the network, not on zubra), with the CLI from target/debug or zubra.wasm.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from '../create/index.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--budget-minutes');
const budget = (at > 0 ? Number(process.argv[at + 1]) : 10) * 60_000;
const app = join(repo, 'examples/frameworks/.tmp-adoption');
const env = { ...process.env, ZUBRA_COMPILER: process.env.ZUBRA_COMPILER ?? join(repo, 'target/debug/zubra') };
const zubra = (...args) => execFileSync(process.execPath, [join(repo, 'compiler/cli.js'), ...args], { cwd: app, env, encoding: 'utf8', stdio: 'pipe' });

const steps = [];
const started = Date.now();
async function step(name, run) {
  const start = Date.now();
  try {
    await run();
  } catch (error) {
    console.error(`adoption check: "${name}" failed\n${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`);
    process.exit(1);
  }
  steps.push({ name, ms: Date.now() - start });
}

execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
rmSync(app, { recursive: true, force: true });

await step('npm create zubra (React)', () => create(app, 'react', { name: 'adoption app' }));
await step('zubra add toggle-switch star-rating', () => zubra('add', 'toggle-switch', 'star-rating'));
await step('edit the starter component', () => {
  const file = join(app, 'src/components/hello-counter.zb');
  writeFileSync(file, readFileSync(file, 'utf8').replace('<output aria-live="polite">{label}: {count}</output>', '<output aria-live="polite" class:many={count > 9}>{label}: {count}</output>'));
});
await step('zubra check', () => zubra('check', 'src/components/hello-counter.zb', 'src/components/toggle-switch.zb', 'src/components/star-rating.zb'));
await step("the app's own browser test (build + Chromium)", () => execFileSync(process.execPath, ['--test', 'test/app.test.js'], { cwd: app, env, stdio: 'pipe' }));
await step('zubra build --lib', () => zubra('build', '--lib', 'src/components', '--name', '@adoption/ui', '--version', '0.1.0'));
await step('npm pack (what npm publish uploads)', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: join(app, 'dist'), encoding: 'utf8', stdio: 'pipe' });
  const [{ files }] = JSON.parse(output);
  const paths = files.map((file) => file.path);
  for (const expected of ['package.json', 'index.js', 'custom-elements.json', 'react/toggle-switch.js', 'vue/star-rating.d.ts', 'hello-counter.js']) {
    if (!paths.includes(expected)) throw new Error(`the package lacks ${expected}: ${paths.join(', ')}`);
  }
});

const total = Date.now() - started;
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const report = [
  `## Adoption check: ${seconds(total)} from \`npm create zubra\` to a packed library (budget ${budget / 60_000} min)`,
  '',
  '| Step | Time |',
  '|---|---|',
  ...steps.map(({ name, ms }) => `| ${name} | ${seconds(ms)} |`),
  '',
  'Dependency installation is not timed (the toolchain is installed once, in examples/frameworks).',
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
rmSync(app, { recursive: true, force: true });
if (total > budget) {
  console.error(`adoption check: ${seconds(total)} is over the budget`);
  process.exitCode = 1;
}
