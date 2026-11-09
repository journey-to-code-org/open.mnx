// What development records for the DevTools, from the page's first element on: which components
// are on the page, and which listeners each node has. Only element.js imports it, from a
// `// @dev` block, so the production build (scripts/build-production.js) leaves it out.
//
// This part is small and always loaded in development. The reading (devtools.js) is loaded
// when the browser extension connects, so a page that never opens the pane carries only this.

export const elements = new WeakMap(); // host → { tag, source, props, named, scope }
export const listeners = new WeakMap(); // node → the listener parts bound to it
export const hooks = { registered: null }; // devtools.js listens once it's loaded

/** An element finished setting up (see devtools.js for what the record holds). */
export function register(host, record) {
  elements.set(host, record);
  hooks.registered?.(record);
}

/** A listener part was bound to `node` (effects carry their part; listeners aren't effects). */
export function listened(part, node) {
  let parts = listeners.get(node);
  if (!parts) listeners.set(node, (parts = []));
  if (!parts.includes(part)) parts.push(part);
}

let loading = null;
if (!globalThis.__ZUBRA_DEVTOOLS__) {
  globalThis.__ZUBRA_DEVTOOLS__ = {
    version: 1,
    /** Load the reading side; the extension calls this, then `inspect()` once it's there. */
    connect() {
      loading ??= import('./devtools.js');
      return true;
    },
  };
}
