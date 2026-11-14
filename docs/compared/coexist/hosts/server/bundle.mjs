// The browser's script for a tool with no server of its own to send it: the elements, bundled
// once when the server starts, and served at /ds.js.
import { build } from 'esbuild';

export async function bundle(entry, { inject = [] } = {}) {
  const result = await build({
    entryPoints: [entry], inject, bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const script = result.outputFiles[0].text;
  return (request, response) => {
    if (new URL(request.url, 'http://localhost').pathname !== '/ds.js') return false;
    response.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
    return true;
  };
}
