// define(): the custom element a compiled component becomes.
//
// The compiler hands over a template and a list of parts (see src/emit_js.rs). Each part has a
// path to a node and a function computing what goes there. On first connection the element
// either clones the template (fresh) or finds the same nodes in markup the server already
// rendered (hydration), then binds every part with an effect. Hydration never re-renders: a
// part only writes when its value differs from what is already in the DOM.
//
// Paths count element and comment children only. The browser merges and drops text nodes, so
// text is reached through its element (an only child) or through an empty-comment anchor.
import { Signal } from './signal.js';
import { effect, scope, tick } from './effect.js';

const { untrack } = Signal.subtle;
const TEXT = 3;
const COMMENT = 8;

// ---- values --------------------------------------------------------------------------------

const isSignal = (value) => value instanceof Signal.State || value instanceof Signal.Computed;

/** Unwrap a signal, so templates can read `{count}` for `const count = state(0)`. */
export const $r = (value) => (isSignal(value) ? value.get() : value);

/** Text for a `{…}` in content: null/undefined render nothing; objects are an error. */
export function $t(value) {
  value = $r(value);
  if (value == null) return '';
  if (typeof value === 'object') {
    console.error('mnx: cannot render an object as text; access a field or iterate it instead', value);
    return '';
  }
  return String(value);
}

/** The same rule the compiler applies at build time (src/validate.rs `is_safe_url`). */
export function isSafeUrl(value) {
  const url = String(value).trim();
  if (!url || /[\u0000-\u001f\u007f-\u009f]/.test(url) || url.startsWith('//')) return false;
  const beforePath = url.split(/[/?#]/)[0];
  const colon = beforePath.indexOf(':');
  if (colon < 0) return true;
  return ['http', 'https', 'mailto', 'tel'].includes(beforePath.slice(0, colon).toLowerCase());
}

const clone = (value) => (value && typeof value === 'object' ? structuredClone(value) : value);

/** Attribute text → prop value, typed by the prop's default (JSON for arrays and objects). */
function parseAttribute(spec, raw) {
  const fallback = spec.default;
  if (typeof fallback === 'boolean') return fallback ? raw !== 'false' : raw !== null;
  if (raw === null) return clone(fallback);
  if (typeof fallback === 'number') return Number(raw);
  if (typeof fallback === 'string') return raw;
  if (fallback === undefined || fallback === null) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`mnx: attribute "${spec.attribute}" is not valid JSON:`, raw);
    return clone(fallback);
  }
}

// ---- hooks ---------------------------------------------------------------------------------

let current = null; // lifecycle hooks of the component whose setup is running

function hooks(name) {
  if (!current) throw new Error(`mnx: ${name}() must be called while a component is setting up`);
  return current;
}

export const state = (value, options) => new Signal.State(value, options);
export const computed = (fn, options) => new Signal.Computed(fn, options);

/** Run when the element is connected; may return a cleanup for when it is disconnected. */
export function onMount(fn) {
  hooks('onMount').mount.push(fn);
}

/** Run when the element is disconnected. */
export function onUnmount(fn) {
  hooks('onUnmount').unmount.push(fn);
}

/** Call `callback(next, previous)` when `source()` changes (not on the first run). */
export function watch(source, callback) {
  let first = true;
  let previous;
  effect(() => {
    const next = $r(typeof source === 'function' ? source() : source);
    if (!first && !Object.is(next, previous)) {
      const old = previous;
      untrack(() => callback(next, old));
    }
    first = false;
    previous = next;
  });
}

// ---- finding parts -------------------------------------------------------------------------
//
// A range is a run of sibling nodes: an element's children, or the nodes between a region's
// `<!--[-->` and its matching `<!--]-->`. Within a range, positions count elements and comments
// only, and a whole region counts as one position (its start marker), so a list's length never
// shifts the paths of what comes after it.

const isOpen = (node) => node.nodeType === COMMENT && node.data === '[';
const isClose = (node) => node.nodeType === COMMENT && node.data === ']';

function matchingClose(open) {
  let depth = 0;
  for (let node = open.nextSibling; node; node = node.nextSibling) {
    if (isOpen(node)) depth++;
    else if (isClose(node)) {
      if (depth === 0) return node;
      depth--;
    }
  }
  return null;
}

function* positions(first, stop) {
  for (let node = first; node && node !== stop; node = node.nextSibling) {
    if (node.nodeType === TEXT) continue;
    yield node;
    if (isOpen(node)) {
      node = matchingClose(node);
      if (!node) return;
    }
  }
}

function walk(range, path) {
  let first = range.first;
  let stop = range.stop;
  let node = null;
  for (const index of path) {
    node = null;
    let seen = -1;
    for (const candidate of positions(first, stop)) {
      if (++seen === index) { node = candidate; break; }
    }
    if (!node) return null;
    first = node.firstChild;
    stop = null;
  }
  return node;
}

const childRange = (parent) => ({ first: parent.firstChild, stop: null });
const regionRange = (open, close) => ({ first: open.nextSibling, stop: close });

/** The node for every part, or null if the markup doesn't have the template's shape. */
function locate(range, parts) {
  const nodes = [];
  for (const part of parts) {
    const node = walk(range, part.path);
    const fits = !node ? false
      : part.when || part.each ? isOpen(node) && matchingClose(node) !== null
      : part.anchor ? node.nodeType === COMMENT && node.data === ''
      : node.nodeType === 1;
    if (!fits) return null;
    nodes.push(node);
  }
  return nodes;
}

// ---- blocks: the contents of an mnx-if branch or an mnx-each row ----------------------------

const blueprints = new WeakMap();
function blueprint(source) {
  let element = blueprints.get(source);
  if (!element) {
    element = document.createElement('template');
    element.innerHTML = source.template;
    blueprints.set(source, element);
  }
  return element;
}

function clearBetween(open, close) {
  while (open.nextSibling && open.nextSibling !== close) open.nextSibling.remove();
}

/**
 * Render `block` between `open` and `close`. When `hydrating`, first try to bind to nodes the
 * server already put there; otherwise (or if they don't fit) clone the block's template.
 */
function mountBlock(block, args, open, close, hydrating) {
  const parts = block.parts(...args);
  let nodes = hydrating ? locate(regionRange(open, close), parts) : null;
  const hydrated = nodes !== null;
  if (!nodes) {
    if (hydrating) console.warn('mnx: server markup for a region does not match its template; rendering it fresh');
    clearBetween(open, close);
    const fragment = blueprint(block).content.cloneNode(true);
    nodes = locate(childRange(fragment), parts);
    close.before(fragment);
  }
  parts.forEach((part, index) => bind(part, nodes[index], hydrated));
}

// ---- binding parts -------------------------------------------------------------------------

function bind(part, node, hydrating) {
  if (part.text) {
    effect(() => {
      const text = part.text();
      if (node.textContent !== text) node.textContent = text;
    });
  } else if (part.anchor) {
    effect(() => {
      const text = part.anchor();
      let target = node.nextSibling;
      if (!target || target.nodeType !== TEXT) {
        target = document.createTextNode('');
        node.after(target);
      }
      if (target.data !== text) target.data = text;
    });
  } else if (part.on) {
    // The handler is read when the event fires, so swapping it never re-subscribes.
    node.addEventListener(part.on, (event) => {
      const handler = $r(part.handler());
      if (typeof handler === 'function') handler.call(node, event);
    });
  } else if (part.attribute) {
    bindAttribute(part, node);
  } else if (part.when) {
    bindWhen(part, node, hydrating);
  } else if (part.each) {
    bindEach(part, node, hydrating);
  }
}

function bindAttribute(part, node) {
  const name = part.attribute;
  effect(() => {
    const value = $r(part.value());
    if (part.boolean) {
      if (typeof value !== 'boolean') {
        console.error(`mnx: "${name}" is a boolean attribute; got`, value);
        return;
      }
      node.toggleAttribute(name, value);
      return;
    }
    if (value == null) return node.removeAttribute(name);
    if (typeof value === 'object') {
      console.error(`mnx: cannot write an object to the "${name}" attribute`, value);
      return node.removeAttribute(name);
    }
    const text = String(value);
    if (part.url && !isSafeUrl(text)) {
      console.error(`mnx: blocked an unsafe URL in "${name}":`, text);
      return node.removeAttribute(name);
    }
    if (node.getAttribute(name) !== text) node.setAttribute(name, text);
  });
}

/** mnx-if: re-render only when the chosen branch changes, not whenever the test re-runs. */
function bindWhen(part, open, hydrating) {
  const close = matchingClose(open);
  const branch = new Signal.Computed(() => ($r(part.when()) ? 0 : 1));
  let first = hydrating;
  effect(() => {
    const block = part.blocks[branch.get()];
    const hydrate = first;
    first = false;
    // Effects created while mounting belong to this effect, so switching branches disposes them.
    untrack(() => {
      if (block) mountBlock(block, [], open, close, hydrate);
      else clearBetween(open, close);
    });
  });
}

/**
 * mnx-each: one row per item, updated in place by position. Each row holds its item and index
 * as signals, so changing one item updates only that row's parts; rows are only created or
 * removed at the end when the length changes.
 */
function bindEach(part, open, hydrating) {
  const close = matchingClose(open);
  // Rows belong to this scope, not to the effect below, so re-running the effect (the list
  // changed) doesn't dispose them.
  const rowsOwner = scope();
  const rows = [];
  const addRow = (rowOpen, rowClose, value, index, hydrateRow) => {
    const item = new Signal.State(value);
    const position = new Signal.State(index);
    const owner = rowsOwner.run(() => scope(() => mountBlock(part.block, [item, position], rowOpen, rowClose, hydrateRow)));
    rows.push({ item, position, open: rowOpen, close: rowClose, owner });
  };
  let first = hydrating;
  effect(() => {
    let list = $r(part.each());
    if (!Array.isArray(list)) {
      if (list != null) console.error('mnx: mnx-each items must be an array; got', list);
      list = [];
    }
    const hydrate = first;
    first = false;
    untrack(() => {
      if (hydrate) {
        const existing = [...positions(open.nextSibling, close)];
        if (existing.length === list.length && existing.every(isOpen)) {
          existing.forEach((rowOpen, index) => addRow(rowOpen, matchingClose(rowOpen), list[index], index, true));
          return;
        }
        console.warn('mnx: server markup for a list does not match its items; rendering it fresh');
        clearBetween(open, close);
      }
      const shared = Math.min(rows.length, list.length);
      for (let index = 0; index < shared; index++) {
        rows[index].item.set(list[index]);
        rows[index].position.set(index);
      }
      for (let index = rows.length; index < list.length; index++) {
        const rowOpen = document.createComment('[');
        const rowClose = document.createComment(']');
        close.before(rowOpen, rowClose);
        addRow(rowOpen, rowClose, list[index], index, false);
      }
      for (const row of rows.splice(list.length)) {
        row.owner.dispose();
        while (row.open.nextSibling !== row.close) row.open.nextSibling.remove();
        row.open.remove();
        row.close.remove();
      }
    });
  });
}

const hasContent = (root) =>
  [...root.childNodes].some((node) => node.nodeType !== TEXT || node.data.trim() !== '');

// ---- define --------------------------------------------------------------------------------

/**
 * Register a compiled component. `props` maps prop names to `{ attribute, default, required }`;
 * `template` is the element's inner HTML with dynamic parts left empty; `setup($p)` runs the
 * component's script once per element and returns its parts.
 */
export function define(tag, { props = {}, template = '', shadow = false, setup }) {
  if (customElements.get(tag)) return customElements.get(tag);
  const componentTemplate = blueprint({ template });
  const byAttribute = Object.fromEntries(Object.entries(props).map(([name, spec]) => [spec.attribute, name]));

  class MnxElement extends HTMLElement {
    static observedAttributes = Object.keys(byAttribute);
    #signals = {};
    #scope = null;
    #hooks = null;
    #cleanups = [];

    static {
      for (const name of Object.keys(props)) {
        Object.defineProperty(this.prototype, name, {
          get() { return this.#signals[name].get(); },
          set(value) { this.#signals[name].set(value); },
          configurable: true,
          enumerable: true,
        });
      }
    }

    constructor() {
      super();
      for (const [name, spec] of Object.entries(props)) {
        this.#signals[name] = new Signal.State(clone(spec.default));
        // A framework may have set the property before the element was defined; that landed
        // as an own property shadowing the accessor. Take it over.
        if (Object.hasOwn(this, name)) {
          const value = this[name];
          delete this[name];
          this.#signals[name].set(value);
        }
      }
    }

    attributeChangedCallback(attribute, _old, value) {
      const name = byAttribute[attribute];
      this[name] = parseAttribute(props[name], value);
    }

    connectedCallback() {
      if (this.#scope) this.#scope.resume();
      else this.#boot();
      this.#cleanups = this.#hooks.mount.map((fn) => fn()).filter((cleanup) => typeof cleanup === 'function');
    }

    disconnectedCallback() {
      for (const cleanup of this.#cleanups.splice(0)) cleanup();
      for (const fn of this.#hooks.unmount) fn();
      // Paused, not disposed: long-lived signals stop holding this element, and if it comes
      // back only the parts whose inputs changed meanwhile are re-run.
      this.#scope.pause();
    }

    /** Resolves once pending prop changes have reached the DOM. */
    get updateComplete() {
      return tick();
    }

    #boot() {
      const element = this;
      const root = shadow ? (this.shadowRoot ?? this.attachShadow({ mode: 'open' })) : this;
      const $p = {};
      for (const name of Object.keys(props)) {
        Object.defineProperty($p, name, {
          get: () => element.#signals[name].get(),
          set: (value) => element.#signals[name].set(value),
          enumerable: true,
        });
      }
      this.#hooks = { mount: [], unmount: [] };
      this.#scope = scope(() => {
        const previous = current;
        current = this.#hooks;
        let parts;
        try { parts = setup ? setup($p) : []; } finally { current = previous; }

        const server = hasContent(root);
        let nodes = server ? locate(childRange(root), parts) : null;
        const hydrated = nodes !== null;
        if (!nodes) {
          if (server) console.warn(`mnx: <${tag}>'s markup doesn't match its template; rendering it fresh`);
          root.replaceChildren(componentTemplate.content.cloneNode(true));
          nodes = locate(childRange(root), parts);
        }
        parts.forEach((part, index) => bind(part, nodes[index], hydrated));
      });
    }
  }

  customElements.define(tag, MnxElement);
  return MnxElement;
}
