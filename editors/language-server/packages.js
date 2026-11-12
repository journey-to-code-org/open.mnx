// Where a package's component is: the same rule as @zubra/compiler's packageFile, kept here because
// the language server runs without @zubra/compiler when the workspace has none. A test in
// compiler/test/packages.test.js runs both on the same cases, so they can't drift apart.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Where a package's component (`@acme/kit/components/cart-panel.zb`) is, looked for as Node looks
 * for a package: in the node_modules of `dir` and each folder above it. A package with `exports`
 * must export the path (`"./components/*": "./components/*"`); one without exposes every file.
 * Returns `{ path }`, or `{ error }` saying why not.
 */
export function packageFile(dir, specifier) {
  const parts = specifier.split('/');
  const scoped = specifier.startsWith('@') ? 2 : 1;
  if (parts.length <= scoped) return { error: `\`${specifier}\` names a package, not a component in it` };
  const name = parts.slice(0, scoped).join('/');
  const subpath = `./${parts.slice(scoped).join('/')}`;
  for (let at = resolve(dir); ; at = dirname(at)) {
    const root = join(at, 'node_modules', name);
    if (existsSync(join(root, 'package.json')) || existsSync(root)) {
      let manifest = {};
      try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch {}
      const target = manifest.exports === undefined ? subpath : exported(manifest.exports, subpath);
      if (!target) return { error: `${name} doesn't export ${subpath} (its package.json "exports")` };
      const path = join(root, target);
      return existsSync(path) ? { path } : { error: `${name} has no ${target.replace(/^\.\//, '')}` };
    }
    if (dirname(at) === at) return { error: `${name} isn't installed: it isn't in any node_modules above ${dir}` };
  }
}

/** The file `exports` maps `subpath` to: an exact key, or one with a `*`; a string, or the first condition an import meets. */
function exported(exports, subpath) {
  const map = exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.')) ? exports : { '.': exports };
  // A condition object is read in its own order, taking the first condition an import meets.
  const pick = (value) =>
    typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(pick).find(Boolean) ?? null
    : value && typeof value === 'object' ? pick(Object.entries(value).find(([condition]) => ['import', 'node', 'default'].includes(condition))?.[1])
    : null;
  if (subpath in map) return pick(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star < 0 || subpath.length < key.length - 1 || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1))) continue;
    const matched = subpath.slice(star, subpath.length - (key.length - star - 1));
    return pick(value)?.replaceAll('*', matched) ?? null;
  }
  return null;
}
