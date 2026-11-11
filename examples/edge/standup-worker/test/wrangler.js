// Runs a Worker in workerd (`wrangler dev --local`) for a test, and stops the whole process tree.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** `args`: extra flags (`--config`, `--persist-to`). Resolves to `{ url, stop() }` once it's ready. */
export async function startWorker(cwd, args = []) {
  const port = await freePort();
  const child = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', ...args], {
    cwd,
    detached: true, // its own process group, so npx, wrangler and workerd stop together
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not become ready in 90s:\n${log}`)), 90_000);
    const seen = (data) => {
      log += data;
      if (/Ready on/.test(log)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.once('exit', (code) => reject(new Error(`wrangler dev exited with ${code}:\n${log}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    log: () => log,
    async stop() {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await exited;
    },
  };
}
