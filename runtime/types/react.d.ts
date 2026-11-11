import type * as React from 'react';
import type { ZubraElementClass } from './index.js';

/**
 * A zubra element as a React component (React 18 and 19): props as properties, `on<Event>`
 * handlers for its events, other props and children passed to the element, and `render<Name>`
 * props that fill the element's `<zb-outlet name>`s (experimental). The build plugin's
 * generated typings give exact prop types; this one is general.
 */
export declare function wrap<E extends HTMLElement>(
  Element: ZubraElementClass<E>,
): React.ForwardRefExoticComponent<
  React.HTMLAttributes<E> & Record<string, unknown> & { children?: React.ReactNode } & React.RefAttributes<E>
> & { readonly element: ZubraElementClass<E> };
