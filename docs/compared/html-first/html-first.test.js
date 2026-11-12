// The pages measure.mjs measures are working pages: in Chromium, each tool's copy button (third of ten)
// copies its own text, says "Copied!" and turns green, with nothing logged. So every size and render time
// in docs/compared-with-html-first.md is for a component that works, not for markup that only looks right.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const pages = mkdtempSync(join(tmpdir(), 'zubra-compared-pages-'));
let server;
let browser;
let origin;

before(async () => {
  execFileSync(process.execPath, ['measure.mjs', '--renders', '20', '--pages', pages], { cwd: here, stdio: 'inherit' });
  server = createServer((request, response) => {
    try {
      const file = join(pages, new URL(request.url, 'http://x').pathname);
      response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  rmSync(pages, { recursive: true, force: true });
});

for (const name of ['zubra-element', 'zubra-js', 'webui', 'fast', 'enhance', 'webc']) {
  test(`${name}: the third button copies its text and says so`, async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (message) => message.type() === 'error' || message.type() === 'warning' ? problems.push(message.text()) : null);
    page.on('pageerror', (error) => problems.push(error.message));
    await page.goto(`${origin}/${name}.html`);
    await page.waitForFunction(() => customElements.get('copy-button') !== undefined);
    // FAST renders in the browser and WebUI hydrates after its runtime starts: wait for a button.
    const button = page.locator('copy-button').nth(2).locator('button');
    await button.waitFor();
    await assert.doesNotReject(button.click());
    await page.waitForFunction(() => {
      const host = document.querySelectorAll('copy-button')[2];
      // FAST renders into a shadow root; the others into the host's own children.
      return (host.shadowRoot ?? host).querySelector('button')?.textContent.trim() === 'Copied!';
    }, null, { timeout: 3000 })
      .catch(async () => {
        const html = await page.locator('copy-button').nth(2).evaluate((element) => element.outerHTML);
        throw new Error(`no "Copied!" after the click: ${html}`);
      });
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'npm create zubra --template 2');
    const color = await button.evaluate((element) => getComputedStyle(element).color);
    assert.equal(color, 'rgb(0, 128, 0)', 'the copied state is styled');
    assert.deepEqual(problems, []);
    await context.close();
  });
}

// The page says WebUI's templates take paths and comparisons, not expressions, and that what they
// can't evaluate renders as nothing, without a warning; and that Zubra's server evaluates the same
// JavaScript expressions without a JavaScript engine. Checked here, so the page is wrong the day it is.
test('what each server evaluates: an addition, a ternary, a condition and a length', async () => {
  const state = { count: 2, done: true, items: [1, 2, 3] };

  const webui = await import('@microsoft/webui');
  const app = join(pages, 'probe');
  mkdirSync(join(app, 'x-probe'), { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!DOCTYPE html><html><body><x-probe></x-probe></body></html>');
  writeFileSync(join(app, 'x-probe/x-probe.html'), '<template><p>{{count + 1}}</p><p>{{done ? "yes" : "no"}}</p><if condition="count > 1 && done"><p>both</p></if><p>{{items.length}}</p></template>');
  const built = webui.build({ appDir: app, dom: 'light', plugin: 'webui' });
  assert.deepEqual(built.warnings, [], 'WebUI says nothing about the expressions it drops');
  const html = new webui.Protocol(built.protocol, { plugin: 'webui' }).render(state).toString('utf8');
  assert.deepEqual([...html.replaceAll(/<!--.*?-->/g, '').matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1]), ['', '', 'both', '3']);

  const zubra = await import('@zubra/compiler');
  const path = join(pages, 'x-probe.zb');
  const source = '<x-probe count={0} done={false} items={[]}><p>{count + 1}</p><p>{done ? "yes" : "no"}</p><p zb-if={count > 1 && done}>both</p><p>{items.length}</p></x-probe>';
  const response = zubra.request({ path, files: { [path]: source }, emit: 'html', props: state });
  assert.ok(response.ok, response.error);
  assert.deepEqual([...response.output.matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1]), ['3', 'yes', 'both', '3']);
});
