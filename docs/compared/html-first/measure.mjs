// Measures the README's copy button in Zubra, WebUI, FAST, Enhance and WebC, for
// docs/compared-with-html-first.md:
//
//   1. what the browser is sent for one component: the JavaScript (bundled and minified with esbuild,
//      then gzip level 9) and the server's HTML for a page with ten of it (gzip level 9);
//   2. the JavaScript for ten components: the first with its runtime, plus nine more components' own
//      code (bundled with the runtime left out), each compressed on its own. Ten renamed copies of one
//      button would otherwise compress into each other and say nothing about a real tenth component;
//   3. how long each server takes to render that page, in this Node.js process.
//
//   npm install && node measure.mjs [--renders 2000] [--json results.json]
//
// Every tool runs at the version pinned in package.json; each component is in components/<tool>/.
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const RENDERS = Number(option('--renders', 2000));
const WARMUP = Math.max(50, Math.round(RENDERS / 10));
const COUNT = 10;
const work = mkdtempSync(join(tmpdir(), 'zubra-compared-'));
const versions = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).devDependencies;

const gz = (text) => gzipSync(Buffer.from(text), { level: 9 }).length;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const buttons = Array.from({ length: COUNT }, (_, i) => ({ text: `npm create zubra --template ${i}`, label: 'Copy' }));

/** Bundles and minifies one entry, the way an app would ship it: esm, browser, production. */
async function bundle(entry, { contents, resolveDir = here, conditions = [], external = [] } = {}) {
  const result = await build({
    ...(contents === undefined ? { entryPoints: [entry] } : { stdin: { contents, resolveDir, sourcefile: entry, loader: entry.endsWith('.ts') ? 'ts' : 'js' } }),
    bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
    conditions, external, tsconfig: join(here, 'tsconfig.json'), nodePaths: [join(here, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return result.outputFiles[0].text;
}


// ---------------------------------------------------------------------------------------------- Zubra
const zubraCompiler = await import('@zubra/compiler');
const zubraSource = readFileSync(join(here, 'components/zubra/copy-button.zb'), 'utf8');
function zubra(emit, source = zubraSource, extra = {}) {
  const path = join(here, 'components/zubra/copy-button.zb');
  const response = zubraCompiler.request({ path, files: { [path]: source }, emit, ...extra });
  if (!response.ok) throw new Error(response.error);
  return response.output;
}
const zubraCss = zubra('css');
function zubraPage() {
  const parts = buttons.map((props) => zubra('html', zubraSource, { props, partial: true }));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Copy buttons</title><style>${zubraCss}</style></head><body>${parts.join('')}<script type="module" src="/copy-button.js"></script></body></html>`;
}

const zubraElement = await bundle('copy-button.js', { contents: zubra('element') });
const zubraModule = await bundle('copy-button.js', { contents: zubra('js', zubraSource, { runtime: '@zubra/runtime' }), conditions: ['production'] });
const zubraModuleOwn = await bundle('copy-button.js', { contents: zubra('js', zubraSource, { runtime: '@zubra/runtime' }), external: ['@zubra/runtime', '@zubra/runtime/*'] });

// ---------------------------------------------------------------------------------------------- WebUI
const webui = await import('@microsoft/webui');
const webuiApp = join(here, 'components/webui');
const webuiBuilt = webui.build({ appDir: webuiApp, css: 'style', dom: 'light', plugin: 'webui' });
const webuiProtocol = new webui.Protocol(webuiBuilt.protocol, { plugin: 'webui' });
const webuiPage = () => webuiProtocol.render({ buttons }).toString('utf8');
const webuiScript = await bundle(join(webuiApp, 'index.ts'));
const webuiOwn = await bundle(join(webuiApp, 'copy-button/copy-button.ts'), { external: ['@microsoft/webui-framework', '@microsoft/webui-framework/*'] });

// ----------------------------------------------------------------------------------------------- FAST
// Client-rendered here: FAST 3's own server rendering is through its declarative templates and WebUI.
const fastScript = await bundle(join(here, 'components/fast/copy-button.ts'));
const fastOwn = await bundle(join(here, 'components/fast/copy-button.ts'), { external: ['@microsoft/fast-element', '@microsoft/fast-element/*'] });
const fastPage = () => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Copy buttons</title></head><body>${buttons.map(({ text, label }) => `<copy-button text="${text}" label="${label}"></copy-button>`).join('')}<script type="module" src="/copy-button.js"></script></body></html>`;

// -------------------------------------------------------------------------------------------- Enhance
const { default: enhance } = await import('@enhance/ssr');
const { default: CopyButtonElement } = await import('./components/enhance/copy-button-element.mjs');
function enhancePage() {
  const html = enhance({ elements: { 'copy-button': CopyButtonElement } });
  return html`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Copy buttons</title></head><body>${buttons.map(({ text, label }) => `<copy-button text="${text}" label="${label}"></copy-button>`).join('')}<script type="module" src="/copy-button.js"></script></body></html>`;
}
const enhanceScript = await bundle(join(here, 'components/enhance/browser.mjs'));
const enhanceOwn = await bundle(join(here, 'components/enhance/browser.mjs'), { external: ['@enhance/custom-element'] });

// ----------------------------------------------------------------------------------------------- WebC
const { WebC } = await import('@11ty/webc');
const webcComponent = join(here, 'components/webc/copy-button.webc');
const webcMarkup = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Copy buttons</title></head><body>${buttons.map(({ text, label }) => `<copy-button text="${text}" label="${label}"></copy-button>`).join('')}<script type="module" src="/copy-button.js" webc:keep></script></body></html>`;
async function webcCompile(markup = webcMarkup, components = { 'copy-button': webcComponent }) {
  const page = new WebC();
  page.setBundlerMode(true);
  page.setContent(markup);
  page.defineComponents(components);
  return page.compile({ data: { page: { url: '/' } } });
}
const webcOne = await webcCompile();
// WebC's bundler mode returns the CSS apart from the HTML; it goes in the head, as Eleventy puts it.
const webcPage = () => webcOne.html.replace('</head>', `<style>${webcOne.css.join('')}</style></head>`);
const webcScript = await bundle('copy-button.js', { contents: webcOne.js.join('\n') });
// -------------------------------------------------------------------------------------------- Results
async function timed(render) {
  for (let i = 0; i < WARMUP; i++) await render();
  const start = performance.now();
  for (let i = 0; i < RENDERS; i++) await render();
  return ((performance.now() - start) * 1000) / RENDERS;
}

const tools = [
  { name: `Zubra \`--emit element\` (${versions['@zubra/compiler']})`, script: zubraElement, own: zubraElement, page: zubraPage, render: zubraPage, renderName: `Zubra (${versions['@zubra/compiler']})`, how: 'The Rust compiler as WebAssembly, in process (`@zubra/compiler`); one request per component, parsing reused' },
  { name: 'Zubra `--emit js` + `@zubra/runtime` (production)', script: zubraModule, own: zubraModuleOwn, page: zubraPage },
  { name: `WebUI (${versions['@microsoft/webui']})`, script: webuiScript, own: webuiOwn, page: webuiPage, render: webuiPage, how: 'A native Rust addon, in process; templates compiled to its protocol once, at build time' },
  { name: `FAST Element (${versions['@microsoft/fast-element']})`, script: fastScript, own: fastOwn, page: fastPage },
  { name: `Enhance (\`@enhance/ssr\` ${versions['@enhance/ssr']}, \`@enhance/custom-element\` ${versions['@enhance/custom-element']})`, script: enhanceScript, own: enhanceOwn, page: enhancePage, render: enhancePage, how: 'JavaScript' },
  { name: `WebC (${versions['@11ty/webc']})`, script: webcScript, own: webcScript, page: webcPage, render: () => webcCompile(), how: 'JavaScript; a build-time tool, so the whole page is compiled each time' },
];

const results = [];
for (const tool of tools) {
  const page = await tool.page();
  results.push({
    name: tool.name,
    renderName: tool.renderName ?? tool.name,
    script: gz(tool.script),
    own: gz(tool.own),
    scriptTen: gz(tool.script) + (COUNT - 1) * gz(tool.own),
    html: gz(page),
    renderMicroseconds: tool.render ? await timed(tool.render) : null,
    how: tool.how ?? null,
  });
}

console.log(`Measured with Node.js ${process.version} on ${process.platform}-${process.arch}; ${RENDERS} renders after ${WARMUP} to warm up.\n`);
console.log('| | JS, one component | Each more component | JS, ten components | HTML, page of ten buttons |');
console.log('|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${kb(r.script)} | ${kb(r.own)} | ${kb(r.scriptTen)} | ${kb(r.html)} |`);
console.log('\n| Server | Render of the page of ten buttons | How it runs |');
console.log('|---|---|---|');
for (const r of results.filter((r) => r.renderMicroseconds !== null)) console.log(`| ${r.renderName} | ${r.renderMicroseconds.toFixed(0)} µs | ${r.how} |`);
if (args.includes('--json')) writeFileSync(option('--json'), `${JSON.stringify({ node: process.version, renders: RENDERS, results }, null, 2)}\n`);
if (args.includes('--pages')) {
  const out = option('--pages');
  mkdirSync(out, { recursive: true });
  const names = ['zubra-element', 'zubra-js', 'webui', 'fast', 'enhance', 'webc'];
  for (const [i, tool] of tools.entries()) {
    writeFileSync(join(out, `${names[i]}.html`), (await tool.page()).replace(/src="\/copy-button\.js"|src="\/index\.js"/, `src="./${names[i]}.js"`));
    writeFileSync(join(out, `${names[i]}.js`), tool.script);
  }
}
rmSync(work, { recursive: true, force: true });
