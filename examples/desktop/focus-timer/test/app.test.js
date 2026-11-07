// The app in Electron (through Playwright), with a fake clock so 25 minutes take no time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = mkdtempSync(join(tmpdir(), 'focus-'));
let app, window;
const errors = [];

async function launch() {
  app = await electron.launch({ args: [root, ...(process.env.CI ? ['--no-sandbox'] : [])], env: { ...process.env, FOCUS_DATA: data } });
  window = await app.firstWindow();
  window.on('pageerror', (error) => errors.push(error.message));
  window.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  await window.clock.install();
  await window.reload();
  await window.waitForSelector('body[data-ready]');
}
before(launch);
after(async () => {
  await app?.close();
  rmSync(data, { recursive: true, force: true });
});

// The window's title, which the main process sets (over IPC, so wait for it).
async function title(expected) {
  const read = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  for (let tries = 0; tries < 40 && (await read()) !== expected; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
  return read();
}
const time = async () => (await window.textContent('focus-timer time')).trim();

test('the renderer is sandboxed: no Node.js, only the preload\'s API, under a strict CSP with no violations', async () => {
  assert.equal(await window.evaluate(() => typeof require), 'undefined');
  assert.equal(await window.evaluate(() => typeof process), 'undefined');
  assert.deepEqual(await window.evaluate(() => Object.keys(window.focusTimer).sort()), ['finished', 'load', 'running']);
  assert.match(await window.getAttribute('meta[http-equiv=Content-Security-Policy]', 'content'), /style-src 'self'/);
  assert.equal(await time(), '25:00');
  // The components' own CSS applies anyway: mnx adopts it as constructed stylesheets, which a
  // CSP's style-src doesn't block (it only blocks inline <style> and style="").
  assert.equal(await window.evaluate(() => getComputedStyle(document.querySelector('focus-timer button.primary')).color), 'rgb(255, 255, 255)');
  assert.equal(await window.evaluate(() => getComputedStyle(document.querySelector('focus-timer time')).fontWeight), '700');
  assert.deepEqual(errors, []);
});

test('a focus session: start, pause, run out; it\'s logged, saved by the main process, and a break comes next', async () => {
  await window.fill('#task', 'Write the README');
  assert.equal((await window.textContent('#what')).trim(), 'Write the README');
  await window.getByRole('button', { name: 'Start' }).click();
  assert.equal(await title('Focus (running)'), 'Focus (running)');
  await window.clock.runFor('10:00');
  assert.equal(await time(), '15:00');
  await window.getByRole('button', { name: 'Pause' }).click();
  await window.clock.runFor('05:00');
  assert.equal(await time(), '15:00', 'paused, it stays');
  await window.keyboard.press('Space');
  await window.clock.runFor('15:01');
  await window.waitForFunction(() => document.querySelector('session-log h2').textContent.trim() === 'Today: 1 session, 25 min');
  assert.equal(await title('Focus'), 'Focus');
  assert.deepEqual(await window.locator('session-log li span').allTextContents(), ['Write the README']);
  // The next mode is a short break, with its own length.
  assert.equal(await window.getAttribute('segmented-control [aria-pressed=true]', 'data-value'), 'short');
  assert.equal(await time(), '05:00');
  assert.equal(await window.isDisabled('#task'), true);
  const saved = JSON.parse(readFileSync(join(data, 'focus.json'), 'utf8'));
  assert.equal(saved.sessions.length, 1);
  assert.deepEqual([saved.sessions[0].mode, saved.sessions[0].task, saved.sessions[0].seconds], ['focus', 'Write the README', 1500]);
  assert.equal(await app.evaluate(() => globalThis.notified), 1);
  assert.deepEqual(errors, []);
});

test('switching modes resets the timer, and the log survives a restart', async () => {
  await window.getByRole('button', { name: 'Long break' }).click();
  assert.equal(await time(), '15:00');
  await window.getByRole('button', { name: 'Focus' }).click();
  assert.equal(await time(), '25:00');
  await window.getByRole('button', { name: 'Start' }).click();
  await window.clock.runFor('01:00');
  await window.getByRole('button', { name: 'Short break' }).click();
  assert.equal(await time(), '05:00');
  assert.equal(await window.getByRole('button', { name: 'Start' }).count(), 1, 'switching stopped it');
  await app.close();
  await launch();
  await window.waitForFunction(() => document.querySelector('session-log h2').textContent.trim() === 'Today: 1 session, 25 min');
  assert.deepEqual(errors, []);
});
