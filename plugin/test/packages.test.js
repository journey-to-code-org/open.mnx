// Components from a package, through Vite: an app's component imports
// `@acme/kit/components/cart-panel.zb` from node_modules (exported by the package), Vite resolves
// it, and the plugin compiles it with its own relative child.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import zubra from '../src/vite.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const { chromium } = createRequire(import.meta.url)('playwright');
// Inside plugin/, so the app resolves the plugin's @zubra/runtime.
const work = join(here, '.tmp-packages');

let browser;
let server;
before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  process.env.ZUBRA_COMPILER ??= join(repo, 'target/debug/zubra');
  rmSync(work, { recursive: true, force: true });
  const files = {
    'node_modules/@acme/kit/package.json': JSON.stringify({ name: '@acme/kit', exports: { './components/*': './components/*' } }),
    'node_modules/@acme/kit/components/kit-count.zb': '<kit-count count:model={1}>\n  <output>{count}</output>\n  <button type="button" onclick={() => (count = count + 1)}>+</button>\n</kit-count>\n',
    'node_modules/@acme/kit/components/cart-panel.zb': "<script>\n  import './kit-count.zb'\n</script>\n<cart-panel title=\"Cart\">\n  <h2>{title}</h2>\n  <kit-count count={2}></kit-count>\n</cart-panel>\n",
    'app/shop-page.zb': "<script>\n  import '@acme/kit/components/cart-panel.zb'\n</script>\n<shop-page>\n  <cart-panel title=\"Your cart\"></cart-panel>\n</shop-page>\n",
    'app/main.js': "import './shop-page.zb';\n",
    'app/index.html': '<!doctype html><html><body><shop-page></shop-page><script type="module" src="./main.js"></script></body></html>\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  await build({ root: join(work, 'app'), configFile: false, logLevel: 'silent', plugins: [zubra()], build: { outDir: join(work, 'app/dist') } });
  const dist = join(work, 'app/dist');
  server = createServer((request, response) => {
    let file = join(dist, new URL(request.url, 'http://x').pathname);
    if (!extname(file)) file = join(file, 'index.html');
    if (!existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'text/plain' }).end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  rmSync(work, { recursive: true, force: true });
});

test("a Vite build compiles a package's components, and they run", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('cart-panel h2:has-text("Your cart")');
  await page.click('kit-count button');
  await page.waitForSelector('kit-count output:has-text("3")');
  assert.deepEqual(errors, []);
  await page.close();
});
