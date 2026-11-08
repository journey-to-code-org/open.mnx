// The skill, used: an agent given only `skills/zubra-component/SKILL.md` and a task writes a
// component that compiles, renders on the server and works in a browser. Runs only when
// ZUBRA_AGENT names a command that reads a prompt on stdin and writes its answer on stdout
// (`ZUBRA_AGENT="claude -p"`); skipped otherwise, and non-blocking in CI (plan/roadmap-4.0.md,
// decision 4) until it has been stable for three releases.
// `ZUBRA_AGENT="claude -p" node --test skills/test/agent.test.js` (needs `cargo build`, Playwright's Chromium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const agent = process.env.ZUBRA_AGENT;

const TASK = `You are given one document, the zubra-component skill, between the markers below. Using it and
nothing else, write a file \`price-tag.zb\`: a component <price-tag> that shows a price given in cents
(a \`cents\` number prop, default 0) formatted with two decimals and a dollar sign, a \`currency\`
string prop that defaults to "$", and a button labelled "Add" that fires an \`add\` event whose detail
is the cents value. The price must appear in the server-rendered HTML. Answer with the file's
contents only, inside one \`\`\`html code block, with no explanation.

===== SKILL =====
${readFileSync(join(repo, 'skills/zubra-component/SKILL.md'), 'utf8')}
===== END =====`;

test('an agent writes a working component from the skill alone', { skip: !agent && 'ZUBRA_AGENT not set' }, async () => {
  const [command, ...args] = agent.split(' ');
  const run = spawnSync(command, args, { input: TASK, encoding: 'utf8', timeout: 300_000 });
  assert.equal(run.status, 0, run.stderr);
  const source = run.stdout.match(/```html\n([\s\S]*?)```/)?.[1];
  assert.ok(source, `a code block in:\n${run.stdout}`);

  const dir = mkdtempSync(join(tmpdir(), 'zb-agent-'));
  const file = join(dir, 'price-tag.zb');
  writeFileSync(file, source);
  const zubra = join(repo, 'target/release/zubra');
  execFileSync(zubra, ['check', '--server', file], { encoding: 'utf8' });
  writeFileSync(join(dir, 'props.json'), '{"cents":129900}');
  const html = execFileSync(zubra, ['compile', file, '--props', join(dir, 'props.json')], { encoding: 'utf8' });
  assert.match(html, /\$1,?299\.00/, 'the server HTML has the formatted price');

  const site = mkdtempSync(join(tmpdir(), 'zb-agent-site-'));
  writeFileSync(join(site, 'price-tag.js'), execFileSync(zubra, ['compile', file, '--emit', 'js'], { encoding: 'utf8' }));
  const { chromium } = await import(join(repo, 'runtime/node_modules/playwright/index.mjs'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const runtime = join(repo, 'runtime/src');
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname === '/' ? null : url.pathname.startsWith('/runtime/') ? join(runtime, url.pathname.slice('/runtime/'.length)) : join(site, url.pathname);
      if (!path) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><script type="importmap">{"imports":{"@zubra/runtime":"/runtime/index.js"}}</script><price-tag cents="250"></price-tag><script type="module">await import('/price-tag.js'); document.querySelector('price-tag').addEventListener('add', (e) => { window.added = e.detail }); window.ready = true;</script>` });
      route.fulfill({ contentType: 'text/javascript', body: readFileSync(path, 'utf8') });
    });
    await page.goto('http://zubra.test/');
    await page.waitForFunction(() => window.ready === true);
    assert.match(await page.textContent('price-tag'), /\$2\.50/);
    await page.click('price-tag button');
    assert.equal(await page.evaluate(() => window.added), 250, 'the add event carried the cents');
  } finally {
    await browser.close();
  }
});
