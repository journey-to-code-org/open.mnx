// Serves a built gallery (demos/build.mjs) under its base path, as GitHub Pages would:
//
//   node demos/serve.mjs [--dir _site] [--base /zubra/] [--port 4173]
//
// Also imported by the gallery's test and the screenshot script (`serve(dir, base)`).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

/** Serve `dir` at `base`; resolves to the gallery's URL and a `close()`. */
export function serve(dir, base = '/', port = 0) {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    if (!pathname.startsWith(base)) return notFound(response);
    let path = join(dir, pathname.slice(base.length));
    // Pages redirects a directory without its slash; serving index.html there would break relative URLs.
    if (existsSync(path) && statSync(path).isDirectory()) {
      if (!pathname.endsWith('/')) {
        response.writeHead(301, { location: `${pathname}/` });
        return response.end();
      }
      path = join(path, 'index.html');
    }
    if (!existsSync(path)) return notFound(response);
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(response);
  });
  const notFound = (response) => {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
  };
  return new Promise((done) => server.listen(port, '127.0.0.1', () => {
    done({ url: `http://127.0.0.1:${server.address().port}${base}`, close: () => server.close() });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const { url } = await serve(resolve(option('--dir', '_site')), option('--base', '/'), Number(option('--port', 4173)));
  console.log(`demos: ${url}`);
}
