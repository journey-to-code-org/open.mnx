// Builds the app for the browser test; returns the output directory.
import { join } from 'node:path';

export async function buildApp(root) {
  const { build } = await import('vite');
  const outDir = join(root, 'dist');
  await build({ root, configFile: join(root, 'vite.config.js'), configLoader: 'native', logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  return outDir;
}
