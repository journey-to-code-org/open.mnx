/** What a router is told about a routed link. */
export interface RoutedLink {
  event: MouseEvent;
  anchor: HTMLAnchorElement;
  url: URL;
}

export interface RouteLinksOptions {
  /** Which ancestors make a link routed (default: a Zubra component's host). */
  within?(node: Element): boolean;
  /** Where to listen (default: the document). */
  root?: Document | Element;
}

/** Whether `node` is a Zubra component's host. */
export declare function isComponent(node: unknown): boolean;

/**
 * Route clicks on links inside Zubra components through `navigate(to)`, where `to` is the path,
 * query and hash. Returns a function that stops it.
 */
export declare function routeLinks(navigate: (to: string, link: RoutedLink) => unknown, options?: RouteLinksOptions): () => void;
