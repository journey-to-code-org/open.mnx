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

// ---- finding and binding parts -------------------------------------------------------------

function walk(root, path) {
  let node = root;
  for (const index of path) {
    let seen = -1;
    let next = null;
    for (const child of node.childNodes) {
      if (child.nodeType === TEXT) continue;
      if (++seen === index) { next = child; break; }
    }
    if (!next) return null;
    node = next;
  }
  return node;
}

/** The node for every part, or null if the markup doesn't have the template's shape. */
function locate(root, parts) {
  const nodes = [];
  for (const part of parts) {
    const node = walk(root, part.path);
    const want = part.anchor ? COMMENT : 1;
    if (!node || node.nodeType !== want) return null;
    nodes.push(node);
  }
  return nodes;
}

function bind(part, node) {
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
  const blueprint = document.createElement('template');
  blueprint.innerHTML = template;
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
        let nodes = server ? locate(root, parts) : null;
        if (!nodes) {
          if (server) console.warn(`mnx: <${tag}>'s markup doesn't match its template; rendering it fresh`);
          root.replaceChildren(blueprint.content.cloneNode(true));
          nodes = locate(root, parts);
        }
        parts.forEach((part, index) => bind(part, nodes[index]));
      });
    }
  }

  customElements.define(tag, MnxElement);
  return MnxElement;
}
