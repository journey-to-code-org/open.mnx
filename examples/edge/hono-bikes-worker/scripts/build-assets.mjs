// Puts the files the Worker doesn't serve itself into public/, where wrangler.jsonc's `assets`
// serves them before the Worker runs: htmx, the shop's stylesheet, and @zubra/runtime's production
// build under the path the page's import map points at (/_zubra/runtime/).
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'public');
const resolve = (specifier) => fileURLToPath(import.meta.resolve(specifier));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'vendor'), { recursive: true });
cpSync(join(dirname(resolve('htmx.org/package.json')), 'dist/htmx.min.js'), join(out, 'vendor/htmx.js'));
cpSync(join(root, '../../hypermedia/hono-bikes/public/app.css'), join(out, 'app.css'));

const runtime = join(dirname(dirname(resolve('@zubra/runtime'))), 'dist/production');
mkdirSync(join(out, '_zubra/runtime'), { recursive: true });
for (const file of readdirSync(runtime)) if (file.endsWith('.js')) cpSync(join(runtime, file), join(out, '_zubra/runtime', file));
console.log(`public/: htmx, app.css and ${readdirSync(join(out, '_zubra/runtime')).length} runtime files`);
