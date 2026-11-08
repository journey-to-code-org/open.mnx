// Writes index.json, the registry's catalogue, from the components' own description comments:
//   node registry/build-index.mjs [--check]
// With --check it fails if index.json is out of date (CI runs that).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CATEGORIES = {
  input: ['tag-input', 'date-range', 'money-input', 'star-rating', 'toggle-switch', 'choice-cards', 'color-swatches', 'quantity-stepper', 'segmented-control'],
  display: ['donut-chart', 'spark-line', 'line-chart', 'progress-ring', 'streak-grid', 'flip-card', 'step-indicator'],
  app: ['kanban-column', 'chat-message', 'message-composer', 'modal-dialog'],
  widget: ['accordion-panel', 'tool-tip', 'tab-list', 'dropdown-menu', 'combo-box'],
};

export function catalogue() {
  const files = readdirSync(join(here, 'components')).filter((file) => file.endsWith('.zb')).sort();
  const components = files.map((file) => {
    const name = file.replace(/\.zb$/, '');
    const source = readFileSync(join(here, 'components', file), 'utf8');
    const comment = source.match(/^<!--([\s\S]*?)-->/)?.[1] ?? '';
    const description = comment.split(/\n\s*@/)[0].split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
    const category = Object.keys(CATEGORIES).find((key) => CATEGORIES[key].includes(name));
    if (!category) throw new Error(`registry: ${name} has no category in build-index.mjs`);
    if (!description) throw new Error(`registry: ${name} has no description comment`);
    const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
    const dependencies = [...script.matchAll(/import\s+['"]\.\/([a-z0-9-]+)\.zb['"]/g)].map((match) => match[1]);
    // npm packages it imports, beyond the runtime: `zubra add` says to install them. The Zag adapter
    // needs @zag-js/vanilla, which it imports itself.
    const packages = [...new Set([...script.matchAll(/from\s+['"]((?:@[a-z0-9-]+\/)?[a-z0-9-]+)[^'"]*['"]/g)].map((match) => match[1]).filter((name) => name !== '@zubra/runtime'))];
    if (/from\s+['"]@zubra\/runtime\/zag['"]/.test(script)) packages.unshift('@zag-js/vanilla');
    return { name, category, description, files: [file], dependencies, ...(packages.length ? { packages } : {}) };
  });
  return { components };
}

/**
 * Copies the components that import no npm packages into `into`, for the libraries the tests and
 * examples build from the registry: a plain page, or an app that hasn't installed Zag, can use them
 * all. Returns `into`.
 */
export function standalone(into) {
  mkdirSync(into, { recursive: true });
  for (const component of catalogue().components) {
    if (!component.packages) for (const file of component.files) copyFileSync(join(here, 'components', file), join(into, file));
  }
  return into;
}

const text = JSON.stringify(catalogue(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(join(here, 'index.json'), 'utf8') !== text) {
    console.error('registry/index.json is out of date: run node registry/build-index.mjs');
    process.exitCode = 1;
  }
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(here, 'index.json'), text);
}
