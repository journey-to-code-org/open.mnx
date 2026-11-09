// The DevTools reading side: what the browser extension (editors/devtools) shows for a node.
// devhook.js records from the page's start and loads this when the extension connects, so a
// page that never opens the pane doesn't carry it. Neither is in the production build
// (scripts/build-production.js).
//
// The extension reads the page through `globalThis.__ZUBRA_DEVTOOLS__` and nothing else: plain
// JSON out, so the runtime's internals stay free to change. `version` says which shape.
//
// What it knows comes from a `--devtools` build (which @zubra/unplugin makes in Vite's dev
// server): each part's line and column in the `.zb` file, the file itself, and the script's
// signals by name. Without that build, an element still shows its tag, props and bindings,
// unlocated and with fewer names.
//
// The dependencies are read through `Signal.subtle.introspectSources`, the Signals proposal's
// own introspection, so the same view works on the polyfill and on a native `Signal`.
import { Signal, isNative } from './signal.js';
import { dev as effects } from './effect.js';
import { dev as deep, raw } from './deep.js';
import { elements, listeners, hooks } from './devhook.js';

const { introspectSources, untrack } = Signal.subtle;
const isComputed = (value) => value instanceof Signal.Computed;
const isState = (value) => value instanceof Signal.State;

// The most recent flush since connecting: the effects it re-ran, and the signals written since
// the one before.
let writes = new Set();
let last = { ran: new Set(), written: new Set() };
let updates = 0;

effects.flushed = (ran) => {
  last = { ran: new Set(ran), written: writes };
  writes = new Set();
  updates++;
};
const wrote = (signal) => {
  // A write nothing reads never flushes: don't let those pile up.
  if (writes.size > 1000) writes = new Set();
  writes.add(signal);
};
deep.wrote = wrote;

/** Watch writes to a signal (a prop's, or a named state's). */
function watchWrites(signal) {
  if (signal.__zubraWatched) return;
  const set = signal.set;
  signal.set = function (value) {
    wrote(signal);
    return set.call(this, value);
  };
  Object.defineProperty(signal, '__zubraWatched', { value: true });
}

/** Watch a component's props and named state (once; elements from before connecting too). */
function watch(record) {
  if (record.watched) return;
  record.watched = true;
  for (const signal of Object.values(record.props)) watchWrites(signal);
  for (const signal of Object.values(record.named ?? {})) {
    if (isState(signal) || typeof signal?.set === 'function') watchWrites(signal);
  }
}
hooks.registered = watch;

// ---- reading -------------------------------------------------------------------------------

/** The nearest registered component at or above `node`, crossing shadow roots. */
function hostOf(node, skipSelf = false) {
  for (let at = skipSelf ? up(node) : node; at; at = up(at)) if (elements.has(at)) return at;
  return null;
}
const up = (node) => node.parentNode ?? node.host ?? null;

/** Every effect `owner` owns, depth first (a component's own: child components have their own roots). */
function effectsOf(owner, out = []) {
  for (const child of owner.children) {
    if (child.disposed) continue;
    if (child.computed) out.push(child);
    effectsOf(child, out);
  }
  return out;
}

/** The DOM operation a part performs, in the platform's terms. */
export function operation(part) {
  if (part.text) return 'textContent = …';
  if (part.anchor) return 'Text.data = …';
  if (part.global) return `${part.global}.addEventListener('${part.on}', …)`;
  if (part.on) return `addEventListener('${part.on}', …)`;
  if (part.classes) return 'classList.add/remove(…)';
  if (part.toggle) return `classList.toggle('${part.toggle}', …)`;
  if (part.style) return `style.setProperty('${part.style}', …)`;
  if (part.ref) return 'ref(element)';
  if (part.property) return `.${part.property} = …`;
  if (part.attribute) {
    if (part.boolean) return `toggleAttribute('${part.attribute}', …)`;
    if (part.prop) return `.${part.prop} = … (or setAttribute('${part.attribute}', …))`;
    return `setAttribute('${part.attribute}', …)`;
  }
  if (part.when) return 'zb-if: insert or remove a block';
  if (part.each) return 'zb-each: add, move or remove rows';
  if (part.await) return 'zb-await: pending, then or catch';
  if (part.slot) return `slot "${part.slot}"`;
  if (part.spread) return 'spread: attributes and properties';
  return 'binding';
}

/** A short name for a node: `<button.on>`, or its parent's for a text anchor or region marker. */
function describe(node) {
  if (!node) return '?';
  if (node.nodeType === 1) {
    const id = node.id ? `#${node.id}` : '';
    const classes = [...(node.classList ?? [])].slice(0, 2).map((name) => `.${name}`).join('');
    return `<${node.localName}${id}${classes}>`;
  }
  return node.parentNode?.nodeType === 1 ? `${describe(node.parentNode)} content` : node.nodeName;
}

/** A value as a short string: the pane shows values, it doesn't hold them. */
export function preview(value, depth = 0) {
  value = raw(value);
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}()`;
  if (isComputed(value) || isState(value)) return preview(untrack(() => value.get()), depth);
  if (typeof Node !== 'undefined' && value instanceof Node) return describe(value);
  if (value instanceof Promise) return 'Promise';
  if (Array.isArray(value)) {
    if (depth > 1) return `Array(${value.length})`;
    const shown = value.slice(0, 5).map((item) => preview(item, depth + 1));
    return `[${shown.join(', ')}${value.length > 5 ? `, … ${value.length - 5} more` : ''}]`;
  }
  const name = value.constructor && value.constructor !== Object ? value.constructor.name : '';
  if (depth > 1) return name || '{…}';
  const keys = Object.keys(value);
  const shown = keys.slice(0, 5).map((key) => `${key}: ${preview(value[key], depth + 1)}`);
  return `${name ? `${name} ` : ''}{${shown.join(', ')}${keys.length > 5 ? ', …' : ''}}`;
}

/**
 * Names for the signals a component can read: its props and named script signals, and the
 * property signals of the arrays and objects they hold (`items[0].done`, `items.length`).
 */
function namer(record) {
  const names = new Map();
  for (const [name, signal] of Object.entries(record.props)) names.set(signal, name);
  for (const [name, signal] of Object.entries(record.named ?? {})) if (signal && typeof signal === 'object') names.set(signal, name);
  const paths = new Map(); // raw object → path
  const walk = (value, path, depth) => {
    value = raw(value);
    if (!value || typeof value !== 'object' || paths.has(value) || depth > 3) return;
    paths.set(value, path);
    if (Array.isArray(value)) value.slice(0, 200).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      for (const key of Object.keys(value).slice(0, 50)) walk(value[key], `${path}.${key}`, depth + 1);
    }
  };
  for (const [signal, name] of names) {
    try { walk(untrack(() => signal.get()), name, 0); } catch {}
  }
  return (signal) => {
    if (names.has(signal)) return names.get(signal);
    const property = deep.propertyOf.get(signal);
    if (!property) return null;
    const path = paths.get(property.target);
    if (!path) return null;
    const { key } = property;
    if (typeof key === 'symbol') return path; // its keys
    return /^\d+$/.test(key) ? `${path}[${key}]` : `${path}.${key}`;
  };
}

/** The named signals `sink` reads, looking through unnamed computeds to the names behind them. */
function dependencies(sink, name) {
  const found = [];
  const seen = new Set();
  const visit = (node, depth) => {
    let sources;
    try { sources = introspectSources(node); } catch { return; }
    for (const source of sources) {
      if (seen.has(source)) continue;
      seen.add(source);
      const label = name(source);
      if (label) {
        if (!found.includes(label)) found.push(label);
      } else if (isComputed(source) && depth < 6) visit(source, depth + 1);
    }
  };
  visit(sink, 0);
  return found;
}

const location = (part) => (Array.isArray(part?.at) ? { line: part.at[0], column: part.at[1] } : null);

/** One binding as the pane shows it. */
function binding(part, node, effect, name, selected) {
  return {
    operation: operation(part),
    target: describe(node),
    at: location(part),
    dependsOn: effect ? dependencies(effect.computed, name) : [],
    ranLast: !!effect && last.ran.has(effect),
    here: node === selected || (node?.nodeType !== 1 && node?.parentNode === selected),
  };
}

/** What the pane shows for `node`: its component, and that component's state and bindings. */
export function inspect(node) {
  if (!node) return { version: 1, component: null };
  const host = hostOf(node);
  if (!host) return { version: 1, component: null, native: isNative };
  const record = elements.get(host);
  watch(record);
  const name = namer(record);
  const effects = record.scope ? effectsOf(record.scope) : [];
  const bindings = effects
    .filter((effect) => effect.label)
    .map((effect) => binding(effect.label.part, effect.label.node, effect, name, node));
  // Listeners on the selected node (on the host itself, they're its parent's: see `setBy`).
  if (node !== host) for (const part of listeners.get(node) ?? []) bindings.unshift(binding(part, node, null, name, node));
  // The selected node is itself a component: what its parent binds onto it (its props, its events).
  let setBy = null;
  const parent = node === host ? hostOf(host, true) : null;
  if (parent) {
    const parentRecord = elements.get(parent);
    const parentName = namer(parentRecord);
    const onto = (parentRecord.scope ? effectsOf(parentRecord.scope) : [])
      .filter((effect) => effect.label?.node === host)
      .map((effect) => binding(effect.label.part, host, effect, parentName, host));
    for (const part of listeners.get(host) ?? []) onto.push(binding(part, host, null, parentName, host));
    if (onto.length) setBy = { tag: parentRecord.tag, file: parentRecord.definition.source?.file ?? null, bindings: onto };
  }
  const values = (entries) => entries.map(([key, signal]) => ({ name: key, value: preview(signal) }));
  const written = [...last.written].map(name).filter(Boolean);
  return {
    version: 1,
    native: isNative,
    update: updates,
    component: {
      tag: record.tag,
      file: record.definition.source?.file ?? null,
      at: location(record.definition.source),
      located: !!record.definition.source,
    },
    props: values(Object.entries(record.props)),
    state: values(Object.entries(record.named ?? {}).filter(([, signal]) => signal && typeof signal === 'object')),
    bindings,
    setBy,
    lastUpdate: {
      number: updates,
      written: [...new Set(written)],
      ran: bindings.filter((item) => item.ranLast).length,
    },
  };
}

/** Open `file` at `line` and `column` in the editor, through Vite's dev server. */
export function open(file, line = 1, column = 1) {
  return fetch(`/__open-in-editor?file=${encodeURIComponent(`${file}:${line}:${column}`)}`).then((response) => response.ok, () => false);
}

// (defineProperties, not Object.assign, which would copy the getter's value once.)
Object.defineProperties(globalThis.__ZUBRA_DEVTOOLS__, {
  ready: { value: true, enumerable: true },
  inspect: { value: inspect, enumerable: true },
  open: { value: open, enumerable: true },
  /** Counts flushes since connecting: the pane re-reads when it changes. */
  updates: { get: () => updates, enumerable: true },
});
