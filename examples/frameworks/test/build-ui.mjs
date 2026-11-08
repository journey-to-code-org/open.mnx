// Builds ui/ (the component library the React and Vue apps import) once, before the tests,
// which run in parallel: `npm test` runs this first.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { examples, repo } from './paths.js';

execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
process.env.MNX_COMPILER ??= join(repo, 'target/debug/mnx');
const { buildLibrary } = await import('../../../compiler/library.js');
const { standalone } = await import('../../../registry/build-index.mjs');
// The registry's components without npm dependencies (combo-box needs Zag, which these apps don't use).
const components = standalone(mkdtempSync(join(tmpdir(), 'mnx-ui-')));
buildLibrary(components, { out: join(examples, 'ui/dist'), name: '@mnx-examples/ui', version: '1.0.0' });
rmSync(components, { recursive: true, force: true });
