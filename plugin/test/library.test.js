// Library mode (`zubra build --lib`): the registry's components, built into a package and used the
// way a consumer would, with no zubra tooling: from a React app and a Vue app (Vite with only the
// framework's own plugin), from a plain page, and from TypeScript.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
// Inside plugin/, so the apps resolve the plugin's React, Vue and @zubra/runtime.
const work = join(here, '.tmp-lib');
const lib = join(work, 'node_modules/@demo/ui');

let browser;
const servers = [];
before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  process.env.ZUBRA_COMPILER ??= join(repo, 'target/debug/zubra');
  rmSync(work, { recursive: true, force: true });
  const { buildLibrary } = await import('../../compiler/library.js');
  const { standalone } = await import('../../registry/build-index.mjs');
  // The registry without combo-box (it imports Zag, which these apps don't install).
  buildLibrary(standalone(join(work, 'components')), { out: lib, name: '@demo/ui', version: '1.2.3' });
  // And all of it, for the peer dependencies a component's own imports add.
  buildLibrary(join(repo, 'registry/components'), { out: join(work, 'full'), name: '@demo/full', version: '1.2.3' });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.close();
  rmSync(work, { recursive: true, force: true });
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
async function serve(routes) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    for (const [prefix, dir] of routes) {
      if (!path.startsWith(prefix)) continue;
      let file = join(dir, path.slice(prefix.length));
      if (!extname(file)) file = join(file, 'index.html');
      if (existsSync(file)) return response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain' }).end(readFileSync(file));
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function app(name, files, plugins) {
  const root = join(work, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  // (dedupe: @zubra/runtime is linked from this repository, which has its own React and Vue.)
  await build({ root, configFile: false, logLevel: 'silent', plugins, resolve: { dedupe: ['react', 'react-dom', 'vue'] }, build: { outDir: join(root, 'dist') } });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`${await serve([['/', join(root, 'dist')]])}/`);
  return { page, errors };
}

test('the package: an element module per component, React and Vue entries, typings, the manifest and exports', () => {
  const pkg = JSON.parse(readFileSync(join(lib, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@demo/ui');
  assert.equal(pkg.version, '1.2.3');
  assert.equal(pkg.customElements, './custom-elements.json');
  // The runtime this compiler's version targets (`^<major>.<minor>.0`).
  const [major, minor] = JSON.parse(readFileSync(new URL('../../compiler/package.json', import.meta.url), 'utf8')).version.split('.');
  assert.equal(pkg.peerDependencies['@zubra/runtime'], `^${major}.${minor}.0`);
  assert.deepEqual(Object.keys(pkg.peerDependencies), ['@zubra/runtime', 'react', 'vue']);
  // A component that imports npm packages makes them the package's peers.
  const full = JSON.parse(readFileSync(join(work, 'full/package.json'), 'utf8'));
  assert.deepEqual(Object.keys(full.peerDependencies), ['@zubra/runtime', '@zag-js/combobox', '@zag-js/vanilla', 'react', 'vue']);
  for (const target of Object.values(pkg.exports).flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.values(entry)))) {
    assert.ok(existsSync(join(lib, target)), `${target} exists`);
  }
  assert.ok(pkg.exports['./react/tag-input'] && pkg.exports['./vue/modal-dialog']);
  const manifest = JSON.parse(readFileSync(join(lib, 'custom-elements.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, '2.1.0');
  const tags = manifest.modules.flatMap((module) => module.declarations.map((declaration) => declaration.tagName));
  assert.equal(tags.length, 25);
  for (const module of manifest.modules) assert.ok(existsSync(join(lib, module.path)), module.path);
  assert.match(readFileSync(join(lib, 'index.js'), 'utf8'), /export \{ default as QuantityStepper \} from "\.\/quantity-stepper\.js";/);
  // React's entries are client components, importable from React Server Components (Next.js).
  assert.match(readFileSync(join(lib, 'react/index.js'), 'utf8'), /^'use client';\n/);
  assert.match(readFileSync(join(lib, 'react/quantity-stepper.js'), 'utf8'), /^'use client';\n/);
  assert.doesNotMatch(readFileSync(join(lib, 'vue/index.js'), 'utf8'), /use client/);
  // The modules need no bundler: no .zb imports, only @zubra/runtime and each other.
  const code = readFileSync(join(lib, 'quantity-stepper.js'), 'utf8');
  assert.doesNotMatch(code, /\.zb['"]/);
  assert.match(code, /export \{ \$element as QuantityStepper \};/);
});

test('a React app uses the package with only React\'s plugin: typed components, controlled values', async () => {
  const { page, errors } = await app('react', {
    'index.html': '<div id="root"></div><script type="module" src="/main.jsx"></script>',
    'main.jsx': `
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { QuantityStepper, ToggleSwitch } from '@demo/ui/react';
      function App() {
        const [guests, setGuests] = useState(2);
        const [alerts, setAlerts] = useState(false);
        return <>
          <QuantityStepper value={guests} onValueChange={(event) => setGuests(event.detail)} label="Guests" />
          <ToggleSwitch checked={alerts} onCheckedChange={(event) => setAlerts(event.detail)} label="Alerts" />
          <p id="seen">{guests} {String(alerts)}</p>
        </>;
      }
      createRoot(document.getElementById('root')).render(<App />);
    `,
  }, [react()]);
  await page.waitForSelector('quantity-stepper button.more');
  await page.click('quantity-stepper button.more');
  await page.click('toggle-switch button');
  await page.waitForFunction(() => document.querySelector('#seen').textContent === '3 true');
  assert.equal(await page.textContent('quantity-stepper output'), '3');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a Vue app uses the package with only Vue\'s plugin: v-model on the two-way props', async () => {
  const { page, errors } = await app('vue', {
    'index.html': '<div id="root"></div><script type="module" src="/main.js"></script>',
    'main.js': `
      import { createApp } from 'vue';
      import App from './App.vue';
      createApp(App).mount('#root');
    `,
    'App.vue': `
      <script setup>
      import { ref } from 'vue';
      import { QuantityStepper, SegmentedControl } from '@demo/ui/vue';
      const guests = ref(2);
      const period = ref('w');
      const options = [{ value: 'w', label: 'Week' }, { value: 'm', label: 'Month' }];
      </script>
      <template>
        <QuantityStepper v-model="guests" label="Guests" />
        <SegmentedControl v-model="period" :options="options" label="Period" />
        <p id="seen">{{ guests }} {{ period }}</p>
      </template>
    `,
  }, [vue()]);
  await page.waitForSelector('quantity-stepper button.more');
  await page.click('quantity-stepper button.less');
  await page.click('segmented-control [data-value=m]');
  await page.waitForFunction(() => document.querySelector('#seen').textContent === '1 m');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a plain page imports the elements with an import map, no build step', async () => {
  const runtime = join(repo, 'runtime/src');
  const pages = join(work, 'plain');
  mkdirSync(pages, { recursive: true });
  writeFileSync(join(pages, 'index.html'), `<!doctype html>
<script type="importmap">{ "imports": { "@zubra/runtime": "/runtime/index.js", "@zubra/runtime/spread": "/runtime/spread.js", "@zubra/runtime/primitives": "/runtime/primitives.js", "@demo/ui": "/ui/index.js" } }</script>
<star-rating label="Stars" value="3"></star-rating>
<script type="module">import '@demo/ui'; await customElements.whenDefined('star-rating'); window.ready = true;</script>`);
  const url = await serve([['/runtime/', runtime], ['/ui/', lib], ['/', pages]]);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForFunction(() => window.ready === true);
  assert.equal(await page.getByRole('button', { name: '3 of 5' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  await page.close();
});

test('TypeScript checks a consumer against the typings: React props and events, Vue, and the elements', () => {
  const root = join(work, 'types');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'good.tsx'), `
    import { QuantityStepper, TagInput } from '@demo/ui/react';
    import { ModalDialog } from '@demo/ui/vue';
    import { StarRating } from '@demo/ui';
    export const a = <QuantityStepper value={2} max={5} onValueChange={(event) => event.detail.toFixed()} />;
    export const b = <TagInput value={['x']} onValueChange={(event) => event.detail.join()} />;
    export const c: typeof ModalDialog = ModalDialog;
    const rating = document.querySelector('star-rating');
    export const d: number | undefined = rating?.value;
    export const e: typeof StarRating = customElements.get('star-rating') as typeof StarRating;
  `);
  writeFileSync(join(root, 'bad.tsx'), `
    import { QuantityStepper } from '@demo/ui/react';
    export const a = <QuantityStepper value="2" />;
    export const b = <QuantityStepper nope />;
  `);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', target: 'es2022',
      lib: ['es2022', 'dom'], skipLibCheck: false, types: [],
    },
    files: ['good.tsx', 'bad.tsx'],
  }));
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { encoding: 'utf8', cwd: root });
  const output = (result.stdout + result.stderr).trim();
  const lines = output.split('\n').filter((line) => /error TS/.test(line));
  assert.ok(lines.every((line) => line.startsWith('bad.tsx')), output);
  assert.match(output, /bad\.tsx\(3,[^]*Type 'string' is not assignable to type 'number'/);
  assert.match(output, /bad\.tsx\(4,[^]*Property 'nope' does not exist/);
});
