// The log servers the protocol tests run against: @zubra/sync/server in this process, and the
// zubra-sync binary (sync-server/ in this repository) when it's built. Both must pass the same
// tests; that's what makes them interchangeable.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer, allowAnyone } from '../src/server.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const binaryPath = [process.env.ZUBRA_SYNC, join(root, 'target/release/zubra-sync'), join(root, 'target/debug/zubra-sync')]
  .find((path) => path && existsSync(path));

/** Start the binary on a free port with a fresh log; resolves to `{ base, close }`. */
export async function startBinary(extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-sync-'));
  const child = spawn(binaryPath, ['--port', '0', '--db', join(dir, 'sync.db'), ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const match = /listening on (http:\/\/\S+)/.exec(text);
      if (match) resolve(match[1].replace('127.0.0.1', 'localhost'));
    });
    child.on('exit', (code) => reject(new Error(`zubra-sync exited (${code})`)));
  });
  // A failing test mustn't leave the binary (and so the test run) hanging.
  child.unref();
  child.stdout.unref();
  process.once('exit', () => child.kill());
  return {
    base,
    close: () => {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const backends = [
  { name: 'JavaScript', start: async () => ({ ...createSyncServer({ authorize: allowAnyone }), close: () => {} }) },
  ...(binaryPath
    ? [{
        name: 'binary',
        start: async () => {
          const { base, close } = await startBinary(['--keep-alive', '200', '--open']);
          // The same fetch(request) shape, over the network.
          const fetchIt = async (request) => {
            const url = new URL(request.url);
            const body = request.method === 'GET' ? undefined : await request.arrayBuffer();
            return fetch(`${base}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, signal: request.signal });
          };
          return { fetch: fetchIt, close };
        },
      }]
    : []),
];
