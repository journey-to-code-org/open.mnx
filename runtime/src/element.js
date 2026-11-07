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
  throw new Error(`mnx: emit("${name}") is bound to each element by the compiler; outside a compiled component, use the emit that setup() receives`);
}

/**
 * An id unique to this element and call, for `id`/`for`/`aria-*` attributes. Stable for the
 * element's life; based on the host's own `id` when it has one, so it can be made to match
 * server-rendered markup.
 */
export function id() {
  const component = hooks('id');
  const base = component.host.id || `${component.host.localName}-${component.instance}`;
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
    throw new Error(`mnx: ${name}() needs form-associated on the component's host tag`);
  }
  return component;
}

/** What the form submits for this control: follows `source` (a signal, function or value). */
export function formValue(source) {
  const { internals } = formHooks('formValue');
  effect(() => {
    const value = $r(typeof source === 'function' ? source() : source);
    internals.setFormValue(value == null ? null : value instanceof FormData || value instanceof File ? value : String(value));
  });
}

/**
 * Validation: `check()` returns an error message, or '' / null when the value is valid. Re-runs
 * when what it reads changes; the form won't submit while it reports an error.
 */
export function validity(check) {
  const { internals, host } = formHooks('validity');
  effect(() => {
    const message = $r(check());
    if (message) internals.setValidity({ customError: true }, String(message), host);
    else internals.setValidity({});
  });
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
// mnx components share context with any other implementation (Lit's @lit/context, …).

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
  const host = hooks('inject').host;
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
// `<!--[-->` and its matching `<!--]-->`. Within a range, positions count elements and comments
// only, and a whole region counts as one position (its start marker), so a list's length never
// shifts the paths of what comes after it.

// `<!--[!-->` opens a slot region holding supplied content (static, left alone on hydration).
const isOpen = (node) => node.nodeType === COMMENT && (node.data === '[' || node.data === '[!');
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
      : part.when || part.each || part.slot ? isOpen(node) && matchingClose(node) !== null
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
function mountBlock(block, args, open, close, hydrating, context) {
  const parts = block.parts(...args);
  const nodes = hydrating ? locate(regionRange(open, close), parts, true) : null;
  if (nodes) {
    parts.forEach((part, index) => bind(part, nodes[index], true, context));
    return;
  }
  if (hydrating) console.warn('mnx: server markup for a region does not match its template; rendering it fresh');
  clearBetween(open, close);
  // Find and bind the parts in the fragment, then insert it: child components inside see
  // their props from the start, and can't move slotted nodes before they're found.
  // importNode, not cloneNode: defined custom elements upgrade now, so their properties exist
  // before parts bind (a clone stays in the template's inert document).
  const fragment = document.importNode(blueprint(block).content, true);
  const fresh = locate(childRange(fragment), parts);
  parts.forEach((part, index) => bind(part, fresh[index], false, context));
  close.before(fragment);
}

/** A range's shape: its top-level positions as tag names and region markers. */
const signature = (range) =>
  [...positions(range.first, range.stop)]
    .map((node) => (node.nodeType === 1 ? node.localName : isOpen(node) ? '[' : '#'))
    .join(' ');

// ---- binding parts -------------------------------------------------------------------------

function bind(part, node, hydrating, context) {
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
  } else if (part.property) {
    // A child component's prop: always a property, so objects and arrays arrive as they are.
    effect(() => {
      node[part.property] = $r(part.value());
    });
  } else if (part.attribute) {
    bindAttribute(part, node);
  } else if (part.when) {
    bindWhen(part, node, hydrating, context);
  } else if (part.each) {
    bindEach(part, node, hydrating, context);
  } else if (part.slot) {
    bindSlot(part, node, hydrating, context);
  }
}

/**
 * mnx-slot in light DOM: the host's own children for this slot, moved in once at startup, or the
 * fallback block. The provided nodes are kept, so a slot inside an mnx-if branch gets them back
 * when the branch comes back.
 */
function bindSlot(part, open, hydrating, context) {
  const close = matchingClose(open);
  const slot = slotRecord(context, part.slot);
  if (hydrating && open.data === '[!' && !slot.nodes.length) {
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
        open.data = '[!';
        place(slot.nodes, open, context.slotted);
        return;
      }
      // Only markers and whitespace (a framework's bookkeeping): they wait in the park, where
      // the framework can still add content next to them, while the fallback shows.
      if (slot.nodes.length) slot.park.append(...slot.nodes);
      if (part.fallback) {
        if (fallback) return;
        if (!hydrate || open.data !== '[') clearBetween(open, close);
        open.data = '[';
        fallback = holder.run(() => scope(() => mountBlock(part.fallback, [], open, close, hydrate, context)));
      } else {
        clearBetween(open, close);
        open.data = '[';
      }
    },
  };
  // The region exists while this effect does (an mnx-if branch switching away disposes it):
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
// rendered (inside an mnx-if branch that's off) they're parked in a fragment.

function slotRecord(context, name) {
  let slot = context.slots.get(name);
  if (!slot) {
    slot = { name, nodes: [], region: null, park: document.createDocumentFragment() };
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

function move(parent, node, before) {
  try {
    if (parent.moveBefore && node.isConnected && parent.isConnected) return parent.moveBefore(node, before);
  } catch { /* not movable atomically (different document, …): insert instead */ }
  parent.insertBefore(node, before);
}

const slotName = (node) => (node.nodeType === 1 && node.getAttribute('slot')) || 'default';
/** An element or non-blank text: what fills a slot (comments and whitespace don't). */
const isContent = (node) => node.nodeType === 1 || (node.nodeType === TEXT && node.data.trim() !== '');

/**
 * The slot for each of `nodes` (an element's children, in order). Comments and whitespace are
 * frameworks' markers (Lit's parts, Svelte's anchors): a comment goes with the content after it
 * and whitespace with the content before it, so a framework's range stays together in one slot.
 */
function assignSlots(nodes) {
  const named = nodes.map((node) => (isContent(node) ? slotName(node) : null));
  const after = (i) => { for (let j = i + 1; j < nodes.length; j++) if (named[j]) return named[j]; return null; };
  const before = (i) => { for (let j = i - 1; j >= 0; j--) if (named[j]) return named[j]; return null; };
  return nodes.map((node, i) => named[i]
    ?? (node.nodeType === COMMENT ? after(i) ?? before(i) : before(i) ?? after(i))
    ?? 'default');
}
let nativeText, nativeHTML; // looked up on first use, so the module loads without a DOM

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
    if (!slots.includes(name) && isContent(node)) console.warn(`mnx: <${tag}> has no slot named "${name}"; that content is not shown`);
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
    // Content a parent adds inside a slot itself (its mnx-if or mnx-each there) is slotted too.
    if (context.slotted) {
      for (const slot of context.slots.values()) {
        if (!slot.region) continue;
        for (let node = slot.region.open.nextSibling; node && node !== slot.region.close; node = node.nextSibling) {
          mark(node, context.slotted);
        }
      }
    }
  });
  context.observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['slot'] });
  for (const slot of context.slots.values()) context.observer.observe(slot.park, { childList: true });
}

function bindAttribute(part, node) {
  const name = part.attribute;
  effect(() => {
    const value = $r(part.value());
    // Another library's custom element: a property when it has one (React 19's rule).
    if (part.prop && part.prop in node) {
      node[part.prop] = value;
      return;
    }
    if (part.boolean) {
      if (typeof value !== 'boolean') {
        console.error(`mnx: "${name}" is a boolean attribute; got`, value);
        return;
      }
      node.toggleAttribute(name, value);
      return;
    }
    if (value == null) return node.removeAttribute(name);
    if (typeof value === 'object' && !part.prop) {
      console.error(`mnx: cannot write an object to the "${name}" attribute`, value);
      return node.removeAttribute(name);
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (part.url && !isSafeUrl(text)) {
      console.error(`mnx: blocked an unsafe URL in "${name}":`, text);
      return node.removeAttribute(name);
    }
    if (node.getAttribute(name) !== text) node.setAttribute(name, text);
  });
}

/** mnx-if: re-render only when the chosen branch changes, not whenever the test re-runs. */
function bindWhen(part, open, hydrating, context) {
  const close = matchingClose(open);
  const branch = new Signal.Computed(() => ($r(part.when()) ? 0 : 1));
  let first = hydrating;
  effect(() => {
    const block = part.blocks[branch.get()];
    const hydrate = first;
    first = false;
    // Effects created while mounting belong to this effect, so switching branches disposes them.
    untrack(() => {
      if (block) mountBlock(block, [], open, close, hydrate, context);
      else clearBetween(open, close);
    });
  });
}

/**
 * mnx-each: one row per item. Each row holds its item and index as signals, so changing one
 * item updates only that row's parts.
 *
 * - Without a key, rows are matched by position: a new array updates rows in place, and rows are
 *   only created or removed at the end.
 * - With `key={…}`, rows follow their key: reordering moves the existing rows (with whatever DOM
 *   state they have, like a half-typed input), using `moveBefore()` where the browser has it so
 *   focus and iframes survive the move.
 */
function bindEach(part, open, hydrating, context) {
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
      new DocumentFragment().append(rowOpen, rowClose);
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
    for (const node of nodesOf(row)) node.remove();
  };
  const placeRow = (row, before) => {
    const parent = close.parentNode;
    for (const node of nodesOf(row)) move(parent, node, before);
  };
  const keysOf = (list) => {
    const seen = new Set();
    return list.map((value, index) => {
      let key = part.key(value, index);
      if (seen.has(key)) {
        console.error('mnx: duplicate mnx-each key', key, `(row ${index + 1}); that row is not keyed`);
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
      if (list != null) console.error('mnx: mnx-each items must be an array; got', list);
      list = [];
    }
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
        console.warn('mnx: server markup for a list does not match its items; rendering it fresh');
        clearBetween(open, close);
      }

      if (!keys) {
        const shared = Math.min(rows.length, list.length);
        for (let index = 0; index < shared; index++) {
          rows[index].item.set(list[index]);
          rows[index].position.set(index);
        }
        for (let index = rows.length; index < list.length; index++) {
          const row = createRow(list[index], index);
          placeRow(row, close);
          rows.push(row);
        }
        for (const row of rows.splice(list.length)) removeRow(row);
        return;
      }

      // Keyed: reuse the row for each key, create the missing ones, drop the rest, then walk the
      // new order and move only rows that aren't already where they belong.
      const byKey = new Map(rows.map((row) => [row.key, row]));
      const next = list.map((value, index) => {
        const row = byKey.get(keys[index]);
        if (!row) return createRow(value, index, keys[index]);
        byKey.delete(keys[index]);
        row.item.set(value);
        row.position.set(index);
        return row;
      });
      for (const row of byKey.values()) removeRow(row);
      let at = open.nextSibling;
      while (at && at.nodeType === TEXT) at = at.nextSibling;
      for (const row of next) {
        if (row.open === at) {
          at = row.close.nextSibling;
          continue;
        }
        placeRow(row, at ?? close);
      }
      rows = next;
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
// design system — to every mnx shadow root, since page CSS doesn't reach inside them.

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
 * Add stylesheets (CSS text or `CSSStyleSheet`s) to every mnx shadow root, now and later — for
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
const SLOTTED = 'data-mnx-slotted';
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
      [name, Object.freeze({ attribute: spec.attribute, default: spec.default, required: !!spec.required })]))),
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
    serverElements.set(tag, class MnxServerElement {
      static mnx = describe(tag, options);
      constructor() { throw new TypeError(`mnx: <${tag}> can't be created without a DOM`); }
    });
  }
  return serverElements.get(tag);
}

/**
 * Register a compiled component. `props` maps prop names to `{ attribute, default, required }`;
 * `template` is the element's inner HTML with dynamic parts left empty; `setup($p)` runs the
 * component's script once per element and returns its parts.
 */
export function define(tag, { props = {}, template = '', shadow = false, form = false, slots = [], events = [], styled = false, styles = null, setup }) {
  // On a server (no DOM), a stand-in with the same `mnx` description, so a module that imports a
  // component loads there: adapters render the host tag, and `@mnx/runtime/server` renders it.
  if (typeof HTMLElement === 'undefined') return serverElement(tag, { props, shadow, form, slots, events, styled });
  let sheet; // created on first use, so define() needs no document
  const ownSheets = () => (styles == null ? [] : [(sheet ??= toSheet(styles))]);
  if (customElements.get(tag)) return customElements.get(tag);
  const componentTemplate = blueprint({ template });
  const templateSignature = signature(childRange(componentTemplate.content));
  let instances = 0;
  const byAttribute = Object.fromEntries(Object.entries(props).map(([name, spec]) => [spec.attribute, name]));

  let internals; // (element) => its ElementInternals; set in the static block below
  class MnxElement extends HTMLElement {
    static observedAttributes = Object.keys(byAttribute);
    static mnx = describe(tag, { props, shadow, form, slots, events, styled });
    static formAssociated = form;
    static { internals = (element) => element.#internals; }
    #signals = {};
    #given = new Set(); // props set from outside (property, attribute, or before upgrade)
    #scope = null;
    #hooks = null;
    #cleanups = [];
    #internals = null;
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
      if (form) this.#internals = this.attachInternals();
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
      if (!shadow && styles != null) adopt(this.getRootNode(), ownSheets());
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

    #boot() {
      const element = this;
      const root = shadow ? (this.shadowRoot ?? this.attachShadow({ mode: 'open' })) : this;
      if (shadow) {
        adopt(root, [...globalSheets, ...ownSheets()]);
        shadowRoots.add(new WeakRef(root));
        // The server's copy of the styles, for before this ran; the adopted sheet replaces it.
        const serverStyles = root.firstElementChild;
        if (serverStyles?.localName === 'style' && serverStyles.hasAttribute('data-mnx')) {
          serverStyles.remove();
        }
      }
      const $p = {};
      for (const name of Object.keys(props)) {
        Object.defineProperty($p, name, {
          get: () => element.#signals[name].get(),
          set: (value) => element.#signals[name].set(value),
          enumerable: true,
        });
      }
      this.#hooks = {
        mount: [], unmount: [], host: this, props: $p, instance: ++instances, ids: 0,
        internals: this.#internals, formReset: [], formRestore: [], formDisabled: [],
      };
      this.#scope = scope(() => {
        const previous = current;
        current = this.#hooks;
        let parts;
        // A default computed from the script (`count={start}` where `const start = Date.now()`),
        // unless the prop was given.
        const initial = (name, compute) => {
          if (!this.#given.has(name)) this.#signals[name].set(compute());
        };
        try { parts = setup ? setup($p, (name, detail) => this.#emit(name, detail), initial) : []; } finally { current = previous; }

        const context = { slots: new Map(), slotted: styled && !shadow ? tag : null };
        const server = hasContent(root);
        // Server markup has the template's shape; anything else is the page's own children.
        const nodes = server && signature(childRange(root)) === templateSignature
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
              if (!slots.includes(name) && slot.nodes.some(isContent)) console.warn(`mnx: <${tag}> has no slot named "${name}"; that content is not shown`);
            }
          } else if (server) {
            console.warn(`mnx: <${tag}>'s markup doesn't match its template; rendering it fresh`);
          }
          // Find and bind the parts before inserting (see mountBlock).
          const fragment = document.importNode(componentTemplate.content, true);
          const fresh = locate(childRange(fragment), parts);
          parts.forEach((part, index) => bind(part, fresh[index], false, context));
          root.replaceChildren(fragment);
        }
        if (!shadow) {
          // Content for slots that aren't rendered now waits in their park.
          for (const slot of context.slots.values()) if (!slot.region) slot.park.append(...slot.nodes);
          routeChildren(this, context, slots, tag);
        }
      });
      // Disabled (e.g. inside a disabled <fieldset>) before setup registered its hooks. Chromium
      // always calls formDisabledCallback after connectedCallback, so this never runs there (the
      // browser tests confirm the behaviour without it); it guards engines that order the
      // callbacks the other way, which the test suite can't currently exercise.
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
      Object.defineProperty(MnxElement.prototype, key, { ...descriptor, configurable: true });
    }
  }

  customElements.define(tag, MnxElement);
  return MnxElement;
}
