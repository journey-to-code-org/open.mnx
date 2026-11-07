// mnx on the server, with no bundler:
//
// - `render(name, props, slots)` renders a component to HTML for a page (with @mnx/compiler,
//   the same compiler as the browser's modules, so the element hydrates that markup in place).
//   Each page records which components it used.
// - `/components/<name>.js` is each component compiled to a browser module, and
//   `/vendor/mnx/…` is @mnx/runtime, which an import map in the layout points to.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { compileFile, request, sources } from '@mnx/compiler';
import { HOW_TO, useCompiler } from './compiler.js';

const here = dirname(fileURLToPath(import.meta.url));
const compiler = useCompiler();
export const COMPONENTS = join(here, '../components');
// The runtime's ES modules (its entry is src/index.js), served as they are.
const runtimeDir = dirname(fileURLToPath(import.meta.resolve('@mnx/runtime')));

const names = readdirSync(COMPONENTS).filter((file) => file.endsWith('.mnx')).map((file) => file.slice(0, -4));

export function createMnx({ cache = true } = {}) {
  const files = new Map(); // a component's sources (it and the components it imports)
  const styles = new Map();
  const modules = new Map();
  const sourcesOf = (name) => {
    if (!cache || !files.has(name)) files.set(name, sources(join(COMPONENTS, `${name}.mnx`)));
    return files.get(name);
  };
  const check = (response) => {
    if (!response.ok) throw new Error(response.error);
    return response.output;
  };
  if (!compiler) throw new Error(`mnx: no compiler found.\n${HOW_TO}`);

  /** Everything a page needs: what it rendered, and the CSS of those components. */
  function page() {
    const used = new Set();
    return {
      used,
      render(name, props = {}, slots = {}) {
        if (!names.includes(name)) throw new Error(`no component ${name}`);
        const all = sourcesOf(name);
        const path = join(COMPONENTS, `${name}.mnx`);
        used.add(name);
        // Its children's styles come with it: a component's CSS includes the ones it imports.
        if (!styles.has(name) || !cache) styles.set(name, check(request({ emit: 'css', path, files: all })));
        return check(request({ emit: 'html', path, files: all, props, slots, slotSource: 'html', partial: true }));
      },
      css: () => [...used].map((name) => styles.get(name)).join('\n'),
    };
  }

  const router = express.Router();
  router.use('/vendor/mnx', express.static(runtimeDir, { maxAge: cache ? '1h' : 0 }));
  router.get('/components/:name.js', (req, res, next) => {
    const { name } = req.params;
    if (!names.includes(name)) return next();
    if (!cache || !modules.has(name)) {
      modules.set(name, check(compileFile(join(COMPONENTS, `${name}.mnx`), { emit: 'js', runtime: '@mnx/runtime' })));
    }
    res.type('text/javascript').send(modules.get(name));
  });
  return { page, router };
}
