// Takes the screenshots in demos/shots/ (the gallery's cards and the examples' READMEs):
//
//   node demos/build.mjs --out _site --base /zubra/ && node demos/screenshots.mjs [--dir _site] [--base /zubra/] [--only id,id]
//
// The static examples are shot from the built gallery. The ones that need a server are shot by
// their own browser tests, when ZUBRA_SHOTS names this folder (each test's first page view):
//
//   ZUBRA_SHOTS=$PWD/demos/shots npm test      # in the example's folder
//
// All are 1280×800, light colour scheme, JPEG at quality 80.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';
import { demos } from './list.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dir = resolve(option('--dir', join(repo, '_site')));
const base = option('--base', '/zubra/');
const only = option('--only', '')?.split(',').filter(Boolean);
const shots = join(here, 'shots');
mkdirSync(shots, { recursive: true });

const { chromium } = createRequire(join(repo, 'examples/frameworks/package.json'))('playwright');
const site = await serve(dir, base);
const browser = await chromium.launch();
for (const demo of demos.filter((demo) => demo.build && (!only?.length || only.includes(demo.id)))) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  await page.goto(`${site.url}demos/${demo.id}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400); // transitions and the first animation frames
  await page.screenshot({ path: join(shots, `${demo.id}.jpg`), type: 'jpeg', quality: 80 });
  console.log(`demos: shots/${demo.id}.jpg`);
  await page.close();
}
await browser.close();
site.close();
