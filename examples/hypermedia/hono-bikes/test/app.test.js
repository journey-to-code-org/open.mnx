// The shop in Chromium, served by Node.js and by Bun (when it's installed): htmx swaps in
// server-rendered fragments, and the zubra elements in them hydrate where they land.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { shot } from '../../../../demos/shot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bun = spawnSync('bun', ['--version']).status === 0;

function start(runtime) {
  const child = spawn(runtime, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => {
      const port = /localhost:(\d+)/.exec(String(data))?.[1];
      if (port) resolve({ child, url: `http://localhost:${port}`, banner: String(data).trim() });
    });
    child.once('exit', (code) => reject(new Error(`${runtime} server.js exited with ${code}`)));
  });
}

for (const runtime of ['node', 'bun']) {
  describe(`on ${runtime}`, { skip: runtime === 'bun' && !bun && 'Bun is not installed' }, () => {
    let server, browser;
    before(async () => {
      server = await start(runtime);
      browser = await chromium.launch();
    });
    after(async () => {
      await browser?.close();
      server?.child.kill();
    });

    async function open(path = '/', { javascript = true } = {}) {
      await fetch(`${server.url}/reset`, { method: 'POST' });
      const context = await browser.newContext({ javaScriptEnabled: javascript });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => ['error', 'warning'].includes(message.type()) && !/status of 422/.test(message.text()) && errors.push(message.text()));
      await page.goto(server.url + path);
      if (javascript) await page.waitForFunction(() => window.htmx && customElements.get('qty-input'));
      page.text = async (selector) => (await page.textContent(selector)).trim();
      return { page, errors, close: () => context.close() };
    }

    test('the server says which runtime it is', () => {
      assert.match(server.banner, runtime === 'bun' ? /Bun \d/ : /Node\.js \d/);
    });

    test('the first page is complete server HTML: prices, stock, tags', async () => {
      const { page, errors, close } = await open('/', { javascript: false });
      assert.equal(await page.locator('#rows tr[id^=item-]').count(), 10);
      assert.equal(await page.text('#item-1 price-tag'), '$1,299.00');
      assert.equal(await page.text('#item-3 price-tag'), '$1,899.00');
      assert.equal(await page.text('#item-5 stock-gauge small'), 'Out');
      assert.equal(await page.text('#item-3 stock-gauge small'), 'Low');
      assert.deepEqual(await page.locator('#item-1 tag-list li').allTextContents(), ['mtb', '29"']);
      assert.deepEqual(errors, []);
      await close();
    });

    test('without JavaScript: selling, editing and paging are plain forms and links', async () => {
      const { page, close } = await open('/', { javascript: false });
      await page.click('#item-1 button:text("Sell one")');
      assert.equal(await page.text('#item-1 stock-gauge span'), '3');
      await page.click('#item-2 a:text("Edit")');
      await page.fill('input[name=price]', '599.5');
      await page.fill('input[name=count]', '12');
      await page.click('button:text("Save")');
      assert.equal(await page.text('#item-2 price-tag'), '$599.50');
      assert.equal(await page.text('#item-2 stock-gauge span'), '12');
      await page.click('a:text("Load more")');
      assert.equal(await page.locator('#rows tr[id^=item-]').count(), 20);
      await close();
    });

    test('htmx: search swaps in rows whose elements hydrate', async () => {
      const { page, errors, close } = await open();
      await shot(page, 'hono-bikes');
      await page.fill('input[name=q]', 'brakes');
      await page.waitForFunction(() => document.querySelectorAll('#rows tr[id^=item-]').length === 2);
      assert.deepEqual(await page.locator('#rows strong').allTextContents(), ['Brake pads (resin)', 'Rotor 180 mm']);
      assert.equal(await page.text('#item-13 price-tag'), '$44.99');
      await page.selectOption('select[name=category]', 'bikes');
      await page.fill('input[name=q]', '');
      await page.waitForFunction(() => document.querySelectorAll('#rows tr[id^=item-]').length === 7);
      assert.deepEqual(errors, []);
      await close();
    });

    test('htmx: selling swaps the row and the low-stock count out of band', async () => {
      const { page, errors, close } = await open();
      const low = await page.text('#low-count');
      await page.click('#item-6 button:text("Sell one")'); // 3 → 2, still above the reorder point of 1
      await page.waitForFunction(() => document.querySelector('#item-6 stock-gauge span').textContent.trim() === '2');
      await page.click('#item-6 button:text("Sell one")');
      await page.waitForFunction(() => document.querySelector('#item-6 stock-gauge span').textContent.trim() === '1');
      assert.equal(await page.text('#item-6 stock-gauge small'), 'Low');
      assert.notEqual(await page.text('#low-count'), low);
      assert.match(await page.text('#low-count'), /^\d+ low or out$/);
      assert.deepEqual(errors, []);
      await close();
    });

    test('htmx: the edit row\'s stepper is live once swapped in; errors come back in place; saving swaps the row back', async () => {
      const { page, errors, close } = await open();
      await page.click('#item-10 a:text("Edit")');
      // The qty-input arrived in an htmx fragment, and its buttons exist only once it's hydrated.
      const more = page.getByRole('button', { name: 'More: Chain 12-speed in stock' });
      await more.click();
      await more.click();
      assert.equal(await page.inputValue('#item-10 input[name=count]'), '9');
      await page.fill('#item-10 input[name=name]', ' ');
      await page.click('#item-10 button:text("Save")');
      await page.waitForSelector('#item-10 .error');
      assert.equal(await page.text('#item-10 .error'), 'A name, please.');
      // The 422 fragment kept the count, and its new stepper is live too.
      assert.equal(await page.inputValue('#item-10 input[name=count]'), '9');
      await page.getByRole('button', { name: 'Fewer: Chain 12-speed in stock' }).click();
      await page.fill('#item-10 input[name=name]', 'Chain 12-speed (Eagle)');
      await page.click('#item-10 button:text("Save")');
      await page.waitForFunction(() => document.querySelector('#item-10 strong')?.textContent === 'Chain 12-speed (Eagle)');
      assert.equal(await page.text('#item-10 stock-gauge span'), '8');
      assert.deepEqual(errors, []);
      await close();
    });

    test('htmx with the browser\'s own fragment parser: the markers survive it, and swapped elements hydrate in place', async () => {
      const { page, errors, close } = await open('/');
      // htmx parses fragments with Document.parseHTMLUnsafe(), which in this Chromium drops
      // comments (4.x's markers) and keeps processing instructions (5.0's).
      const parsed = await page.evaluate(() => 'parseHTMLUnsafe' in Document
        && [...Document.parseHTMLUnsafe('<p><!--x--><?zb [?></p>').body.firstChild.childNodes].map((node) => node.nodeType).join());
      await page.click('#item-1 button:text("Sell one")');
      await page.waitForFunction(() => document.querySelector('#item-1 stock-gauge span').textContent.trim() === '3');
      assert.equal(await page.text('#item-1 price-tag'), '$1,299.00');
      assert.deepEqual(await page.locator('#item-1 tag-list li').allTextContents(), ['mtb', '29"']);
      if (parsed) assert.equal(parsed, '7', 'the comment is dropped, the processing instruction kept');
      // The swapped-in elements kept their markers (not put back by structure, which uses comments).
      const markers = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector('#item-1'), NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_COMMENT);
        const kinds = new Set();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) kinds.add(node.nodeType);
        return [...kinds];
      });
      if (parsed) assert.deepEqual(markers, [7]);
      assert.deepEqual(errors, []);
      await close();
    });

    test('htmx: "Load more" appends the next page, and removed elements leave nothing behind', async () => {
      const { page, errors, close } = await open();
      await page.click('a:text("Load more")');
      await page.waitForFunction(() => document.querySelectorAll('#rows tr[id^=item-]').length === 20);
      await page.click('a:text("Load more")');
      await page.waitForFunction(() => document.querySelectorAll('#rows tr[id^=item-]').length === 26);
      assert.equal(await page.locator('#more').count(), 0);
      assert.equal(await page.text('#item-26 price-tag'), '$129.99');
      // Swap the whole list out and back a few times: no errors from elements being removed.
      for (const q of ['helmet', 'tube', '']) {
        await page.fill('input[name=q]', q);
        await page.waitForTimeout(400);
      }
      await page.waitForFunction(() => document.querySelectorAll('#rows tr[id^=item-]').length === 10);
      assert.deepEqual(errors, []);
      await close();
    });
  });
}
