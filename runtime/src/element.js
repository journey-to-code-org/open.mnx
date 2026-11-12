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
import { wrap, raw } from './deep.js';
import { effect, scope, root as rootScope, tick, batch } from './effect.js';
import { RESOURCE } from './resource.js';
// @dev (left out of the production build: scripts/build-production.js)
import { dev as devEffects } from './effect.js';
import { register as devRegister, listened as devListened } from './devhook.js';
// @dev-end

const { untrack } = Signal.subtle;
const TEXT = 3;
const COMMENT = 8;

// ---- values --------------------------------------------------------------------------------

const isSignal = (value) => value instanceof Signal.State || value instanceof Signal.Computed;

/** Unwrap a signal, so templates can read `{count}` for `const count = state(0)`. */
/** Where a message's topic is documented. */
const see = (section) => ` (see https://github.com/journey-to-code-org/zubra#${section})`;

export const $r = (value) => (isSignal(value) ? value.get() : value);

/** Text for a `{…}` in content: null/undefined render nothing; objects are an error. */
export function $t(value) {
  value = $r(value);
  if (value == null) return '';
  if (typeof value === 'object') {
    console.error('zubra: cannot render an object as text; access a field or iterate it instead', value);
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

/** A srcset whose every candidate's URL is safe (src/validate.rs `is_safe_srcset`). */
export function isSafeSrcset(value) {
  const urls = String(value).split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean);
  return urls.length > 0 && urls.every(isSafeUrl);
}

const clone = (value) => (value && typeof value === 'object' ? structuredClone(value) : value);

/** Attribute text → prop value, typed by the prop's default (JSON for arrays and objects). */
function parseAttribute(spec, raw) {
  const fallback = spec.default;
  // An enum prop (`<script lang="ts">`): the member whose value the text is, or the member it names.
  if (spec.enum) {
    if (raw === null) return clone(fallback);
    const found = Object.values(spec.enum).find((value) => String(value) === raw);
    if (found !== undefined) return found;
    if (Object.hasOwn(spec.enum, raw)) return spec.enum[raw];
    console.warn(`zubra: attribute "${spec.attribute}" is "${raw}", not one of ${Object.keys(spec.enum).join(', ')}`);
    return clone(fallback);
  }
  if (typeof fallback === 'boolean') return fallback ? raw !== 'false' : raw !== null;
  if (raw === null) return clone(fallback);
  if (typeof fallback === 'number') return Number(raw);
  if (typeof fallback === 'string') return raw;
  if (fallback === undefined || fallback === null) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  // A framework's server rendering stringified an object it sets as a property once it runs
  // (Svelte does this): not given yet, rather than invalid.
  if (raw === '[object Object]') return clone(fallback);
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`zubra: attribute "${spec.attribute}" is not valid JSON:`, raw);
    return clone(fallback);
  }
}

// ---- hooks ---------------------------------------------------------------------------------

let current = null; // lifecycle hooks of the component whose setup is running

function hooks(name) {
  if (!current) throw new Error(`zubra: ${name}() must be called while a component is setting up${see('script-state-and-hooks')}`);
  return current;
}

/**
 * The signal itself, where a script passes a signal `const` along (`watch(signal(count), …)`).
 * It returns what it's given: since 3.0 a signal `const` in a script means its value, and the
 * compiler leaves `signal(name)`'s argument alone, so it's the signal. (`plan/decisions/3.0-scope.md`.)
 */
export const signal = (value) => value;

/** The original object behind reactive state (`let items = []` holds a proxy of the array). */
export { raw };

export const state = (value, options) => {
  // @hot (left out of the production build: scripts/build-production.js)
  // During a hot reload, a component's state keeps its value: by position, like hooks, unless
  // the edit changed what kind of value it holds.
  const kept = current?.kept;
  const at = current?.states?.length ?? 0;
  if (kept && at < kept.length && kind(kept[at]) === kind(value)) value = kept[at];
  // @hot-end
  const signal = new Signal.State(wrap(value), options);
  // An array or plain object assigned later is wrapped the same way, so `items = [...]` followed
  // by `items.push(x)` keeps updating.
  signal.set = (next) => Signal.State.prototype.set.call(signal, wrap(next));
  current?.states?.push(signal);
  return signal;
};
/**
 * State that follows a prop until it's assigned, and starts over when the prop changes:
 *
 *   let left = from(seconds)          // a timer's time left: counts down, resets on a new length
 *   let running = from(seconds, false) // false, and false again whenever `seconds` changes
 *
 * With a second argument, the state starts as that value instead, each time the first changes.
 * In a `.zb` script the compiler passes both as functions (`from(() => seconds)`), so the state
 * can follow them. Outside one, pass a function or a signal.
 */
export function from(source, start) {
  const read = (value) => (typeof value === 'function' ? value() : isSignal(value) ? value.get() : value);
  // A fresh box each time the source changes, so an assignment made against one value of the
  // source is dropped once it moves on (even back to the same value).
  const latest = new Signal.Computed(() => {
    const value = read(source);
    return { value: start === undefined ? value : read(start) };
  });
  const assigned = new Signal.State(null);
  const linked = new Signal.Computed(() => {
    const base = latest.get();
    const own = assigned.get();
    return wrap(own && own.base === base ? own.value : base.value);
  });
  linked.set = (value) => assigned.set({ base: untrack(() => latest.get()), value });
  // @hot (left out of the production build: scripts/build-production.js)
  // A hot reload keeps an assigned value, by position, like state().
  const kept = current?.kept;
  const at = current?.states?.length ?? 0;
  if (kept && at < kept.length && kind(kept[at]) === kind(untrack(() => linked.get()))) linked.set(kept[at]);
  // @hot-end
  current?.states?.push(linked);
  return linked;
}
// @hot
const kind = (value) => (value === null || value === undefined ? 'empty' : Array.isArray(value) ? 'array' : typeof value);
// @hot-end
export const computed = (fn, options) => new Signal.Computed(fn, options);

/**
 * Whether the element has started: false while its markup is the server's (and on the server),
 * true from when it hydrates (or renders) in the browser. A signal, read like a value in the
 * template, for what only works with JavaScript:
 *
 *   const live = hydrated()
 *   <zb-if test={!live}><button>Apply</button></zb-if>
 *
 * The host also gets the custom state `hydrated`, for CSS: `:host(:state(hydrated))`, or
 * `my-filters:state(hydrated)` from the page.
 */
export function hydrated() {
  return hooks('hydrated').hydrated;
}

/** Run when the element is connected; may return a cleanup for when it is disconnected. */
export function onMount(fn) {
  hooks('onMount').mount.push(fn);
}

/** Run when the element is disconnected. */
export function onUnmount(fn) {
  hooks('onUnmount').unmount.push(fn);
}

/**
 * The component's props: reading one tracks it (in `computed`, `effect`, the template), and
 * writing one updates the element as if it had been set from outside.
 */
export function props() {
  return hooks('props').props;
}

/**
 * The element whose setup is running, for custom hooks that need it (to read an attribute,
 * dispatch an event, observe its size, …).
 */
export function host() {
  return hooks('host').host;
}

/**
 * Fire a DOM event from the component: `emit('valuechange', value)`. The compiler binds `emit`
 * to each element, so handlers and timers can call it long after setup, and declares every
 * event it sees. Outside a compiled component, use the `emit` that `setup` receives.
 */
export function emit(name) {
  throw new Error(`zubra: emit("${name}") is bound to each element by the compiler; outside a compiled component, use the emit that setup() receives`);
}

/**
 * An id unique to this element and call, for `id`/`for`/`aria-*` attributes. Stable for the
 * element's life. Based on the host's own `id` when it has one, else on the base the server
 * rendered it with (`data-zb-id`), so the ids in server-rendered markup stay as they are.
 */
export function id() {
  const component = hooks('id');
  const host = component.host;
  const base = host.id || host.getAttribute('data-zb-id') || `${host.localName}-${component.instance}`;
  return `${base}-${++component.ids}`;
}

// ---- form-associated components ------------------------------------------------------------
//
// With `form-associated` on the host, the element is a form control built on the platform's
// ElementInternals: it submits a value, takes part in validation, reset and restore, and is
// disabled by a disabled <fieldset> — and exposes the same API as native controls.

function formHooks(name) {
  const component = hooks(name);
  if (!component.internals) {
    throw new Error(`zubra: ${name}() needs form-associated on the component's host tag${see('forms')}`);
  }
  return component;
}

/** What the form submits for this control: follows `source` (a signal, function or value). */
export function formValue(source) {
  const component = formHooks('formValue');
  const { internals } = component;
  component.formValued = true;
  effect(() => {
    const value = $r(typeof source === 'function' ? source() : source);
    internals.setFormValue(value == null ? null : value instanceof FormData || value instanceof File ? value : String(value));
  });
}

/**
 * Validation: `check()` returns an error message, or '' / null when the value is valid. Re-runs
 * when what it reads changes; the form won't submit while it reports an error.
 */
const FOCUSABLE = 'input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex="-1"]), [contenteditable]';

export function validity(check) {
  const component = formHooks('validity');
  const { internals, host } = component;
  // The browser shows the message at the anchor and focuses it when a form won't submit: the
  // first focusable element the component rendered (the host itself isn't focusable).
  const anchor = () => {
    for (const node of (host.shadowRoot ?? host).querySelectorAll(FOCUSABLE)) {
      if (!node.closest('[data-zb-slotted]')) return node;
    }
    return host;
  };
  let message = '';
  const apply = () => {
    if (message) internals.setValidity({ customError: true }, message, anchor());
    else internals.setValidity({});
  };
  effect(() => {
    message = String($r(check()) || '');
    apply();
  });
  component.mount.push(apply); // once rendered, the anchor is inside
}

/** The form was reset. */
export function onFormReset(fn) {
  formHooks('onFormReset').formReset.push(fn);
}

/** The browser restored a value (back/forward navigation, autofill): `fn(state, mode)`. */
export function onFormRestore(fn) {
  formHooks('onFormRestore').formRestore.push(fn);
}

/** The control was disabled or enabled (its own attribute, or a disabled <fieldset>). */
export function onFormDisabled(fn) {
  formHooks('onFormDisabled').formDisabled.push(fn);
}

// ---- context (the Web Components Community Group Context Protocol) -------------------------
//
// A consumer dispatches a bubbling, composed `context-request` event carrying the context key
// and a callback; the nearest provider for that key stops it and calls back with the value,
// and with `subscribe: true` keeps calling back when the value changes, passing an
// `unsubscribe` function. Providers announce themselves with a `context-provider` event, so a
// consumer that asked before its provider existed can ask again. Because it is plain DOM events,
// zubra components share context with any other implementation (Lit's @lit/context, …).

export class ContextRequestEvent extends Event {
  constructor(context, contextTarget, callback, subscribe) {
    super('context-request', { bubbles: true, composed: true });
    this.context = context;
    this.contextTarget = contextTarget;
    this.callback = callback;
    this.subscribe = subscribe;
  }
}

export class ContextProviderEvent extends Event {
  constructor(context, contextTarget) {
    super('context-provider', { bubbles: true, composed: true });
    this.context = context;
    this.contextTarget = contextTarget;
  }
}

/** A context key, with the value consumers get when no provider answers. */
export function createContext(defaultValue) {
  return Object.freeze({ defaultValue });
}

/**
 * Provide `value` (a plain value or a signal) for `context` to every element inside this one.
 * Must be called during setup.
 */
export function provide(context, value) {
  const host = hooks('provide').host;
  const subscribers = new Set();
  host.addEventListener('context-request', (event) => {
    if (event.context !== context || event.contextTarget === host) return;
    event.stopPropagation();
    if (!event.subscribe) return event.callback($r(value));
    const subscriber = { callback: event.callback };
    subscriber.unsubscribe = () => subscribers.delete(subscriber);
    subscribers.add(subscriber);
    event.callback($r(value), subscriber.unsubscribe);
  });
  watch(() => $r(value), (next) => {
    for (const subscriber of [...subscribers]) subscriber.callback(next, subscriber.unsubscribe);
  });
  host.dispatchEvent(new ContextProviderEvent(context, host));
}

/**
 * Read `context` from the nearest provider above this element, as a signal that follows the
 * provider's value. Must be called during setup. Without a provider the value is `fallback`
 * (by default the context's own default). Works with any Context Protocol provider: pass its
 * key as `context`.
 */
export function inject(context, fallback = context?.defaultValue) {
  const component = hooks('inject');
  const host = component.host;
  // The value the server rendered with (`data-zb-inject`, by call number) is where it starts,
  // so hydrating doesn't show the default until the provider answers.
  const number = (component.injects = (component.injects ?? 0) + 1);
  const rendered = host.getAttribute('data-zb-inject');
  if (rendered) {
    try {
      const values = JSON.parse(rendered);
      if (Object.hasOwn(values, number)) fallback = values[number];
    } catch { /* not ours: keep the default */ }
  }
  const value = new Signal.State(fallback);
  let unsubscribe = null;
  let answered = false;
  let generation = 0;
  const request = () => {
    const mine = ++generation;
    answered = false;
    host.dispatchEvent(new ContextRequestEvent(context, host, (next, stop) => {
      if (mine !== generation) return stop?.();  // an answer to a request we've moved past
      answered = true;
      if (stop) unsubscribe = stop;
      value.set(next);
    }, true));
  };
  const lateProvider = (event) => {
    if (!answered && event.context === context && event.contextTarget !== host) request();
  };
  // Ask now, so the first render already has the value; ask again whenever the element is
  // re-attached (it may have moved under a different provider).
  let firstMount = true;
  request();
  onMount(() => {
    if (!firstMount) request();
    firstMount = false;
    document.addEventListener('context-provider', lateProvider);
    return () => {
      document.removeEventListener('context-provider', lateProvider);
      generation++;
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  return new Signal.Computed(() => value.get());
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
// `<?zb [?>` and its matching `<?zb ]?>`. Within a range, positions count elements and comments
// only, and a whole region counts as one position (its start marker), so a list's length never
// shifts the paths of what comes after it.

// `[!` opens a slot region holding supplied content (static, left alone on hydration).
// `[?` opens a region the server left for the element to render (partial rendering).
//
// The server writes markers as processing instructions (`<?zb [?>`, `<?zb ]?>`, `<?zb ?>`), which
// HTML minifiers and sanitizers keep. A browser that doesn't parse them yet makes each a comment
// (`?zb [?`), and client templates and 4.x servers use plain comments (`[`): `marker` reads all three.
const PI = 7;
/** A marker's text (`[`, `[!`, `[?`, `]`, or '' for a text anchor), or null for any other node. */
function marker(node) {
  if (node.nodeType === PI) return node.target === 'zb' ? node.data : null;
  if (node.nodeType !== COMMENT) return null;
  const data = node.data;
  return data.startsWith('?zb ') ? data.slice(4, data.endsWith('?') ? -1 : undefined) : data;
}
const isOpen = (node) => { const m = marker(node); return m === '[' || m === '[!' || m === '[?'; };
/**
 * Whether to bind a region's server markup: not when the server left it to the element. A region
 * the server is still streaming sits in a named range (`<?start name>`…`<?end>`): the element
 * renders it from now on, so it removes the name, and the browser's `<template for>` finds nothing.
 */
function hydratable(open, hydrating) {
  if (!hydrating || marker(open) !== '[?') return hydrating;
  const named = (node, kind) => node && (node.nodeType === PI ? node.target === kind : marker(node)?.startsWith(`?${kind}`));
  const start = open.previousSibling;
  const end = matchingClose(open)?.nextSibling;
  if (named(start, 'start') && named(end, 'end')) { start.remove(); end.remove(); }
  return false;
}
const isClose = (node) => marker(node) === ']';
/** Change a region's opening marker: a PI keeps its target, a comment takes the plain form. */
const setMarker = (node, text) => { if (marker(node) !== text) node.data = text; };

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

const MARKERS = ['[', '[!', '[?', ']', ''];
/** The nodes that hold a position: elements and markers (not text, nor a stream's `<?start>`). */
function* positions(first, stop) {
  for (let node = first; node && node !== stop; node = node.nextSibling) {
    if (node.nodeType !== 1 && !MARKERS.includes(marker(node))) continue;
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
    // The next step goes into this node: an element's children, or a region's contents (a
    // part inside a child component's slot, in server markup, is reached that way).
    if (isOpen(node)) {
      first = node.nextSibling;
      stop = matchingClose(node);
    } else {
      first = node.firstChild;
      stop = null;
    }
  }
  return node;
}

const childRange = (parent) => ({ first: parent.firstChild, stop: null });
const regionRange = (open, close) => ({ first: open.nextSibling, stop: close });

/** The node for every part, or null if the markup doesn't have the template's shape. */
function locate(range, parts, hydrating = false) {
  const nodes = [];
  for (const part of parts) {
    // In server markup, content given to a child component sits where the child projected it.
    const node = walk(range, hydrating && part.hydrate ? part.hydrate : part.path);
    const fits = !node ? false
      : part.when || part.each || part.slot || part.await ? isOpen(node) && matchingClose(node) !== null
      : part.anchor || part.global ? marker(node) === ''
      : node.nodeType === 1;
    if (!fits) return null;
    nodes.push(node);
  }
  return nodes;
}

// ---- blocks: the contents of an zb-if branch or an zb-each row ----------------------------

const blueprints = new WeakMap();
const SVG = 'http://www.w3.org/2000/svg';
const MATHML = 'http://www.w3.org/1998/Math/MathML';

/**
 * A block's template, parsed once per context. Inside `<svg>` (or `<math>`), the markup is
 * parsed inside that element, so `<circle>` and friends get their namespace: parsed alone, they
 * would be unknown HTML elements.
 */
// The element a fragment's nodes will go into, for fragments assembled before they're placed.
const fragmentParents = new WeakMap();
/** The element `node` is in, or will be in once its fragment is placed. */
function parentOf(node) {
  const parent = node.parentNode;
  return parent?.nodeType === 11 ? fragmentParents.get(parent) ?? null : parent;
}

function blueprint(source, parent = null) {
  const ns = parent?.namespaceURI;
  const context = ns === SVG && parent.localName !== 'foreignObject' ? 'svg' : ns === MATHML ? 'math' : '';
  let byContext = blueprints.get(source);
  if (!byContext) blueprints.set(source, (byContext = {}));
  let content = byContext[context];
  if (!content) {
    const element = document.createElement('template');
    element.innerHTML = context ? `<${context}>${source.template}</${context}>` : source.template;
    content = element.content;
    if (context) content.replaceChildren(...content.firstChild.childNodes);
    byContext[context] = content;
  }
  return content;
}

function clearBetween(open, close) {
  while (open.nextSibling && open.nextSibling !== close) open.nextSibling.remove();
}

/**
 * `animate`: the region's nodes leave (`motion`, @zubra/runtime/motion, which the compiled module
 * imports only when a component animates) instead of going at once. They stay where they are,
 * and the region starts after them, so what replaces them is rendered beside them.
 */
function departBetween(open, close, motion) {
  const nodes = [];
  for (let node = open.nextSibling; node && node !== close; node = node.nextSibling) nodes.push(node);
  if (!nodes.length) return;
  nodes[nodes.length - 1].after(open);
  motion.leave(nodes);
}

/** Remove everything between `open` and `close` in one operation. */
function deleteBetween(open, close) {
  if (open.nextSibling === close) return;
  const range = document.createRange();
  range.setStartAfter(open);
  range.setEndBefore(close);
  range.deleteContents();
}

/**
 * Render `block` between `open` and `close`. When `hydrating`, first try to bind to nodes the
 * server already put there; otherwise (or if they don't fit) clone the block's template.
 */
function mountBlock(block, args, open, close, hydrating, context) {
  const parts = block.parts(...args);
  const nodes = hydrating ? locate(regionRange(open, close), parts, true) : null;
  if (nodes) {
    parts.forEach((part, index) => bind(part, nodes[index], true, context));
    return;
  }
  if (hydrating) console.warn(`zubra: server markup for a region does not match its template; rendering it fresh${see('server-rendering-and-hydration')}`);
  clearBetween(open, close);
  // Find and bind the parts in the fragment, then insert it: child components inside see
  // their props from the start, and can't move slotted nodes before they're found.
  // importNode, not cloneNode: defined custom elements upgrade now, so their properties exist
  // before parts bind (a clone stays in the template's inert document).
  const parent = parentOf(close);
  const fragment = document.importNode(blueprint(block, parent), true);
  fragmentParents.set(fragment, parent);
  const fresh = locate(childRange(fragment), parts);
  parts.forEach((part, index) => bind(part, fresh[index], false, context));
  close.before(fragment);
}

// Markup whose comments were stripped is put back by `remark.js`, loaded only when an element
// meets such markup (see connectedCallback).
let remarker = null; // the module, once loaded
let remarking = null; // its import
const loadRemark = () => (remarking ??= import('./remark.js').then(
  (module) => (remarker = module),
  () => (remarker = { remark: () => false }),
));
/** Whether `root`'s server markup lost the comments `template` has (its top-level elements are there). */
function lostComments(root, template) {
  if (!root || !hasContent(root) || !hasComment(template) || hasComment(root)) return false;
  // The page's own children for a slot aren't server markup: the template's top-level elements
  // must be there, in order.
  const children = [...root.children];
  let at = 0;
  for (const node of positions(template.firstChild, null)) {
    if (node.nodeType !== 1) continue;
    while (at < children.length && children[at].localName !== node.localName) at++;
    if (at++ >= children.length) return false;
  }
  return true;
}

/** A range's shape: its top-level positions as tag names and region markers. */
const hasComment = (root) =>
  !!document.createTreeWalker(root, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION).nextNode();
const signature = (range) =>
  [...positions(range.first, range.stop)]
    .map((node) => (node.nodeType === 1 ? node.localName : isOpen(node) ? '[' : '#'))
    .join(' ');

// ---- binding parts -------------------------------------------------------------------------

// ---- event helpers: the modifiers, as functions (for JSX, and for handlers built in scripts) --

/**
 * `function X({ value = model(0) })` in a JSX component marks `value` as two-way (like
 * `value:model={0}` in `.zb`). The compiler reads it; at runtime it's just the default.
 */
export const model = (value) => value;

/** `prevent(fn)`: a handler that calls `event.preventDefault()` first. */
export const prevent = (fn) => function (event) { event.preventDefault(); return fn?.call(this, event); };
/** `stop(fn)`: a handler that calls `event.stopPropagation()` first. */
export const stop = (fn) => function (event) { event.stopPropagation(); return fn?.call(this, event); };
/** `selfOnly(fn)`: a handler that ignores events from inside the element (`.self`). */
export const selfOnly = (fn) => function (event) { if (event.target === event.currentTarget) return fn?.call(this, event); };
/** `submit(fn)`: after the handler, submit the element's form, with validation (`.submit`). */
export const submit = (fn) => function (event) {
  const result = fn?.call(this, event);
  formOf(event.currentTarget)?.requestSubmit();
  return result;
};
const formOf = (node) => node.form ?? node.closest('form') ?? node.getRootNode().host?.form;

const KEY_NAMES = {
  enter: 'Enter', tab: 'Tab', space: ' ', esc: 'Escape', escape: 'Escape', up: 'ArrowUp', down: 'ArrowDown',
  left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight', delete: 'Delete', backspace: 'Backspace', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};
/**
 * `keys('shift+enter', fn)`: a keyboard handler for one key, with exactly the modifier keys named
 * (the same rule as `onkeydown.shift.enter` in a template). Several combinations: `'enter, space'`.
 */
export function keys(combinations, fn) {
  const wanted = String(combinations).split(',').map((combination) => {
    const pieces = combination.trim().toLowerCase().split('+');
    const key = pieces.pop();
    // `mod` is ⌘ on Apple platforms and Ctrl elsewhere.
    const mod = pieces.includes('mod');
    return { key: KEY_NAMES[key] ?? key, shift: pieces.includes('shift'), ctrl: pieces.includes('ctrl') || (mod && !APPLE()), alt: pieces.includes('alt'), meta: pieces.includes('meta') || (mod && APPLE()) };
  });
  return function (event) {
    const key = event.key ?? '';
    const match = wanted.some((w) => (w.key.length === 1 ? key.toLowerCase() === w.key : key === w.key)
      && w.shift === event.shiftKey && w.ctrl === event.ctrlKey && w.alt === event.altKey && w.meta === event.metaKey);
    if (match) return fn?.call(this, event);
  };
}

let apple;
const APPLE = () => (apple ??= /mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? ''));

/**
 * An event part's listener and its options: the handler, read when the event fires, behind the
 * modifiers' checks (`.self`, key filters) and effects (`.prevent`, `.stop`).
 */
function listen(part, node) {
  const m = part.modifiers;
  // `.mod` is ⌘ on Apple platforms and Ctrl elsewhere.
  const ctrl = m && (m.ctrl || (m.mod && !APPLE()));
  const meta = m && (m.meta || (m.mod && APPLE()));
  const listener = (event) => {
    if (m) {
      if (m.self && event.target !== node) return;
      if (m.keys) {
        const key = event.key ?? '';
        if (!m.keys.some((wanted) => (wanted.length === 1 ? key.toLowerCase() === wanted : key === wanted))) return;
        // With a key, the named modifier keys must be held and the others not.
        if (!!m.shift !== event.shiftKey || !!ctrl !== event.ctrlKey || !!m.alt !== event.altKey || !!meta !== event.metaKey) return;
      } else if ((m.shift && !event.shiftKey) || (ctrl && !event.ctrlKey) || (m.alt && !event.altKey) || (meta && !event.metaKey)) {
        return;
      }
      if (m.prevent) event.preventDefault();
      if (m.stop) event.stopPropagation();
    }
    const handler = $r(part.handler());
    if (typeof handler === 'function') handler.call(node, event);
    // `.submit`: the form the element belongs to (or, in a shadow root, the host's form).
    if (m?.submit) formOf(node)?.requestSubmit();
  };
  const options = m && (m.once || m.capture || m.passive)
    ? { once: !!m.once, capture: !!m.capture, passive: !!m.passive }
    : undefined;
  return [listener, options];
}

function bind(part, node, hydrating, context) {
  // @dev
  // The effects created here are this part's (for the DevTools hook, devtools.js).
  const outerLabel = devEffects.label;
  devEffects.label = { part, node };
  if (part.on && !part.global) devListened(part, node);
  // @dev-end
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
  } else if (part.global) {
    // <zb-window>/<zb-document>: listening while this part of the template is rendered.
    const target = part.global === 'window' ? window : document;
    effect(() => {
      const [listener, options] = listen(part, target);
      target.addEventListener(part.on, listener, options);
      return () => target.removeEventListener(part.on, listener, options);
    });
  } else if (part.on) {
    // The handler is read when the event fires, so swapping it never re-subscribes.
    const [listener, options] = listen(part, node);
    node.addEventListener(part.on, listener, options);
  } else if (part.bind) {
    // A part whose code lives in its own entry (`{...spread}`: @zubra/runtime/spread), so
    // components that don't use it don't load it.
    part.bind(part, node);
  } else if (part.classes) {
    // A computed class beside class: toggles: token by token, leaving the toggles' alone.
    let previous = [];
    effect(() => {
      const next = String($r(part.classes()) ?? '').split(/\s+/).filter(Boolean);
      for (const token of previous) if (!next.includes(token)) node.classList.remove(token);
      for (const token of next) node.classList.add(token);
      previous = next;
    });
  } else if (part.toggle) {
    effect(() => {
      node.classList.toggle(part.toggle, !!$r(part.value()));
    });
  } else if (part.style) {
    // One property at a time, through the CSSOM: a value can't add declarations.
    effect(() => {
      const value = $r(part.value());
      if (value == null || value === false) node.style.removeProperty(part.style);
      else if (node.style.getPropertyValue(part.style) !== String(value)) node.style.setProperty(part.style, String(value));
    });
  } else if (part.ref) {
    effect(() => {
      const assign = $r(part.ref());
      if (typeof assign !== 'function') return;
      untrack(() => assign(node));
      return () => untrack(() => assign(null));
    });
  } else if (part.property) {
    // A child component's prop: always a property, so objects and arrays arrive as they are.
    effect(() => {
      node[part.property] = $r(part.value());
    });
  } else if (part.attribute) {
    bindAttribute(part, node);
  } else if (part.when) {
    bindWhen(part, node, hydrating, context);
  } else if (part.await) {
    bindAwait(part, node, hydrating, context);
  } else if (part.each) {
    bindEach(part, node, hydrating, context);
  } else if (part.slot) {
    bindSlot(part, node, hydrating, context);
  }
  // @dev
  devEffects.label = outerLabel;
  // @dev-end
}

/** The signal saying whether slot `name` has content (shared by hasSlot() and the slot). */
function filledSignal(filled, name) {
  let signal = filled.get(name);
  if (!signal) filled.set(name, (signal = new Signal.State(false)));
  return signal;
}

/**
 * Whether content was given for slot `name` (`'default'` for the default slot), as a signal that
 * follows the content: for wrapping a slot in markup only when it's used.
 *
 *   const hasFooter = hasSlot('footer')
 *   <zb-if test={hasFooter}><footer><zb-slot name="footer"></zb-slot></footer></zb-if>
 */
export function hasSlot(name = 'default') {
  return filledSignal(hooks('hasSlot').filled, name);
}

/**
 * zb-slot in light DOM: the host's own children for this slot, moved in once at startup, or the
 * fallback block. The provided nodes are kept, so a slot inside an zb-if branch gets them back
 * when the branch comes back.
 */
function bindSlot(part, open, hydrating, context) {
  const close = matchingClose(open);
  const slot = slotRecord(context, part.slot);
  if (hydrating && marker(open) === '[!' && !slot.nodes.length) {
    // The server already put supplied content here.
    for (let node = open.nextSibling; node !== close; node = node.nextSibling) slot.nodes.push(node);
  }
  const holder = scope(); // owns the fallback while it shows
  let fallback = null;
  let first = hydrating;
  const region = {
    open,
    close,
    provided: false,
    update() {
      const hydrate = first;
      first = false;
      region.provided = slot.nodes.some(isContent);
      if (region.provided) {
        if (fallback) { fallback.dispose(); fallback = null; clearBetween(open, close); }
        setMarker(open, '[!');
        place(slot.nodes, open, context.slotted);
        return;
      }
      // Only markers and whitespace (a framework's bookkeeping): they wait in the park, where
      // the framework can still add content next to them, while the fallback shows.
      if (slot.nodes.length) slot.park.append(...slot.nodes);
      if (part.fallback) {
        if (fallback) return;
        if (!hydrate || marker(open) !== '[') clearBetween(open, close);
        setMarker(open, '[');
        fallback = holder.run(() => scope(() => mountBlock(part.fallback, [], open, close, hydrate, context)));
      } else {
        clearBetween(open, close);
        setMarker(open, '[');
      }
    },
  };
  // The region exists while this effect does (an zb-if branch switching away disposes it):
  // then the slotted nodes are parked, to come back when the branch does.
  effect(() => {
    slot.region = region;
    return () => {
      if (slot.region !== region) return;
      slot.region = null;
      slot.park.append(...slot.nodes);
      holder.dispose();
    };
  });
  region.update();
}

// ---- slotted content (light DOM) -------------------------------------------------------------
//
// In light DOM the host's children are the template, so content given to the element lives in
// its slot regions instead. Frameworks keep managing that content through the host — React
// calls host.insertBefore(node, sibling) and host.removeChild(node), Vue sets textContent — so
// the host's child methods are routed to the slots, and a MutationObserver notices content
// removed through its real parent. Each slot keeps its nodes in order; while its region isn't
// rendered (inside an zb-if branch that's off) they're parked in a fragment.

function slotRecord(context, name) {
  let slot = context.slots.get(name);
  if (!slot) {
    slot = { name, nodes: [], region: null, park: document.createDocumentFragment(), filled: filledSignal(context.filled, name) };
    context.slots.set(name, slot);
    context.observer?.observe(slot.park, { childList: true });
  }
  return slot;
}

/**
 * Put `nodes` right after `open`, in order, moving only what's out of place. (Anything that left
 * the slot was removed from the region as it left, so nothing else is there.)
 */
function place(nodes, open, tag) {
  const parent = open.parentNode;
  let cursor = open.nextSibling;
  for (const node of nodes) {
    mark(node, tag);
    if (node === cursor) cursor = cursor.nextSibling;
    else move(parent, node, cursor);
  }
}

// The native methods: a light-DOM host routes its own insertBefore to its slots (for content a
// framework adds), and a row of its own list isn't such content.
const nativeMoveBefore = typeof Element !== 'undefined' ? Element.prototype.moveBefore : undefined;
function move(parent, node, before) {
  try {
    if (nativeMoveBefore && node.isConnected && parent.isConnected) return nativeMoveBefore.call(parent, node, before);
  } catch { /* not movable atomically (different document, …): insert instead */ }
  Node.prototype.insertBefore.call(parent, node, before);
}

const slotName = (node) => (node.nodeType === 1 && node.getAttribute('slot')) || 'default';
/** An element or non-blank text: what fills a slot (comments and whitespace don't). */
const isContent = (node) => node.nodeType === 1 || (node.nodeType === TEXT && node.data.trim() !== '');

/**
 * The slot for each of `nodes` (an element's children, in order). Comments and whitespace are
 * frameworks' markers (Lit's parts, Svelte's anchors): a comment goes with the content after it
 * and whitespace with the content before it, so a framework's range stays together in one slot.
 * Empty text nodes come in pairs (Vue brackets each fragment, a v-for, with two): both go with
 * the content between them, since Vue moves that content through the start anchor's parent.
 */
function assignSlots(nodes) {
  const named = nodes.map((node) => (isContent(node) ? slotName(node) : null));
  // The slot of the nearest content after (step 1) or before (step -1) node i.
  const near = (i, step) => { for (let j = i + step; nodes[j]; j += step) if (named[j]) return named[j]; return null; };
  // An empty text node right before content opens a range; otherwise it closes the last one,
  // and both take the slot of the first content between them.
  const open = [];
  nodes.forEach((node, i) => {
    if (node.nodeType !== TEXT || node.data) return;
    if (!open.length || named[i + 1] && nodes[i + 1].data == null) return open.push(i);
    const start = open.pop();
    named[start] = named[i] = named.slice(start + 1, i).find(Boolean);
  });
  return nodes.map((node, i) => named[i]
    ?? (node.nodeType === COMMENT ? near(i, 1) ?? near(i, -1) : near(i, -1) ?? near(i, 1))
    ?? 'default');
}
let nativeText, nativeHTML; // looked up on first use, so the module loads without a DOM

const ROUTED = ['insertBefore', 'appendChild', 'append', 'removeChild', 'replaceChild', 'replaceChildren', 'textContent', 'innerHTML'];

/** Route the host's child methods to its slots (see above). */
function routeChildren(host, context, slots, tag) {
  const holding = (node) => {
    for (const slot of context.slots.values()) if (slot.nodes.includes(node)) return slot;
    return null;
  };
  // Drop content that left through its real parent (or was moved elsewhere), except `keep`,
  // which is arriving now.
  const prune = (slot, keep) => {
    const home = slot.region?.provided ? slot.region.open.parentNode : slot.park;
    const kept = slot.nodes.filter((node) => node === keep || node.parentNode === home);
    for (const node of slot.nodes) if (!kept.includes(node)) unmark(node, context.slotted);
    const changed = kept.length !== slot.nodes.length;
    slot.nodes = kept;
    return changed;
  };
  const show = (slot, keep) => {
    prune(slot, keep);
    slot.filled.set(slot.nodes.some(isContent));
    if (slot.region) slot.region.update();
    else slot.park.append(...slot.nodes);
  };
  const take = (node) => {
    const slot = holding(node);
    if (slot) slot.nodes.splice(slot.nodes.indexOf(node), 1);
    return slot;
  };
  const insert = (node, before) => {
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) insert(child, before);
      return;
    }
    const from = take(node);
    // A marker or whitespace goes in the slot of what it's inserted before.
    const name = isContent(node) ? slotName(node) : (before && holding(before)?.name) || 'default';
    if (!slots.includes(name) && isContent(node)) console.warn(`zubra: <${tag}> has no slot named "${name}"; that content is not shown${see('slots')}`);
    const slot = slotRecord(context, name);
    const at = before ? slot.nodes.indexOf(before) : -1;
    if (at >= 0) slot.nodes.splice(at, 0, node);
    else slot.nodes.push(node);
    if (from && from !== slot) show(from);
    show(slot, node);
  };
  const remove = (node) => {
    const slot = take(node);
    if (!slot) return false;
    unmark(node, context.slotted);
    node.remove();
    show(slot);
    return true;
  };
  const clear = () => {
    for (const slot of context.slots.values()) {
      for (const node of slot.nodes.splice(0)) {
        unmark(node, context.slotted);
        node.remove();
      }
      show(slot);
    }
  };
  const asNodes = (items) => items.map((item) => (item instanceof Node ? item : document.createTextNode(String(item))));
  Object.defineProperties(host, {
    insertBefore: { value(node, before) { insert(node, before ?? null); return node; }, configurable: true },
    appendChild: { value(node) { insert(node, null); return node; }, configurable: true },
    append: { value(...items) { for (const node of asNodes(items)) insert(node, null); }, configurable: true },
    removeChild: {
      value(node) {
        if (!remove(node)) Node.prototype.removeChild.call(host, node); // throws as natively
        return node;
      },
      configurable: true,
    },
    replaceChild: {
      value(node, old) {
        if (!holding(old)) return Node.prototype.replaceChild.call(host, node, old);
        insert(node, old);
        remove(old);
        return old;
      },
      configurable: true,
    },
    replaceChildren: { value(...items) { clear(); for (const node of asNodes(items)) insert(node, null); }, configurable: true },
    textContent: {
      get() { return (nativeText ??= Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')).get.call(host); },
      set(value) { clear(); if (value != null && value !== '') insert(document.createTextNode(String(value)), null); },
      configurable: true,
    },
    innerHTML: {
      get() { return (nativeHTML ??= Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')).get.call(host); },
      set(value) {
        clear();
        const template = document.createElement('template');
        template.innerHTML = value;
        insert(document.importNode(template.content, true), null);
      },
      configurable: true,
    },
  });

  // Content removed or moved away through its real parent (Vue removes via child.parentNode),
  // and content whose `slot` attribute changed (it moves to that slot, as with native slots).
  context.observer = new MutationObserver((records) => {
    for (const record of records) {
      const slot = record.type === 'attributes' && holding(record.target);
      if (slot && slotName(record.target) !== slot.name) insert(record.target, null);
    }
    // Each slot's nodes are what's actually in it: frameworks also insert and remove content
    // next to their own markers there, without going through the host.
    for (const slot of context.slots.values()) {
      let actual;
      if (slot.region?.provided) {
        actual = [];
        for (let node = slot.region.open.nextSibling; node && node !== slot.region.close; node = node.nextSibling) actual.push(node);
      } else {
        actual = [...slot.park.childNodes];
      }
      if (actual.length === slot.nodes.length && actual.every((node, i) => node === slot.nodes[i])) continue;
      for (const node of slot.nodes) if (!actual.includes(node)) unmark(node, context.slotted);
      slot.nodes = actual;
      // An element that belongs to another slot (added next to a marker here) goes there.
      for (const node of actual) if (node.nodeType === 1 && slotName(node) !== slot.name) insert(node, null);
      show(slot);
    }
    // Content a parent adds inside a slot itself (its zb-if or zb-each there) is slotted too;
    // a fallback showing there is the component's own, so it stays unmarked.
    if (context.slotted) {
      for (const slot of context.slots.values()) {
        if (!slot.region?.provided) continue;
        for (let node = slot.region.open.nextSibling; node && node !== slot.region.close; node = node.nextSibling) {
          mark(node, context.slotted);
        }
      }
    }
  });
  context.observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['slot'] });
  for (const slot of context.slots.values()) context.observer.observe(slot.park, { childList: true });
}

// Form controls' live state: bound as properties, so `value={draft}` keeps up with typing and
// `checked={done}` with clicks.
const LIVE = new Set(['input.value', 'textarea.value', 'select.value', 'input.checked', 'option.selected']);

function bindAttribute(part, node) {
  const name = part.attribute;
  // For live state: the last value written, so the property is written only when the bound
  // value changes (what the user typed stays until then).
  let written;
  effect(() => {
    const value = $r(part.value());
    // Another library's custom element: a property when it has one (React 19's rule).
    if (part.prop && part.prop in node) {
      node[part.prop] = value;
      return;
    }
    if (part.boolean) {
      if (typeof value !== 'boolean') {
        console.error(`zubra: "${name}" is a boolean attribute; got`, value);
        return;
      }
      // A control's live state is its property (the attribute is only the default once the
      // user has touched it).
      if (LIVE.has(`${node.localName}.${name}`)) {
        if (value !== written) node[name] = written = value;
        return;
      }
      node.toggleAttribute(name, value);
      return;
    }
    if (LIVE.has(`${node.localName}.${name}`)) {
      const text = value == null ? '' : String(value);
      if (text !== written) {
        // Unchanged text isn't written: that would move the caret and lose a selection.
        if (node[name] !== text) node[name] = text;
        written = text;
        // A <select>'s options may come from a list inside it that renders after this part:
        // until the option exists the value doesn't take, so set it again once they're there.
        if (node.localName === 'select' && node.value !== text) {
          queueMicrotask(() => {
            if (written === text && node.value !== text) node.value = text;
          });
        }
      }
      return;
    }
    if (value == null) return node.removeAttribute(name);
    if (typeof value === 'object' && !part.prop) {
      console.error(`zubra: cannot write an object to the "${name}" attribute`, value);
      return node.removeAttribute(name);
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // No URL yet (a prop's "" default, before the app sets it): no attribute, and nothing to report.
    if (part.url && text.trim() === '') return node.removeAttribute(name);
    if (part.srcset && text.trim() === '') return node.removeAttribute(name);
    if (part.srcset && !isSafeSrcset(text)) {
      console.error(`zubra: blocked an unsafe URL in "${name}"${see('safety')}:`, text);
      return node.removeAttribute(name);
    }
    if (part.url && !isSafeUrl(text)) {
      console.error(`zubra: blocked an unsafe URL in "${name}"${see('safety')}:`, text);
      return node.removeAttribute(name);
    }
    if (node.getAttribute(name) !== text) node.setAttribute(name, text);
  });
}

/** zb-if: re-render only when the chosen branch changes, not whenever the test re-runs. */
function bindWhen(part, open, hydrating, context) {
  hydrating = hydratable(open, hydrating);
  const close = matchingClose(open);
  const branch = new Signal.Computed(() => ($r(part.when()) ? 0 : 1));
  let first = hydrating;
  effect(() => {
    const block = part.blocks[branch.get()];
    const hydrate = first;
    first = false;
    // Effects created while mounting belong to this effect, so switching branches disposes them.
    untrack(() => {
      if (part.animate && !hydrate) departBetween(open, close, part.animate);
      if (block) mountBlock(block, [], open, close, hydrate, context);
      else clearBetween(open, close);
    });
  });
}

/**
 * zb-await: the pending block while the value is a promise (anything with `then`), then the
 * `zb-then` block with the resolved value, or the `zb-catch` block with the error. A value
 * that isn't a promise shows `zb-then` at once. Only the latest value's outcome is shown. A
 * `resource()` is followed through its states, so reloading it shows the pending content again.
 *
 * - An array value waits for every promise and resource in it, as `Promise.all` does, and
 *   resolves to the array of their values (4.2).
 * - `zb-catch` gets `retry()`: it refreshes the resources and evaluates the value again, so a
 *   `load()` call is made again (4.2).
 * - `delay`: the pending block shows only once the value has been pending that long; until
 *   then the previous content stays (4.2).
 * - `keep`: once settled, a reload keeps the settled content, and the host has
 *   `:state(loading)` while it runs (4.2).
 */
const loadingCounts = new WeakMap();
function markLoading(states, step) {
  if (!states) return;
  const count = (loadingCounts.get(states) ?? 0) + step;
  loadingCounts.set(states, count);
  states[count > 0 ? 'add' : 'delete']('loading');
}
function bindAwait(part, open, hydrating, context) {
  hydrating = hydratable(open, hydrating);
  const close = matchingClose(open);
  let first = hydrating;
  let latest = null;
  let settled = false; // a zb-then or zb-catch block is showing
  const attempt = new Signal.State(0);
  // The value, evaluated again only when what it reads changes or retry() asks: a resource
  // settling re-runs the effect below, and mustn't call `load()` again.
  const current = new Signal.Computed(() => (attempt.get(), $r(part.await())));
  const retry = () => {
    for (const value of [].concat(untrack(() => current.get()))) $r(value)?.[RESOURCE] && $r(value).refresh();
    attempt.set(untrack(() => attempt.get()) + 1);
  };
  effect(() => {
    const value = current.get();
    const many = Array.isArray(value);
    const token = (latest = {});
    // Blocks mounted later (when the promise settles) still belong to this run.
    const owner = scope();
    let timer;
    let loading = 0;
    const show = (index, payload) => untrack(() => owner.run(() => {
      clearTimeout(timer);
      const block = part.blocks[index];
      const hydrate = first; // the server rendered this branch, unless it left the region to us
      first = false;
      settled = index > 0;
      if (block) mountBlock(block, index ? [new Signal.State(payload), new Signal.State(retry)] : [], open, close, hydrate, context);
      else clearBetween(open, close);
    }));
    const done = (index, payload) => {
      if (latest !== token || owner.disposed) return;
      if (loading) markLoading(context?.states, (loading = 0) - 1);
      show(index, payload);
    };
    // Each value: a resource's state, a promise, or a plain value.
    let pending = false;
    let failed;
    const promises = (many ? value : [value]).map((item) => {
      item = $r(item);
      if (item?.[RESOURCE]) {
        const status = item.status;
        if (status === 'error') failed ??= [item.error];
        pending ||= status === 'pending';
        return item.value;
      }
      if (item !== null && (typeof item === 'object' || typeof item === 'function') && typeof item.then === 'function') {
        pending = true;
        return item;
      }
      return item;
    });
    if (failed) done(2, failed[0]);
    else if (pending) {
      const delay = part.delay ? Number(untrack(part.delay)) : 0;
      if (part.keep && settled) markLoading(context?.states, (loading = 1));
      else if (delay > 0 && !first) timer = setTimeout(() => latest === token && !owner.disposed && show(0), delay);
      else show(0);
      // A pending resource re-runs this effect when it settles; promises are waited for here.
      if (!(many ? value : [value]).some((item) => $r(item)?.[RESOURCE] && $r(item).status === 'pending')) {
        Promise.all(promises).then((resolved) => done(1, many ? resolved : resolved[0]), (error) => done(2, error));
      }
    } else done(1, many ? promises : promises[0]);
    return () => {
      clearTimeout(timer);
      if (loading) markLoading(context?.states, -1);
    };
  });
}

/**
 * zb-each: one row per item. Each row holds its item and index as signals, so changing one
 * item updates only that row's parts.
 *
 * - Without a key, rows are matched by position: a new array updates rows in place, and rows are
 *   only created or removed at the end.
 * - With `key={…}`, rows follow their key: reordering moves the existing rows (with whatever DOM
 *   state they have, like a half-typed input), using `moveBefore()` where the browser has it so
 *   focus and iframes survive the move.
 */
function bindEach(part, open, hydrating, context) {
  hydrating = hydratable(open, hydrating);
  const close = matchingClose(open);
  // Rows belong to this scope, not to the effect below, so re-running the effect (the list
  // changed) doesn't dispose them.
  const rowsOwner = scope();
  let rows = [];

  const createRow = (value, index, key, rowOpen, rowClose, hydrateRow) => {
    if (!rowOpen) {
      // A new row is assembled in a fragment, then placed.
      rowOpen = document.createComment('[');
      rowClose = document.createComment(']');
      const fragment = new DocumentFragment();
      fragmentParents.set(fragment, parentOf(open));
      fragment.append(rowOpen, rowClose);
    }
    const item = new Signal.State(value);
    const position = new Signal.State(index);
    const owner = rowsOwner.run(() => scope(() => mountBlock(part.block, [item, position], rowOpen, rowClose, hydrateRow, context)));
    return { key, item, position, open: rowOpen, close: rowClose, owner };
  };
  const nodesOf = (row) => {
    const nodes = [];
    for (let node = row.open; ; node = node.nextSibling) {
      nodes.push(node);
      if (node === row.close) return nodes;
    }
  };
  const removeRow = (row) => {
    row.owner.dispose();
    if (part.animate) part.animate.leave(nodesOf(row), { float: true });
    else for (const node of nodesOf(row)) node.remove();
  };
  const elementsOf = (row) => nodesOf(row).filter((node) => node.nodeType === 1);
  const placeRow = (row, before) => {
    const parent = close.parentNode;
    for (const node of nodesOf(row)) move(parent, node, before);
  };
  const keysOf = (list) => {
    const seen = new Set();
    return list.map((value, index) => {
      let key = part.key(value, index);
      if (seen.has(key)) {
        console.error('zubra: duplicate zb-each key', key, `(row ${index + 1}); that row is not keyed${see('directives')}`);
        key = Symbol('duplicate');
      }
      seen.add(key);
      return key;
    });
  };

  let first = hydrating;
  effect(() => {
    let list = $r(part.each());
    if (!Array.isArray(list)) {
      if (list != null) console.error('zubra: zb-each items must be an array; got', list);
      list = [];
    }
    // Reactive state (deep.js) tracks by property: reading the length and each index here means
    // `items.push(x)`, `items.splice(…)` and `items[i] = x` re-run this effect.
    for (let index = 0, { length } = list; index < length; index++) list[index];
    const hydrate = first;
    first = false;
    untrack(() => {
      const keys = part.key ? keysOf(list) : null;
      if (hydrate) {
        const existing = [...positions(open.nextSibling, close)];
        if (existing.length === list.length && existing.every(isOpen)) {
          rows = existing.map((rowOpen, index) =>
            createRow(list[index], index, keys?.[index], rowOpen, matchingClose(rowOpen), true));
          return;
        }
        console.warn(`zubra: server markup for a list does not match its items; rendering it fresh${see('server-rendering-and-hydration')}`);
        clearBetween(open, close);
      }

      if (!keys) {
        const shared = Math.min(rows.length, list.length);
        for (let index = 0; index < shared; index++) {
          rows[index].item.set(list[index]);
          rows[index].position.set(index);
        }
        if (rows.length < list.length) {
          const fragment = new DocumentFragment();
          for (let index = rows.length; index < list.length; index++) {
            const row = createRow(list[index], index);
            fragment.append(...nodesOf(row));
            rows.push(row);
          }
          close.before(fragment);
        }
        if (!list.length && rows.length) {
          batch(() => { for (const row of rows) row.owner.dispose(); });
          deleteBetween(open, close);
          rows = [];
        }
        batch(() => { for (const row of rows.splice(list.length)) removeRow(row); });
        return;
      }

      // Keyed: reuse the row for each key, create the missing ones, drop the rest, then walk the
      // new order and move only rows that aren't already where they belong.
      const byKey = new Map(rows.map((row) => [row.key, row]));
      // Nothing reused (cleared, or replaced wholesale): drop every row at once, then build the
      // new ones in one fragment and insert it once.
      if (!part.animate && rows.length && !keys.some((key) => byKey.has(key))) {
        batch(() => { for (const row of rows) row.owner.dispose(); });
        deleteBetween(open, close);
        rows = [];
        byKey.clear();
      }
      if (!rows.length) {
        const fragment = new DocumentFragment();
        rows = list.map((value, index) => {
          const row = createRow(value, index, keys[index]);
          fragment.append(...nodesOf(row));
          return row;
        });
        close.before(fragment);
        return;
      }
      // `animate`: the rows that stay glide from where they were (@zubra/runtime/motion).
      const reorder = () => {
        const next = list.map((value, index) => {
          const row = byKey.get(keys[index]);
          if (!row) return createRow(value, index, keys[index]);
          byKey.delete(keys[index]);
          row.item.set(value);
          row.position.set(index);
          return row;
        });
        batch(() => { for (const row of byKey.values()) removeRow(row); });
        // Text between rows, and rows on their way out, aren't rows to place against.
        const skip = (node) => node && (node.nodeType === TEXT || part.animate?.isLeaving(node));
        let at = open.nextSibling;
        while (skip(at)) at = at.nextSibling;
        for (const row of next) {
          if (row.open === at) {
            at = row.close.nextSibling;
            while (skip(at)) at = at.nextSibling;
            continue;
          }
          placeRow(row, at ?? close);
        }
        rows = next;
      };
      if (part.animate) part.animate.glide(rows.flatMap(elementsOf), reorder);
      else reorder();
    });
  });
}

const hasContent = (root) =>
  [...root.childNodes].some((node) => node.nodeType !== TEXT || node.data.trim() !== '');

// ---- define --------------------------------------------------------------------------------

const fired = new WeakMap(); // event → the component that dispatched it

// ---- styles --------------------------------------------------------------------------------
//
// A component's stylesheet is one constructed CSSStyleSheet shared by every instance: adopted
// by each shadow root of a shadow component, and, for a light-DOM component, by the document (or
// the shadow root it lives in). `adoptStyles()` adds app-wide sheets — Tailwind's output, a
// design system — to every zubra shadow root, since page CSS doesn't reach inside them.

const globalSheets = [];
const shadowRoots = new Set(); // WeakRef<ShadowRoot>
const adopted = new WeakMap(); // Document | ShadowRoot → Set<CSSStyleSheet>

function toSheet(css) {
  if (css instanceof CSSStyleSheet) return css;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(String(css));
  return sheet;
}

function adopt(root, sheets) {
  let has = adopted.get(root);
  if (!has) adopted.set(root, (has = new Set()));
  const added = sheets.filter((sheet) => !has.has(sheet));
  for (const sheet of added) has.add(sheet);
  if (added.length) root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...added];
}

/**
 * Add stylesheets (CSS text or `CSSStyleSheet`s) to every zubra shadow root, now and later — for
 * app-wide CSS such as Tailwind's output, which page styles can't carry into shadow DOM.
 * Light-DOM components already get page CSS. Returns the sheets.
 */
export function adoptStyles(...styles) {
  const sheets = styles.map(toSheet);
  globalSheets.push(...sheets);
  for (const ref of [...shadowRoots]) {
    const root = ref.deref();
    if (root) adopt(root, sheets);
    else shadowRoots.delete(ref);
  }
  return sheets;
}

/** The attribute that marks content slotted into a styled light-DOM component (value: its tag). */
const SLOTTED = 'data-zb-slotted';
const unmark = (node, tag) => {
  if (tag && node.nodeType === 1 && node.getAttribute(SLOTTED) === tag) node.removeAttribute(SLOTTED);
};
const mark = (node, tag) => {
  if (tag && node.nodeType === 1 && node.getAttribute(SLOTTED) !== tag) node.setAttribute(SLOTTED, tag);
};

/** What adapters and tools need: the tag, each prop's attribute and default, the events. */
function describe(tag, { props, shadow, form, slots, events, styled }) {
  return Object.freeze({
    tag,
    props: Object.freeze(Object.fromEntries(Object.entries(props).map(([name, spec]) =>
      [name, Object.freeze({ attribute: spec.attribute, default: spec.default, required: !!spec.required, model: !!spec.model })]))),
    events: Object.freeze([...events]),
    slots: Object.freeze([...slots]),
    shadow,
    form,
    styled,
  });
}

const serverElements = new Map();
function serverElement(tag, options) {
  if (!serverElements.has(tag)) {
    serverElements.set(tag, class ZubraServerElement {
      static zubra = describe(tag, options);
      constructor() { throw new TypeError(`zubra: <${tag}> can't be created without a DOM`); }
    });
  }
  return serverElements.get(tag);
}

/**
 * Register a compiled component. `props` maps prop names to `{ attribute, default, required }`;
 * `template` is the element's inner HTML with dynamic parts left empty; `setup($p)` runs the
 * component's script once per element and returns its parts.
 */
/**
 * The version of the compiled-code interface: what `$define()`'s arguments and parts mean, and the
 * server markup they hydrate. 3 (5.0) is 2 with processing-instruction markers; this runtime reads
 * 2's comment markers too, so modules compiled by 3.x and 4.x still run.
 */
export const ABI = 3;
const READS = [2, 3];

/**
 * What modules compiled for runtime 1.x call. Their compiled shape differs, so they're refused
 * with a clear message instead of misbehaving.
 */
export function define(tag) {
  throw new Error(`zubra: <${tag}> was compiled for @zubra/runtime 1.x; recompile it with zubra 2 (the CLI, @zubra/compiler or @zubra/unplugin)`);
}

/** @internal Register a compiled component: what the compiler's JavaScript output calls. */
export function $define(tag, definition) {
  if (!READS.includes(definition?.abi)) {
    throw new Error(`zubra: <${tag}> was compiled for a different @zubra/runtime (interface ${definition?.abi ?? 1}, this runtime is ${ABI}); recompile it with the matching zubra`);
  }
  return defineElement(tag, definition);
}

// @hot (left out of the production build: scripts/build-production.js)
/** What a hot reload can't change without a full page reload: the element's interface. */
const shape = ({ props = {}, shadow = false, form = false, events = [], styled = false, inPage = false }) => JSON.stringify([props, shadow, form, events, styled, inPage]);
const HOT = Symbol('zubra.hot');
// @hot-end

function defineElement(tag, definition) {
  const { props = {}, shadow = false, form = false, events = [], styled = false, inPage = false } = definition;
  let { template = '', slots = [], styles = null, setup } = definition;
  // On a server (no DOM), a stand-in with the same `zubra` description, so a module that imports a
  // component loads there: adapters render the host tag, and `@zubra/runtime/server` renders it.
  if (typeof HTMLElement === 'undefined') return serverElement(tag, { props, shadow, form, slots, events, styled });
  let sheet; // created on first use, so define() needs no document
  const ownSheets = () => (styles == null ? [] : [(sheet ??= toSheet(styles))]);
  const existing = customElements.get(tag);
  if (existing) {
    // @hot (left out of the production build: scripts/build-production.js)
    // The same tag again: in development (with hot module replacement), a new version of the
    // component, swapped into the live elements; otherwise the first definition stands.
    if (globalThis.__ZUBRA_HOT__ && existing[HOT]) existing.hotReloaded = existing[HOT](definition);
    // @hot-end
    return existing;
  }
  const componentTemplate = { content: blueprint({ template }) };
  let templateSignature = signature(childRange(componentTemplate.content));
  let instances = 0;
  // @hot (left out of the production build: scripts/build-production.js)
  const live = new Set(); // WeakRefs to the elements, kept only for hot reloads
  // @hot-end
  const byAttribute = Object.fromEntries(Object.entries(props).map(([name, spec]) => [spec.attribute, name]));
  // HTML lowercases attribute names, so `maxValue` in a page arrives as `maxvalue`, which isn't
  // the prop's attribute (`max-value`): the element would ignore it without a word.
  const lowercased = Object.entries(props)
    .filter(([name, spec]) => name !== name.toLowerCase() && spec.attribute !== name.toLowerCase())
    .map(([name, spec]) => [name.toLowerCase(), name, spec.attribute]);
  const checkAttributeCase = (element) => {
    for (const [lower, name, attribute] of lowercased) {
      if (element.hasAttribute(lower) && !element.hasAttribute(attribute)) {
        console.warn(`zubra: <${tag}> ignores the attribute "${lower}": HTML lowercases attribute names, and the prop ${name} is the attribute "${attribute}"${see('writing-a-component')}`);
      }
    }
  };

  let internals; // (element) => its ElementInternals; set in the static block below
  class ZubraElement extends HTMLElement {
    static observedAttributes = Object.keys(byAttribute);
    static zubra = describe(tag, { props, shadow, form, slots, events, styled });
    static formAssociated = form;
    static { internals = (element) => element.#internals; }
    // @hot
    /** Swap in a new version of the component (see above); false if its interface changed. */
    static [HOT](next) {
      if (shape(next) !== shape(definition)) return false;
      ({ template = '', slots = [], setup } = next);
      componentTemplate.content = blueprint({ template });
      templateSignature = signature(childRange(componentTemplate.content));
      const nextStyles = next.styles ?? null;
      if (nextStyles !== styles) {
        styles = nextStyles;
        sheet?.replaceSync(styles ?? '');
      }
      for (const ref of [...live]) {
        const element = ref.deref();
        if (element) element.#reload();
        else live.delete(ref);
      }
      return true;
    }
    // @hot-end
    #context = null;
    #signals = {};
    #given = new Set(); // props set from outside (property, attribute, or before upgrade)
    #scope = null;
    #hooks = null;
    #cleanups = [];
    #internals = null; // form-associated only
    #states = null; // the custom states (CustomStateSet), for :state(hydrated)
    #disabled = false;

    static {
      for (const name of Object.keys(props)) {
        Object.defineProperty(this.prototype, name, {
          get() { return this.#signals[name].get(); },
          set(value) { this.#given.add(name); this.#signals[name].set(value); },
          configurable: true,
          enumerable: true,
        });
      }
    }

    constructor() {
      super();
      const internals = this.attachInternals();
      if (form) this.#internals = internals;
      this.#states = internals.states ?? null;
      // An event the component fires is its own: an inner element's event of the same name
      // (a native `change` bubbling out of light DOM, a nested component's `valuechange`) stops
      // here, so listeners outside see only the component's, as with a built-in element.
      for (const name of events) {
        this.addEventListener(name, (event) => {
          if (fired.get(event) !== this) event.stopImmediatePropagation();
        });
      }
      for (const [name, spec] of Object.entries(props)) {
        this.#signals[name] = new Signal.State(clone(spec.default));
        // A framework may have set the property before the element was defined; that landed
        // as an own property shadowing the accessor. Take it over.
        if (Object.hasOwn(this, name)) {
          const value = this[name];
          delete this[name];
          this.#given.add(name);
          this.#signals[name].set(value);
        }
      }
    }

    attributeChangedCallback(attribute, _old, value) {
      const name = byAttribute[attribute];
      this[name] = parseAttribute(props[name], value);
    }

    connectedCallback() {
      // A light-DOM component's styles go where it is: the document, or a shadow root.
      if (!shadow && styles != null) {
        // A light-DOM component's sheet goes to the root it's in, unless the bundler already put
        // it in the page (`inPage`) and that root is the document.
        // (A callback can run after the element was moved out again: then the root is a detached
        // tree, which has no stylesheets of its own.)
        const root = this.getRootNode();
        if (root.adoptedStyleSheets && !(inPage && root === document)) adopt(root, ownSheets());
      }
      if (this.#scope) this.#scope.resume();
      else if (!remarker && lostComments(shadow ? this.shadowRoot : this, componentTemplate.content)) {
        // Server markup without its comments: start once the code that puts them back is here.
        loadRemark().then(() => { if (this.isConnected && !this.#scope) this.connectedCallback(); });
        return;
      } else {
        if (lowercased.length) checkAttributeCase(this);
        this.#boot();
      }
      this.#cleanups = this.#hooks.mount.map((fn) => fn()).filter((cleanup) => typeof cleanup === 'function');
      this.#started();
    }

    /** The element is live: hydrated() turns true, and the host gets :state(hydrated). */
    #started() {
      this.#hooks.hydrated.set(true);
      this.#states?.add('hydrated');
    }

    disconnectedCallback() {
      if (!this.#scope) return; // (not started: waiting for remark.js)
      for (const cleanup of this.#cleanups.splice(0)) cleanup();
      for (const fn of this.#hooks.unmount) fn();
      // Paused, not disposed: long-lived signals stop holding this element, and if it comes
      // back only the parts whose inputs changed meanwhile are re-run.
      this.#scope.pause();
    }

    /**
     * Dispatch the component's event. It bubbles (and leaves a shadow root); `before…` events
     * are cancelable, like the platform's. Returns false if a listener called preventDefault().
     */
    #emit(name, detail) {
      const event = new CustomEvent(name, {
        detail, bubbles: true, composed: shadow, cancelable: name.startsWith('before'),
      });
      fired.set(event, this);
      return this.dispatchEvent(event);
    }

    /** Resolves once pending prop changes have reached the DOM. */
    get updateComplete() {
      return tick();
    }

    // Form-associated lifecycle (only called by the browser when `formAssociated` is true).
    formResetCallback() {
      for (const fn of this.#hooks?.formReset ?? []) fn();
    }
    formStateRestoreCallback(state, mode) {
      for (const fn of this.#hooks?.formRestore ?? []) fn(state, mode);
    }
    formDisabledCallback(disabled) {
      this.#disabled = disabled;
      for (const fn of this.#hooks?.formDisabled ?? []) fn(disabled);
    }

    // @hot
    /** Re-run the (new) script and template, keeping props, state and slotted content. */
    #reload() {
      if (!this.#scope) return;
      const connected = this.isConnected;
      if (connected) {
        for (const cleanup of this.#cleanups.splice(0)) cleanup();
        for (const fn of this.#hooks.unmount) fn();
      }
      const kept = this.#hooks.states.map((signal) => untrack(() => signal.get()));
      const slotted = shadow ? [] : [...this.#context.slots.values()].flatMap((slot) => slot.nodes);
      this.#context.observer?.disconnect();
      // The host's child methods are routed to the old slots (see routeChildren); back to native.
      for (const key of ROUTED) delete this[key];
      this.#scope.dispose();
      this.#scope = null;
      if (shadow) this.shadowRoot.replaceChildren();
      else Element.prototype.replaceChildren.call(this, ...slotted);
      this.#boot(kept, true);
      if (connected) {
        this.#cleanups = this.#hooks.mount.map((fn) => fn()).filter((cleanup) => typeof cleanup === 'function');
        this.#started();
      }
    }
    // @hot-end

    #boot(kept = null, reloading = false) {
      const element = this;
      // Props a framework's server rendering wrote as JSON (the adapters' `zb-props`), for
      // starting with them before the framework sets them as properties.
      let given;
      if (!reloading) try { given = JSON.parse(this.getAttribute('zb-props')); } catch {}
      for (const name in given) if (Object.hasOwn(props, name) && !this.#given.has(name)) this[name] = given[name];
      // The server's stand-in for this control's value, for submitting before JavaScript
      // (@zubra/server's injectShadowRoots): the element's own form value takes over now.
      if (form) for (const child of this.querySelectorAll(':scope>input[data-zb-fallback]')) child.remove();
      // @hot (left out of the production build: scripts/build-production.js)
      if (globalThis.__ZUBRA_HOT__ && !reloading) live.add(new WeakRef(this));
      // @hot-end
      const root = shadow ? (this.shadowRoot ?? this.attachShadow({ mode: 'open' })) : this;
      if (shadow) {
        adopt(root, [...globalSheets, ...ownSheets()]);
        shadowRoots.add(new WeakRef(root));
        // The server's copy of the styles, for before this ran; the adopted sheet replaces it.
        const serverStyles = root.firstElementChild;
        if (serverStyles?.localName === 'style' && serverStyles.hasAttribute('data-zubra')) {
          serverStyles.remove();
        }
      }
      const $p = {};
      for (const name of Object.keys(props)) {
        // A two-way prop (`value:model`) fires `<prop>change` when the component assigns it.
        const change = props[name].model ? `${name.toLowerCase()}change` : null;
        Object.defineProperty($p, name, {
          get: () => element.#signals[name].get(),
          set: (value) => {
            const signal = element.#signals[name];
            if (change && Object.is(untrack(() => signal.get()), value)) return;
            signal.set(value);
            if (change) element.#emit(change, value);
          },
          enumerable: true,
        });
      }
      this.#hooks = {
        mount: [], unmount: [], host: this, props: $p, instance: ++instances, ids: 0, filled: new Map(), states: [], kept, hydrated: new Signal.State(false),
        internals: this.#internals, formReset: [], formRestore: [], formDisabled: [],
      };
      // @dev
      let named = null; // the script's signals by name (a --devtools build)
      // @dev-end
      // The element's own root: an effect that inserted it (a list row) doesn't own it, so
      // re-running that effect can't dispose the element's effects.
      this.#scope = rootScope(() => {
        const previous = current;
        current = this.#hooks;
        let parts;
        // A default computed from the script (`count={start}` where `const start = Date.now()`),
        // unless the prop was given.
        const initial = (name, compute) => {
          if (!this.#given.has(name)) this.#signals[name].set(compute());
        };
        // @dev
        // A --devtools build hands over its script's signals by name, for the DevTools hook.
        const dev = (names) => { named = names; };
        // @dev-end
        try {
          parts = setup ? setup($p, (name, detail) => this.#emit(name, detail), initial
            // @dev
            , dev
            // @dev-end
          ) : [];
        } finally { current = previous; }
        // A form control with one two-way prop: that's what it submits, and what a form reset
        // restores, unless the script says otherwise.
        const models = Object.keys(props).filter((name) => props[name].model);
        if (form && models.length === 1) {
          const [name] = models;
          if (!this.#hooks.formValued) {
            effect(() => {
              const value = $p[name];
              this.#internals.setFormValue(value == null || value === false || value === ''
                ? null
                : value === true ? 'on' : typeof value === 'object' ? JSON.stringify(value) : String(value));
            });
          }
          if (!this.#hooks.formReset.length) {
            const initialValue = untrack(() => $p[name]);
            this.#hooks.formReset.push(() => { $p[name] = initialValue; });
          }
        }

        const context = { slots: new Map(), slotted: styled && !shadow ? tag : null, filled: this.#hooks.filled, states: this.#states };
        this.#context = context;
        const server = hasContent(root);
        // Server markup whose comments were stripped: put them back, where the template says.
        const stripped = server && !reloading && hasComment(componentTemplate.content) && !hasComment(root);
        const restored = stripped && !!remarker?.remark(root, componentTemplate.content, parts, { blueprint, isOpen, isClose, read: $r, untrack, State: Signal.State });
        // Server markup has the template's shape; anything else is the page's own children.
        const nodes = server && !reloading && signature(childRange(root)) === templateSignature
          ? locate(childRange(root), parts, true)
          : null;
        if (nodes) {
          parts.forEach((part, index) => bind(part, nodes[index], true, context));
        } else {
          if (server && !shadow && slots.length) {
            // Not server markup: the page's own children for this element, to be slotted.
            const children = [...root.childNodes];
            assignSlots(children).forEach((name, i) => slotRecord(context, name).nodes.push(children[i]));
            for (const [name, slot] of context.slots) {
              if (!slots.includes(name) && slot.nodes.some(isContent)) console.warn(`zubra: <${tag}> has no slot named "${name}"; that content is not shown${see('slots')}`);
            }
          } else if (server) {
            // No comments at all where the template has markers: something stripped them, and
            // they couldn't be put back for sure.
            console.warn(stripped && !restored
              ? `zubra: <${tag}>'s hydration markers (<?zb [?>, <?zb ]?>, …) are missing, so it's rendered fresh. A sanitizer or a fragment parser removed them; keep processing instructions (and comments, for markup from a 4.x server)${see('hydration-markers')}`
              : `zubra: <${tag}>'s markup doesn't match its template; rendering it fresh${see('server-rendering-and-hydration')}`);
          }
          // Find and bind the parts before inserting (see mountBlock).
          const fragment = document.importNode(componentTemplate.content, true);
          const fresh = locate(childRange(fragment), parts);
          parts.forEach((part, index) => bind(part, fresh[index], false, context));
          root.replaceChildren(fragment);
        }
        if (!shadow) {
          // Content for slots that aren't rendered now waits in their park.
          for (const slot of context.slots.values()) {
            if (!slot.region) slot.park.append(...slot.nodes);
            slot.filled.set(slot.nodes.some(isContent));
          }
          routeChildren(this, context, slots, tag);
        } else if (this.#hooks.filled.size) {
          // Shadow DOM: the host's children are assigned by the browser; follow them.
          const follow = () => {
            for (const [name, signal] of this.#hooks.filled) {
              signal.set([...this.childNodes].some((node) => isContent(node) && (node.nodeType === 1 ? (node.getAttribute('slot') ?? 'default') : 'default') === name));
            }
          };
          follow();
          this.#hooks.mount.push(() => {
            follow();
            const observer = new MutationObserver(follow);
            observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ['slot'], characterData: true });
            return () => observer.disconnect();
          });
        }
      });
      // Disabled (e.g. inside a disabled <fieldset>) before setup registered its hooks. Chromium
      // always calls formDisabledCallback after connectedCallback, so this never runs there (the
      // browser tests confirm the behaviour without it); it guards engines that order the
      // callbacks the other way, which the test suite can't currently exercise.
      // @dev
      devRegister(this, { tag, definition, props: this.#signals, named, scope: this.#scope });
      // @dev-end
      if (this.#disabled) for (const fn of this.#hooks.formDisabled) fn(true);
    }
  }

  if (form) {
    // The API native form controls have, backed by ElementInternals.
    const api = {
      form: { get() { return internals(this).form; } },
      validity: { get() { return internals(this).validity; } },
      validationMessage: { get() { return internals(this).validationMessage; } },
      willValidate: { get() { return internals(this).willValidate; } },
      labels: { get() { return internals(this).labels; } },
      checkValidity: { value() { return internals(this).checkValidity(); } },
      reportValidity: { value() { return internals(this).reportValidity(); } },
    };
    if (!('name' in props)) {
      api.name = {
        get() { return this.getAttribute('name'); },
        set(value) { this.setAttribute('name', value); },
      };
    }
    for (const [key, descriptor] of Object.entries(api)) {
      Object.defineProperty(ZubraElement.prototype, key, { ...descriptor, configurable: true });
    }
  }

  customElements.define(tag, ZubraElement);
  return ZubraElement;
}
