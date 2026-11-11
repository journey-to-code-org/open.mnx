#!/usr/bin/env node
// zubra-actions build <components> --out <folder>
import { buildActions } from '../src/build.js';

const [command, ...rest] = process.argv.slice(2);
const usage = 'Usage: zubra-actions build <components folder> --out <folder>';
if (command !== 'build') {
  console.error(usage);
  process.exit(command === '--help' || command === '-h' ? 0 : 2);
}
let components = 'components';
let out;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--out' || rest[i] === '-o') out = rest[++i];
  else if (rest[i].startsWith('--out=')) out = rest[i].slice(6);
  else components = rest[i];
}
if (!out) {
  console.error(usage);
  process.exit(2);
}
try {
  const routes = await buildActions({ components, out });
  console.log(`${routes.length} action${routes.length === 1 ? '' : 's'} → ${out}/index.js`);
  for (const route of routes) console.log(`  ${route}`);
} catch (error) {
  console.error(`zubra-actions: ${error.message}`);
  process.exit(1);
}
