// Writes index.json, the registry's catalogue, from the components' own description comments:
//   node registry/build-index.mjs [--check]
// With --check it fails if index.json is out of date (CI runs that).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CATEGORIES = {
  input: ['tag-input', 'date-range', 'money-input', 'star-rating', 'toggle-switch', 'choice-cards', 'color-swatches', 'quantity-stepper', 'segmented-control'],
  display: ['donut-chart', 'spark-line', 'line-chart', 'progress-ring', 'streak-grid', 'flip-card', 'step-indicator'],
  app: ['kanban-column', 'chat-message', 'message-composer', 'modal-dialog'],
};

export function catalogue() {
  const files = readdirSync(join(here, 'components')).filter((file) => file.endsWith('.mnx')).sort();
  const components = files.map((file) => {
    const name = file.replace(/\.mnx$/, '');
    const source = readFileSync(join(here, 'components', file), 'utf8');
    const comment = source.match(/^<!--([\s\S]*?)-->/)?.[1] ?? '';
    const description = comment.split(/\n\s*@/)[0].split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
    const category = Object.keys(CATEGORIES).find((key) => CATEGORIES[key].includes(name));
    if (!category) throw new Error(`registry: ${name} has no category in build-index.mjs`);
    if (!description) throw new Error(`registry: ${name} has no description comment`);
    const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
    const dependencies = [...script.matchAll(/import\s+['"]\.\/([a-z0-9-]+)\.mnx['"]/g)].map((match) => match[1]);
    return { name, category, description, files: [file], dependencies };
  });
  return { components };
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
