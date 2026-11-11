import type * as React from 'react';
import type { ZubraElementClass } from './index.js';

/**
 * A zubra element as a React component (React 18 and 19): props as properties, `on<Event>`
 * handlers for its events, other props and children passed to the element. The build plugin's
 * generated typings give exact prop types; this one is general.
 */
export declare function wrap<E extends HTMLElement>(
  Element: ZubraElementClass<E>,
): React.ForwardRefExoticComponent<
  React.HTMLAttributes<E> & Record<string, unknown> & { children?: React.ReactNode } & React.RefAttributes<E>
> & { readonly element: ZubraElementClass<E> };

/** Route links inside Zubra components through the app's router while mounted. */
export declare function useRouteLinks(
  navigate: (to: string, link: import('./navigation.js').RoutedLink) => unknown,
  options?: import('./navigation.js').RouteLinksOptions,
): void;
