// React adapter: an mnx element as a React component, for React 18 and 19.
//
//   import Rating from './rating.mnx'          // the build plugin wraps it for React files
//   <Rating value={stars} onValueChange={(event) => setStars(event.detail)} />
//
// - Props are set as properties (objects and arrays arrive as values, not JSON), already when
//   React 19 creates the element, so its script sees them. A prop that's left out, or was given
//   and then removed, is the component's default.
// - `on<Event>` subscribes to the component's event of that name, in any casing: `valuechange`
//   is `onValueChange`, `onValuechange` or `onvaluechange`. The handler gets the DOM event (the
//   value is in `event.detail`) and can change between renders without re-subscribing.
// - Everything else (className, style, id, aria-*, native event handlers like onClick, ref) is
//   passed to the element itself, and children go into its slots (`slot="name"` for named ones).
// - `value` + `onValueChange` is React's controlled pattern; any `<prop>` + `<prop>change` pair
//   works the same way.
import * as React from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

const clone = (value) => (value && typeof value === 'object' ? structuredClone(value) : value);

/** `mnx-star-rating` → `MnxStarRating`. */
const pascal = (tag) => tag.split(/[-.]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');

// React 18 and older set custom elements' props as attributes under their own names, so
// `className` would become a `classname` attribute; React 19 maps it.
const legacy = Number.parseInt(React.version, 10) < 19;
const attributes = (rest) => {
  if (!legacy) return rest;
  const { className, htmlFor, ...others } = rest;
  if (className !== undefined) others.class = className;
  if (htmlFor !== undefined) others.for = htmlFor;
  return others;
};

/** The given props as JSON for the host's `mnx-props`, or null (none, or not serializable). */
export function propsJson(values) {
  const given = Object.entries(values).filter(([, value]) => value !== undefined && typeof value !== 'function');
  if (!given.length) return null;
  try {
    return JSON.stringify(Object.fromEntries(given));
  } catch {
    return null;
  }
}

export function wrap(Element) {
  const meta = Element?.mnx;
  if (!meta) throw new TypeError('mnx: wrap() needs a compiled mnx element (the default export of a .mnx module)');
  const { tag, props, events } = meta;

  const Component = React.forwardRef(function MnxComponent(all, forwarded) {
    const element = React.useRef(null);
    const values = {};
    const listeners = {};
    const rest = {};
    for (const key of Object.keys(all)) {
      if (key === 'children') continue;
      const event = key.length > 2 && key.startsWith('on') ? key.slice(2).toLowerCase() : null;
      if (Object.hasOwn(props, key)) values[key] = all[key];
      else if (event && events.includes(event)) listeners[event] = all[key];
      else rest[key] = all[key];
    }

    // Subscribe once per event; always call the latest handler.
    const handlers = React.useRef(listeners);
    handlers.current = listeners;
    useIsomorphicLayoutEffect(() => {
      const node = element.current;
      const subscriptions = events.map((name) => {
        const listener = (event) => handlers.current[name]?.(event);
        node.addEventListener(name, listener);
        return () => node.removeEventListener(name, listener);
      });
      return () => subscriptions.forEach((unsubscribe) => unsubscribe());
    }, []);

    // Props as properties, after every render; removed props go back to their defaults.
    const given = React.useRef(new Set());
    useIsomorphicLayoutEffect(() => {
      const node = element.current;
      for (const name of given.current) {
        if (!Object.hasOwn(values, name)) node[name] = clone(props[name].default);
      }
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) node[name] = clone(props[name].default);
        else if (node[name] !== value) node[name] = value;
      }
      given.current = new Set(Object.keys(values));
    });

    const ref = React.useCallback((node) => {
      element.current = node;
      if (typeof forwarded === 'function') forwarded(node);
      else if (forwarded) forwarded.current = node;
    }, [forwarded]);

    // React 19 also sets the props itself when it creates the element, before inserting it, so
    // the component's script sees them when it runs (`let draft = card`). (React 18 would write
    // them as attributes; there, and for later changes and removals, the effect above sets them.)
    const early = legacy || typeof window === 'undefined' ? {} : values;
    // The props as JSON, on the server and in the browser alike (so hydration matches): the
    // element starts with them before React sets them, and @mnx/server's injectShadowRoots
    // renders the element's shadow root from them.
    const json = propsJson(values);
    return React.createElement(tag, { ...early, ...attributes(rest), ...(json ? { 'mnx-props': json } : {}), ref }, all.children);
  });
  Component.displayName = pascal(tag);
  Component.element = Element;
  return Component;
}
