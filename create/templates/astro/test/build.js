// Builds the site for the browser test; returns the output directory.
import { join } from 'node:path';

export async function buildApp(root) {
  const { build } = await import('astro');
  const outDir = join(root, 'dist');
  await build({ root, logLevel: 'warn', outDir });
  return outDir;
}
