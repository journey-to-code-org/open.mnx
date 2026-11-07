// Builds ui/ (the component library the React and Vue apps import) once, before the tests,
// which run in parallel: `npm test` runs this first.
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { examples, repo } from './paths.js';

execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
process.env.MNX_COMPILER ??= join(repo, 'target/debug/mnx');
const { buildLibrary } = await import('../../../compiler/library.js');
buildLibrary(join(repo, 'registry/components'), { out: join(examples, 'ui/dist'), name: '@mnx-examples/ui', version: '1.0.0' });
