// The built site in Chromium: with JavaScript off (the build's HTML alone) and on, and built
// again with an HTML minifier, configured to keep zubra's markers and not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const builds = { plain: '_site', min: '_site-min', naive: '_site-naive' };
let browser;
const servers = {};

before(async () => {
  const eleventy = join(root, 'node_modules/.bin/eleventy');
  execFileSync(eleventy, ['--quiet'], { cwd: root, env: { ...process.env, MINIFY: '1', OUT: builds.min } });
  execFileSync(eleventy, ['--quiet'], { cwd: root, env: { ...process.env, MINIFY: 'naive', OUT: builds.naive } });
  for (const [name, dir] of Object.entries(builds)) {
    const server = createServer((request, response) => {
      let file = join(root, dir, decodeURIComponent(new URL(request.url, 'http://x').pathname));
      if (!extname(file)) file = join(file, 'index.html');
      if (!existsSync(file)) return response.writeHead(404).end();
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain' }).end(readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers[name] = { server, url: `http://127.0.0.1:${server.address().port}` };
  }
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const { server } of Object.values(servers)) server.close();
  for (const dir of [builds.min, builds.naive]) rmSync(join(root, dir), { recursive: true, force: true });
});

async function open(build, path, { javascript = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: javascript });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  await page.goto(servers[build].url + path);
  if (javascript) await page.waitForFunction(() => customElements.get('trail-card') && customElements.get('trail-filter'));
  page.errors = errors;
  page.done = () => context.close();
  return page;
}
const texts = (page, selector) => page.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));

test('without JavaScript: every trail, its length and climb, and the profile, from the build\'s HTML', async () => {
  const page = await open('plain', '/', { javascript: false });
  assert.equal(await page.locator('trail-card').count(), 8);
  assert.equal((await texts(page, 'trail-card h3'))[0], 'Laurel Run Loop');
  assert.deepEqual((await texts(page, 'trail-card .length')).slice(0, 2), ['4.2 km', '7.8 km']);
  assert.equal(await page.locator('trail-filter fieldset').count(), 0, 'the filter needs JavaScript, so it isn\'t there');
  await page.click('text=Spruce Knob Summit');
  assert.equal(await page.getAttribute('elevation-profile svg', 'aria-label'), 'Elevation along Spruce Knob Summit: 1180 to 1482 m');
  assert.match(await page.getAttribute('elevation-profile polyline', 'points'), /^0,38 /);
  await page.done();
});

test('with JavaScript: the elements hydrate the build\'s markup; the filter and the units work', async () => {
  const page = await open('plain', '/');
  await page.getByLabel('hard').uncheck();
  assert.deepEqual(await texts(page, '.trails > li:not([hidden]) trail-card h3'), ['Laurel Run Loop', 'Spruce Knob Summit', 'Seneca Rocks Trail', 'Blackwater Canyon Rim', 'Cranberry Glades Boardwalk']);
  await page.getByLabel('Longest').fill('5');
  assert.deepEqual(await texts(page, '.trails > li:not([hidden]) trail-card h3'), ['Laurel Run Loop', 'Seneca Rocks Trail', 'Cranberry Glades Boardwalk']);
  await page.getByLabel('easy').uncheck();
  await page.getByLabel('moderate').uncheck();
  assert.equal(await page.isVisible('.none'), true);
  await page.getByRole('button', { name: 'miles' }).click();
  assert.deepEqual((await texts(page, 'trail-card .length')).slice(0, 2), ['2.6 mi', '4.8 mi']);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('trail-card .length').textContent.trim() === '2.6 mi');
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('minified, keeping the markers (ignoreCustomComments): the elements still hydrate', async () => {
  const html = readFileSync(join(root, builds.min, 'index.html'), 'utf8');
  // Minified: whitespace between tags collapsed (a size ratio drifts as names change length).
  const plain = readFileSync(join(root, builds.plain, 'index.html'), 'utf8');
  assert.ok(html.length < plain.length, 'it is smaller');
  assert.ok(plain.split('\n').length > 50 && html.split('\n').length < 5, 'its line breaks and indentation are gone');
  assert.match(html, /<!--\[-->/);
  const page = await open('min', '/');
  await page.getByRole('button', { name: 'miles' }).click();
  assert.equal((await texts(page, 'trail-card .length'))[0], '2.6 mi');
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('minified naively (every comment removed): the elements put their markers back and hydrate in place (2.10)', async () => {
  const html = readFileSync(join(root, builds.naive, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<!--/);
  const page = await open('naive', '/');
  await page.getByRole('button', { name: 'miles' }).click();
  assert.equal((await texts(page, 'trail-card .length'))[0], '2.6 mi', 'still right');
  assert.deepEqual(page.errors, [], 'no "markers are missing" warnings: nothing rendered fresh');
  await page.done();
});
