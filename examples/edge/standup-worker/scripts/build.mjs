// What the Worker can't do for itself, done before it starts:
//   - src/actions/: the components' 'use server' functions as plain modules (zubra-actions build);
//   - public/: @zubra/runtime's production build, @zubra/sync's browser modules and the actions
//     script, where the page's import map and script tag point (wrangler.jsonc's `assets`).
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildActions } from '@zubra/actions/build';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public');
const resolve = (specifier) => fileURLToPath(import.meta.resolve(specifier));

// The standup card has no server functions; only the lead picker does. Both folders are built so
// a card that gains one is picked up.
const routes = await buildActions({ components: join(root, 'components'), out: join(root, 'src/actions') });

rmSync(out, { recursive: true, force: true });
const runtime = join(dirname(dirname(resolve('@zubra/runtime'))), 'dist/production');
mkdirSync(join(out, '_zubra/runtime'), { recursive: true });
for (const file of readdirSync(runtime)) if (file.endsWith('.js')) cpSync(join(runtime, file), join(out, '_zubra/runtime', file));
const sync = dirname(resolve('@zubra/sync'));
mkdirSync(join(out, '_zubra/sync'), { recursive: true });
for (const file of ['index.js', 'connect.js', 'webrtc.js']) cpSync(join(sync, file), join(out, '_zubra/sync', file));
mkdirSync(join(out, '_zb'), { recursive: true });
cpSync(resolve('@zubra/actions/client'), join(out, '_zb/actions.js'));
console.log(`src/actions/: ${routes.join(', ')}\npublic/: the runtime, @zubra/sync and the actions script`);
