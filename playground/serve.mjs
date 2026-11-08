// Serves the built playground (playground/dist) for local work and its tests:
//
//   node playground/serve.mjs [--port 5174]
//
// Without zubra.wasm in the site, the page asks this server instead: POST /__zubra/request runs
// the native compiler (`zubra request`; $ZUBRA_COMPILER, or target/debug/zubra).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

/** Start serving `dir`; resolves to the server (its URL is `server.url`). */
export async function serve(dir = join(here, 'dist'), { port = 0, compiler = process.env.ZUBRA_COMPILER ?? join(here, '../target/debug/zubra') } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/__zubra/request' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const result = spawnSync(compiler, ['request'], { input: body, encoding: 'utf8', maxBuffer: 1 << 28 });
        response.writeHead(result.status === 0 ? 200 : 500, { 'content-type': 'application/json' }).end(result.stdout || JSON.stringify({ ok: false, error: result.stderr }));
      });
      return;
    }
    let path = join(dir, decodeURIComponent(url.pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    let body;
    try {
      body = readFileSync(path);
    } catch {
      return response.writeHead(404).end();
    }
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain' }).end(body);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${server.address().port}/`;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port');
  const server = await serve(undefined, { port: at > 0 ? Number(process.argv[at + 1]) : 5174 });
  console.log(`playground: ${server.url}`);
}
