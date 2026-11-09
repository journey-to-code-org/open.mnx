// ---- what `--emit element` puts in place of @zubra/runtime -----------------------------------
// The component's definition below is the same one `--emit js` writes; `$define` here turns it
// into a plain custom element, with no imports: props as properties and observed attributes, the
// template's parts bound directly to the DOM, and light-DOM slots. Updates are batched in a
// microtask and re-run every binding; effect() re-runs when something it read has changed.
// Not here (the compiler refuses them): shadow DOM, spreads, zb-await, server hydration.
const $SIGNAL = Symbol('zubra.signal');
let $current = null; // the element whose script or effect is running
let $reads = null; // while an effect runs: how to read each value it read again
const $insert = (parent, node, before) => Node.prototype.insertBefore.call(parent, node, before);
/** Moves a node already on the page, keeping its focus and state where the browser can (moveBefore). */
function $move(parent, node, before) {
  try { if (Element.prototype.moveBefore && node.isConnected && parent.isConnected) return parent.moveBefore(node, before); } catch { /* not movable atomically: insert */ }
  return $insert(parent, node, before);
}
const $fired = new WeakMap(); // event → the element that dispatched it

/** A value that may be a state() or computed(): its current value. */
const $r = (value) => (value && value[$SIGNAL] ? value.get() : value);
/** Text for the page: nothing for null or undefined, never an object. */
function $t(value) {
  value = $r(value);
  if (value == null) return '';
  if (typeof value === 'object') { console.error('zubra: cannot render an object as text', value); return ''; }
  return String(value);
}
/**
 * State: a value that updates the page when it's set, or (an array or plain object) mutated:
 * push, splice and nested writes count, as in the runtime. Each change bumps a version, which is
 * what effects and derived values compare.
 */
function state(initial) {
  const owner = $current;
  let version = 0;
  const changed = () => { version++; owner?.$request(); };
  const proxies = new WeakMap(); // this state's own: the same object in two states tells each
  let value = $deep(initial, changed, proxies);
  const read = () => version;
  return {
    [$SIGNAL]: true,
    get: () => ($reads?.push(read), value),
    set(next) { if (!Object.is(next, value)) { value = $deep(next, changed, proxies); changed(); } },
  };
}
function $deep(value, changed, proxies) {
  if (!value || typeof value !== 'object' || !(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) return value;
  let proxy = proxies.get(value);
  if (!proxy) {
    proxy = new Proxy(value, {
      get: (target, key, receiver) => $deep(Reflect.get(target, key, receiver), changed, proxies),
      set: (target, key, next, receiver) => { const same = Object.is(target[key], next); const done = Reflect.set(target, key, next, receiver); if (!same) changed(); return done; },
      deleteProperty: (target, key) => { const done = Reflect.deleteProperty(target, key); changed(); return done; },
    });
    proxies.set(value, proxy);
  }
  return proxy;
}
/** A derived value, cached until something it read changes (like the runtime's). */
function computed(read) {
  let seen = null;
  let value;
  return {
    [$SIGNAL]: true,
    get() {
      if (!seen || !seen.every(([again, last]) => Object.is(again(), last))) {
        const outer = $reads;
        const reads = [];
        $reads = reads;
        try { value = read(); } finally { $reads = outer; seen = reads.map((again) => [again, again()]); }
      }
      if ($reads) for (const [again] of seen) $reads.push(again);
      return value;
    },
  };
}
function effect(run) {
  $current.$effects.push({ run, seen: null, cleanup: null });
}
function onMount(run) {
  $current.$mounted.push(run);
}
function onUnmount(run) {
  $current.$unmounted.push(run);
}
let $ids = 0;
function id() {
  return `${$current.localName}-${++$ids}`;
}
function host() {
  return $current;
}
function emit(name, detail) {
  return $current.$fire(name, detail);
}
function formValue(read) {
  $current.$formValue = read;
}
function validity(read) {
  $current.$validity = read;
}
// @slots {
function hasSlot(name = 'default') {
  const element = $current;
  return { [$SIGNAL]: true, get: () => element.$slot(name).nodes.some($isContent) };
}
// @slots }
function hydrated() {
  const element = $current;
  return { [$SIGNAL]: true, get: () => element.$started };
}

/** The same rule the compiler applies at build time (src/validate.rs `is_safe_url`). */
function isSafeUrl(value) {
  const url = String(value).trim();
  if (!url || /[\u0000-\u001f\u007f-\u009f]/.test(url) || url.startsWith('//')) return false;
  const beforePath = url.split(/[/?#]/)[0];
  const colon = beforePath.indexOf(':');
  return colon < 0 || ['http', 'https', 'mailto', 'tel'].includes(beforePath.slice(0, colon).toLowerCase());
}
function isSafeSrcset(value) {
  const urls = String(value).split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean);
  return urls.length > 0 && urls.every(isSafeUrl);
}

/** Attribute text as its prop's type, from the prop's default (JSON for arrays and objects). */
function $parse(spec, raw) {
  const fallback = spec.default;
  if (typeof fallback === 'boolean') return fallback ? raw !== 'false' : raw !== null;
  if (raw === null) return structuredClone(fallback);
  if (typeof fallback === 'number') return Number(raw);
  if (typeof fallback === 'string') return raw;
  try { return JSON.parse(raw); } catch { return fallback === undefined || fallback === null ? raw : structuredClone(fallback); }
}

// ---- the template: positions, regions and parts

/** The positions a path counts: elements and marker comments, a region (<!--[-->…<!--]-->) as one. */
function* $positions(first) {
  for (let node = first; node; node = node.nextSibling) {
    if (node.nodeType === 1) yield node;
    else if (node.nodeType === 8 && (node.data === '' || node.data === '[')) {
      yield node;
      if (node.data === '[') node = $closing(node);
    }
  }
}
function $walk(first, path) {
  let node = null;
  for (const index of path) {
    let seen = -1;
    node = null;
    for (const candidate of $positions(first)) if (++seen === index) { node = candidate; break; }
    first = node?.firstChild;
  }
  return node;
}
/** The marker that closes the region `open` starts. */
function $closing(open) {
  let node = open;
  let depth = 0;
  do {
    node = node.nextSibling;
    if (node.nodeType === 8) depth += node.data === '[' ? 1 : node.data === ']' ? -1 : 0;
  } while (depth >= 0);
  return node;
}
function $clear(open, close) {
  while (open.nextSibling !== close) open.nextSibling.remove();
}
const $templates = new Map();
const $SVG = 'http://www.w3.org/2000/svg';
/** A template's nodes; inside <svg> (a list row or branch there) they're parsed as SVG. */
function $fragment(html, svg = false) {
  const cacheKey = svg ? `svg:${html}` : html;
  let template = $templates.get(cacheKey);
  if (!template) {
    template = document.createElement('template');
    if (svg) {
      template.innerHTML = `<svg>${html}</svg>`;
      template.content.replaceChildren(...template.content.firstChild.childNodes);
    } else {
      template.innerHTML = html;
    }
    $templates.set(cacheKey, template);
  }
  return template.content.cloneNode(true);
}
const $inSvg = (node) => node.namespaceURI === $SVG && node.localName !== 'foreignObject';
/** A block's nodes and their bindings: they go before `before` in `parent`. Returns the updates. */
function $mount(block, args, parent, before, element) {
  const fragment = $fragment(block.template, $inSvg(parent));
  const updates = $bindAll(block.parts(...args), fragment, element);
  for (const update of updates) update(); // filled in before it's on the page
  $insert(parent, fragment, before);
  return updates;
}
function $bindAll(parts, root, element) {
  const nodes = parts.map((part) => $walk(root.firstChild, part.path));
  return parts.map((part, i) => $bind(part, nodes[i], element)).filter(Boolean);
}

/** What one part does to its node: the function that brings it up to date, if it changes. */
function $bind(part, node, element) {
  if (part.on) {
    const [listener, options] = $listener(part, node);
    if (!part.global) { node.addEventListener(part.on, listener, options); return null; }
    // <zb-window>/<zb-document>: listening while the element is on the page.
    const target = part.global === 'window' ? window : document;
    element.$mounted.push(() => { target.addEventListener(part.on, listener, options); return () => target.removeEventListener(part.on, listener, options); });
    return null;
  }
  if (part.ref) { $r(part.ref())(node); return null; }
  let last = $SIGNAL; // nothing written yet
  const changed = (value) => (Object.is(value, last) ? false : ((last = value), true));
  if (part.text) return () => { const value = part.text(); if (changed(value)) node.textContent = value; };
  if (part.anchor) {
    const text = $insert(node.parentNode, document.createTextNode(''), node);
    return () => { const value = part.anchor(); if (changed(value)) text.data = value; };
  }
  if (part.toggle) return () => node.classList.toggle(part.toggle, Boolean($r(part.value())));
  if (part.classes) {
    let tokens = [];
    return () => {
      const next = String($r(part.classes()) ?? '').split(/\s+/).filter(Boolean);
      for (const token of tokens) if (!next.includes(token)) node.classList.remove(token);
      for (const token of next) node.classList.add(token);
      tokens = next;
    };
  }
  if (part.style) {
    return () => {
      const value = $r(part.value());
      if (!changed(value)) return;
      if (value == null || value === false || value === '') node.style.removeProperty(part.style);
      else node.style.setProperty(part.style, String(value));
    };
  }
  if (part.property) return () => { const value = $r(part.value()); if (changed(value)) node[part.property] = value; };
  if (part.attribute) return () => { const value = $r(part.value()); if (changed(value)) $attribute(part, node, value); };
  if (part.each) return $list(part, node, element);
  if (part.when) return $branch(part, node, element);
// @slots {
  if (part.slot) return $slotRegion(part, node, element);
// @slots }
  throw new Error(`zubra: a part --emit element doesn't support: ${Object.keys(part).join(', ')}`);
}

// Properties waiting for another library's element to be defined: the latest value for each,
// held weakly, so an element that's never defined keeps nothing alive.
const $waiting = new WeakMap(); // node → { prop: value }
const $waitingTags = new Map(); // tag → Set of WeakRef(node)
function $whenDefined(node, prop, value) {
  let props = $waiting.get(node);
  if (!props) {
    $waiting.set(node, (props = {}));
    const tag = node.localName;
    let nodes = $waitingTags.get(tag);
    if (!nodes) {
      $waitingTags.set(tag, (nodes = new Set()));
      customElements.whenDefined(tag).then(() => {
        $waitingTags.delete(tag);
        for (const ref of nodes) {
          const later = ref.deref();
          const given = later && $waiting.get(later);
          if (given) for (const key in given) if (key in later) later[key] = given[key];
        }
      });
    }
    nodes.add(new WeakRef(node));
  }
  props[prop] = value;
}
function $attribute(part, node, value) {
  const name = part.attribute;
  // Another library's custom element: its property if it has one (React 19's rule); until it's
  // defined, an attribute (JSON for objects), and the property once it is.
  if (part.prop && node.localName.includes('-')) {
    if (part.prop in node) { node[part.prop] = value; return; }
    if (!customElements.get(node.localName)) $whenDefined(node, part.prop, value);
    if (value != null && typeof value === 'object') { node.setAttribute(name, JSON.stringify(value)); return; }
  }
  if (name === 'value' && 'value' in node && node.localName !== 'button') {
    const text = String(value ?? '');
    if (node.value !== text) node.value = text;
    // A <select>'s options may come from a list inside it that renders after this: again once they're there.
    if (node.localName === 'select' && node.value !== text) queueMicrotask(() => { if (node.value !== text) node.value = text; });
    return;
  }
  if (part.boolean) { node.toggleAttribute(name, Boolean(value)); return; }
  if (value == null || value === false) { node.removeAttribute(name); return; }
  if (typeof value === 'object') { console.error(`zubra: cannot write an object to the "${name}" attribute`, value); node.removeAttribute(name); return; }
  const text = String(value);
  if ((part.url || part.srcset) && text.trim() === '') { node.removeAttribute(name); return; }
  if ((part.url && !isSafeUrl(text)) || (part.srcset && !isSafeSrcset(text))) {
    console.error(`zubra: blocked an unsafe URL in "${name}":`, text);
    node.removeAttribute(name);
    return;
  }
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}

/** An event part's listener: the handler, read when the event fires, behind the modifiers. */
function $listener(part, node) {
  const m = part.modifiers;
  const apple = /mac|iphone|ipad|ipod/i.test(navigator.platform ?? '');
  const ctrl = m && (m.ctrl || (m.mod && !apple));
  const meta = m && (m.meta || (m.mod && apple));
  const listener = (event) => {
    if (m) {
      if (m.self && event.target !== node) return;
      if (m.keys) {
        const key = event.key ?? '';
        if (!m.keys.some((wanted) => (wanted.length === 1 ? key.toLowerCase() === wanted : key === wanted))) return;
        if (!!m.shift !== event.shiftKey || !!ctrl !== event.ctrlKey || !!m.alt !== event.altKey || !!meta !== event.metaKey) return;
      } else if ((m.shift && !event.shiftKey) || (ctrl && !event.ctrlKey) || (m.alt && !event.altKey) || (meta && !event.metaKey)) return;
      if (m.prevent) event.preventDefault();
      if (m.stop) event.stopPropagation();
    }
    const handler = $r(part.handler());
    if (typeof handler === 'function') handler.call(node, event);
    if (m?.submit) (node.form ?? node.closest('form'))?.requestSubmit();
  };
  return [listener, m && (m.once || m.capture || m.passive) ? { once: !!m.once, capture: !!m.capture, passive: !!m.passive } : undefined];
}

/** zb-each: rows by key, kept (with their focus) when the list changes, moved only when out of place. */
function $list(part, open, element) {
  let rows = new Map();
  const nodesOf = (row) => { const nodes = []; for (let node = row.first; node; node = node.nextSibling) { nodes.push(node); if (node === row.last) break; } return nodes; };
  return () => {
    const items = [...($r(part.each()) ?? [])];
    const next = new Map();
    let after = open;
    items.forEach((item, index) => {
      // Without a key, rows are matched by position and updated in place (as in the runtime).
      let key = part.key ? part.key(item, index) : index;
      if (next.has(key)) {
        console.error('zubra: duplicate zb-each key', key, `(row ${index + 1}); that row is not keyed`);
        key = Symbol('duplicate');
      }
      let row = rows.get(key);
      if (row) {
        // The same row, kept (with its focus): its item and index are read through signals.
        row.item.value = item;
        row.index.value = index;
      } else {
        const cell = (value) => ({ [$SIGNAL]: true, value, get() { return this.value; } });
        const itemCell = cell(item);
        const indexCell = cell(index);
        const fragment = $fragment(part.block.template, $inSvg(open.parentNode));
        const updates = $bindAll(part.block.parts(itemCell, indexCell), fragment, element);
        // A row is everything from its first node to its last, with what a list inside it adds later.
        row = { item: itemCell, index: indexCell, first: fragment.firstChild, last: fragment.lastChild, updates };
        for (const update of updates) update(); // filled in before it's on the page
        $insert(open.parentNode, fragment, after.nextSibling);
      }
      next.set(key, row);
      for (const update of row.updates) update();
      if (row.first !== after.nextSibling) {
        const before = after.nextSibling;
        for (const node of nodesOf(row)) $move(open.parentNode, node, before);
      }
      after = row.last;
    });
    for (const [key, row] of rows) if (!next.has(key)) for (const node of nodesOf(row)) node.remove();
    rows = next;
  };
}

/** zb-if: the branch that's true, rebuilt only when the choice changes. */
function $branch(part, open, element) {
  const close = $closing(open);
  let shown = -1;
  let updates = [];
  return () => {
    const index = $r(part.when()) ? 0 : 1;
    if (index !== shown) {
      shown = index;
      element.$parkRegionsIn?.(open, close); // slotted content inside goes back to wait, not away
      $clear(open, close);
      updates = part.blocks[index] ? $mount(part.blocks[index], [], open.parentNode, close, element) : [];
    }
    for (const update of updates) update();
  };
}

// @slots {
const $isContent = (node) => node.nodeType === 1 || (node.nodeType === 3 && node.data.trim() !== '');
const $slotName = (node) => (node.nodeType === 1 && node.getAttribute('slot')) || 'default';

/**
 * zb-slot in light DOM: the page's children for this slot, kept in order (and marked, where the
 * component's styles stop), or the fallback while there are none. Its nodes wait in the slot's
 * park while the region isn't rendered (inside a zb-if branch that's off).
 */
function $slotRegion(part, open, element) {
  const close = $closing(open);
  const record = element.$slot(part.slot);
  const region = {
    open,
    close,
    provided: false,
    fallback: null,
    update(keep = null) {
      // Content a framework removed through its real parent (Vue does) has left, even before the
      // MutationObserver says so: it mustn't be put back.
      record.nodes = record.nodes.filter((node) => node === keep || node.parentNode === open.parentNode || node.parentNode === record.park);
      region.provided = record.nodes.some($isContent);
      if (region.provided) {
        if (region.fallback) { $clear(open, close); region.fallback = null; }
        let cursor = open.nextSibling;
        for (const node of record.nodes) {
          element.$mark(node);
          if (node === cursor) cursor = cursor.nextSibling;
          else $move(open.parentNode, node, cursor);
        }
        return;
      }
      // Only markers and whitespace (a framework's bookkeeping): they wait in the park, where the
      // framework can still add content next to them, while the fallback shows.
      if (record.nodes.length) record.park.append(...record.nodes);
      if (part.fallback && !region.fallback) { $clear(open, close); region.fallback = $mount(part.fallback, [], open.parentNode, close, element); }
      if (region.fallback) for (const update of region.fallback) update();
    },
  };
  record.region = region;
  return () => { record.region = region; region.update(); };
}

/**
 * The slot for each of the page's children: by its slot attribute; a framework's markers (comments,
 * whitespace, a pair of empty text nodes) go with the content they belong to, as in the runtime.
 */
function $assignSlots(nodes) {
  const named = nodes.map((node) => ($isContent(node) ? $slotName(node) : null));
  const near = (i, step) => { for (let j = i + step; nodes[j]; j += step) if (named[j]) return named[j]; return null; };
  const open = [];
  nodes.forEach((node, i) => {
    if (node.nodeType !== 3 || node.data) return;
    if (!open.length || named[i + 1] && nodes[i + 1].data == null) return open.push(i);
    const start = open.pop();
    named[start] = named[i] = named.slice(start + 1, i).find(Boolean);
  });
  return nodes.map((node, i) => named[i] ?? (node.nodeType === 8 ? near(i, 1) ?? near(i, -1) : near(i, -1) ?? near(i, 1)) ?? 'default');
}
// @slots }

// ---- the element

function $sheet(css) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet;
}

function $define(tag, definition) {
  // Imported where there's no DOM (a server build): nothing to define.
  if (typeof HTMLElement === 'undefined') return class {};
  const { props, form, styles, inPage, template } = definition;
  const models = Object.keys(props).filter((prop) => props[prop].model);
  const model = form && models.length === 1 ? models[0] : null;
  const attributes = Object.fromEntries(Object.entries(props).map(([prop, spec]) => [spec.attribute, prop]));
  let sheet = null;

  class ZubraElement extends HTMLElement {
    static observedAttributes = Object.keys(attributes);
    static formAssociated = Boolean(form);
    static zubra = { tag, ...definition, element: true };
    $values = Object.fromEntries(Object.entries(props).map(([prop, spec]) => [prop, structuredClone(spec.default)]));
    $given = new Set();
    $updates = [];
    $effects = [];
    $mounted = [];
    $unmounted = [];
    $cleanups = [];
    $slots = new Map();
    $pending = null;
    $started = false;
    $styled = Boolean(definition.styled);

    constructor() {
      super();
      this.$internals = this.attachInternals();
      // An event the component fires is its own: an inner element's event of the same name (a
      // native change bubbling out, a nested component's valuechange) stops here.
      for (const name of definition.events) this.addEventListener(name, (event) => { if ($fired.get(event) !== this) event.stopImmediatePropagation(); });
      // Properties set before the element was defined: keep them.
      for (const prop of Object.keys(props)) {
        if (Object.hasOwn(this, prop)) { const value = this[prop]; delete this[prop]; this[prop] = value; }
      }
    }

    attributeChangedCallback(attribute, _, raw) {
      const prop = attributes[attribute];
      this[prop] = $parse(props[prop], raw);
    }

    connectedCallback() {
      // The styles go to the root the element is in: the document, or a shadow root.
      if (styles) {
        const root = this.getRootNode();
        if (root.adoptedStyleSheets && !(inPage && root === document) && !root.adoptedStyleSheets.includes(sheet ??= $sheet(styles))) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
      if (this.$started) { this.$flush(); this.$runMounted(); return; } // back on the page: catch up
      // Props a framework's server rendering wrote as JSON (the adapters' zb-props), to start
      // with before the framework sets them as properties.
      let given;
      try { given = JSON.parse(this.getAttribute('zb-props')); } catch { /* none */ }
      for (const name in given) if (Object.hasOwn(props, name) && !this.$given.has(name)) this[name] = given[name];
      // The server's stand-in for this control's value: the element's own form value takes over.
      if (form) for (const child of this.querySelectorAll(':scope>input[data-zb-fallback]')) child.remove();
// @slots {
      // The page's children, for the slots, before the template takes their place.
      const children = definition.slots.length ? [...this.childNodes] : [];
      // Each waits in its slot's park until its region shows it (a slot inside a zb-if that's off
      // keeps it there, where it can still be removed through its parent).
      $assignSlots(children).forEach((name, i) => { this.$warnSlot(name, children[i]); const record = this.$slot(name); record.nodes.push(children[i]); record.park.append(children[i]); });
// @slots }
      const content = $fragment(template);
      // The component's script sees its props through $p: assigning a two-way prop fires <prop>change.
      const $p = {};
      for (const [prop, spec] of Object.entries(props)) {
        Object.defineProperty($p, prop, {
          get: () => { $reads?.push(() => this.$values[prop]); return this.$values[prop]; },
          set: (value) => { if (Object.is(value, this.$values[prop])) return; this[prop] = value; if (spec.model) this.$fire(`${prop}change`, value); },
        });
      }
      const $initial = (prop, compute) => { if (!this.$given.has(prop)) this.$values[prop] = compute(); };
      $current = this;
      let parts;
      try { parts = definition.setup($p, (name, detail) => this.$fire(name, detail), $initial); } finally { $current = null; }
      this.$updates = $bindAll(parts, content, this);
      // Filled in before it goes on the page (a child component then starts with its real content).
      for (const update of this.$updates) update();
      Element.prototype.replaceChildren.call(this, content);
      this.$started = true;
      this.$internals.states?.add('hydrated'); // :state(hydrated), for CSS and for code waiting on it
// @slots {
      if (definition.slots.length) this.$observe();
// @slots }
      if (model) this.$reset = structuredClone(this.$values[model]);
      this.$flush();
      this.$runMounted();
    }
    $runMounted() {
      // An effect created in onMount belongs to the element, as one made by its script.
      const effects = this.$effects.length;
      $current = this;
      try {
        for (const run of this.$mounted) { const cleanup = run(); if (typeof cleanup === 'function') this.$cleanups.push(cleanup); }
      } finally { $current = null; }
      if (this.$effects.length > effects) this.$runEffects();
    }

    // A form reset brings the two-way prop back to what it started as.
    formResetCallback() {
      if (!model || this.$reset === undefined || Object.is(this.$values[model], this.$reset)) return;
      this[model] = structuredClone(this.$reset);
      this.$fire(`${model}change`, this.$values[model]); // a reset is the control's own change
    }

    // Leaving the page: onMount's cleanups, then onUnmount's callbacks (they run on every disconnect).
    disconnectedCallback() {
      for (const run of this.$cleanups.splice(0)) run();
      for (const run of this.$unmounted) run();
    }

// @slots {
    $slot(name) {
      let record = this.$slots.get(name);
      if (!record) {
        record = { name, nodes: [], region: null, park: document.createDocumentFragment() };
        this.$slots.set(name, record);
        this.$observer?.observe(record.park, { childList: true });
      }
      return record;
    }
    $mark(node) {
      if (this.$styled && node.nodeType === 1) node.setAttribute('data-zb-slotted', this.localName);
    }
    $unmark(node) {
      if (this.$styled && node.nodeType === 1 && node.getAttribute('data-zb-slotted') === this.localName) node.removeAttribute('data-zb-slotted');
    }
    $warnSlot(name, node) {
      if ($isContent(node) && !definition.slots.includes(name)) console.warn(`zubra: <${tag}> has no slot named "${name}"; that content is not shown`);
    }
    $holding(node) {
      for (const record of this.$slots.values()) if (record.nodes.includes(node)) return record;
      return null;
    }
    // Drop content that left through its real parent (or was moved elsewhere), except `keep`.
    $show(record, keep) {
      const home = record.region?.provided ? record.region.open.parentNode : record.park;
      const kept = record.nodes.filter((node) => node === keep || node.parentNode === home);
      for (const node of record.nodes) if (!kept.includes(node)) this.$unmark(node);
      record.nodes = kept;
      if (record.region) record.region.update(keep);
      else record.park.append(...record.nodes);
      this.$request(); // hasSlot() and the rest may have changed
    }
    $take(node) {
      const record = this.$holding(node);
      if (record) record.nodes.splice(record.nodes.indexOf(node), 1);
      return record;
    }
    $route(node, before) {
      if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.$route(child, before); return; }
      const from = this.$take(node);
      // A marker or whitespace goes in the slot of what it's inserted before.
      const name = $isContent(node) ? $slotName(node) : (before && this.$holding(before)?.name) || 'default';
      this.$warnSlot(name, node);
      const record = this.$slot(name);
      const at = before ? record.nodes.indexOf(before) : -1;
      record.nodes.splice(at < 0 ? record.nodes.length : at, 0, node);
      if (from && from !== record) this.$show(from);
      this.$show(record, node);
    }
    $remove(node) {
      const record = this.$take(node);
      if (!record) return false;
      this.$unmark(node);
      node.remove();
      this.$show(record);
      return true;
    }
    $clearSlots() {
      for (const record of this.$slots.values()) {
        for (const node of record.nodes.splice(0)) { this.$unmark(node); node.remove(); }
        this.$show(record);
      }
    }
    /** A zb-if branch is going away: the slotted content inside it waits in the parks. */
    $parkRegionsIn(open, close) {
      for (const record of this.$slots.values()) {
        const region = record.region;
        if (!region) continue;
        let inside = false;
        for (let node = open.nextSibling; node && node !== close; node = node.nextSibling) if (node === region.open || node.contains?.(region.open)) { inside = true; break; }
        if (!inside) continue;
        record.region = null;
        record.park.append(...record.nodes);
      }
    }
    // Content removed or moved through its real parent (Vue removes via parentNode; Lit and
    // Svelte change content next to their markers), and content whose slot attribute changed.
    $observe() {
      this.$observer = new MutationObserver((records) => {
        for (const record of records) {
          const slot = record.type === 'attributes' && this.$holding(record.target);
          if (slot && $slotName(record.target) !== slot.name) this.$route(record.target, null);
        }
        for (const slot of this.$slots.values()) {
          let actual;
          if (slot.region?.provided) {
            actual = [];
            for (let node = slot.region.open.nextSibling; node && node !== slot.region.close; node = node.nextSibling) actual.push(node);
          } else {
            actual = [...slot.park.childNodes];
          }
          if (actual.length === slot.nodes.length && actual.every((node, i) => node === slot.nodes[i])) continue;
          for (const node of slot.nodes) if (!actual.includes(node)) this.$unmark(node);
          slot.nodes = actual;
          // An element that belongs to another slot (added next to a marker here) goes there.
          for (const node of actual) if (node.nodeType === 1 && $slotName(node) !== slot.name) this.$route(node, null);
          this.$show(slot);
        }
      });
      this.$observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ['slot'] });
      for (const record of this.$slots.values()) this.$observer.observe(record.park, { childList: true });
    }

    // Frameworks keep managing what they gave the element through the host (React calls
    // insertBefore and removeChild on it, Vue sets textContent): once it has started, those go to
    // the slots.
    insertBefore(node, before) { if (!this.$started) return super.insertBefore(node, before); this.$route(node, before ?? null); return node; }
    appendChild(node) { if (!this.$started) return super.appendChild(node); this.$route(node, null); return node; }
    append(...items) { if (!this.$started) return super.append(...items); for (const item of items) this.$route(item instanceof Node ? item : document.createTextNode(String(item)), null); }
    removeChild(node) { if (this.$started && this.$remove(node)) return node; return super.removeChild(node); }
    replaceChild(node, old) {
      if (!this.$started || !this.$holding(old)) return super.replaceChild(node, old);
      this.$route(node, old);
      this.$remove(old);
      return old;
    }
    replaceChildren(...items) { if (!this.$started) return super.replaceChildren(...items); this.$clearSlots(); this.append(...items); }
    get textContent() { return super.textContent; }
    set textContent(value) {
      if (!this.$started) { super.textContent = value; return; }
      this.$clearSlots();
      if (value != null && value !== '') this.$route(document.createTextNode(String(value)), null);
    }
    get innerHTML() { return super.innerHTML; }
    set innerHTML(value) {
      if (!this.$started) { super.innerHTML = value; return; }
      this.$clearSlots();
      const template = document.createElement('template');
      template.innerHTML = value;
      this.$route(document.importNode(template.content, true), null);
    }
// @slots }

    /** Dispatches one of the component's events (they bubble; before… events can be cancelled). */
    $fire(name, detail) {
      const event = new CustomEvent(name, { detail, bubbles: true, cancelable: name.startsWith('before') });
      $fired.set(event, this);
      return this.dispatchEvent(event);
    }

    /** Asks for an update in a microtask: several changes, one pass. */
    $request() {
      this.$pending ??= Promise.resolve().then(() => this.$flush());
    }
    $flush() {
      this.$pending = null;
      // Off the page, nothing updates; it catches up when it's back (connectedCallback).
      if (!this.$started || !this.isConnected) return;
      for (const update of this.$updates) update();
      if (this.$formValue) {
        const value = $r(this.$formValue());
        this.$internals.setFormValue(value == null ? null : value instanceof FormData || value instanceof File ? value : String(value));
      } else if (model) {
        // One two-way prop: that's what the control submits, as the runtime does.
        const value = this.$values[model];
        this.$internals.setFormValue(value == null || value === false || value === '' ? null : value === true ? 'on' : typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      if (this.$validity) {
        const message = String($r(this.$validity()) || '');
        // The browser shows the message at, and focuses, the first focusable thing the component rendered.
        const anchor = [...this.querySelectorAll('input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex="-1"]), [contenteditable]')].find((node) => !node.closest('[data-zb-slotted]')) ?? this;
        if (message) this.$internals.setValidity({ customError: true }, message, anchor);
        else this.$internals.setValidity({});
      }
      this.$runEffects();
    }
    // Effects run again only when something they read has changed since.
    $runEffects() {
      for (const effect of this.$effects) {
        if (effect.seen && effect.seen.every(([read, value]) => Object.is(read(), value))) continue;
        if (typeof effect.cleanup === 'function') effect.cleanup();
        const outer = $reads;
        const reads = [];
        $reads = reads;
        $current = this;
        try { effect.cleanup = effect.run(); } finally {
          $reads = outer;
          $current = null;
          effect.seen = reads.map((read) => [read, read()]);
        }
      }
    }

    /** Resolves once pending changes are on the page. */
    get updateComplete() {
      return this.$pending ?? Promise.resolve();
    }
  }
  for (const prop of Object.keys(props)) {
    Object.defineProperty(ZubraElement.prototype, prop, {
      get() { return this.$values[prop]; },
      set(value) { this.$given.add(prop); if (Object.is(value, this.$values[prop])) return; this.$values[prop] = value; this.$request(); },
      configurable: true,
    });
  }
  if (form) {
    for (const name of ['form', 'validity', 'validationMessage', 'willValidate']) Object.defineProperty(ZubraElement.prototype, name, { get() { return this.$internals[name]; }, configurable: true });
    ZubraElement.prototype.checkValidity = function () { return this.$internals.checkValidity(); };
    ZubraElement.prototype.reportValidity = function () { return this.$internals.reportValidity(); };
  }
  if (!customElements.get(tag)) customElements.define(tag, ZubraElement);
  return customElements.get(tag);
}
// ---- end of the element runtime --------------------------------------------------------------
