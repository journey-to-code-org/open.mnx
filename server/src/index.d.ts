export interface PropInfo { name: string; attribute: string; type: string; default: unknown; model: boolean; required: boolean }
export interface ComponentInfo { tag: string; shadow: boolean; form: boolean; props: PropInfo[]; events: string[] }

export interface PageOptions {
  /**
   * The nonce of this response's Content-Security-Policy (`script-src 'nonce-…'`,
   * `style-src 'nonce-…'`): put on every inline `<style>` and `<script>` the page writes (the
   * components' CSS, the import map, the module script, and a streamed prop's scripts).
   */
  nonce?: string;
}

export interface Page {
  /** The components this page rendered, in order. */
  readonly used: string[];
  /**
   * A component's server-rendered HTML (by its file name, or its tag). `slots` are HTML, kept as
   * written: other components' `render()` output included, so one can be put inside another.
   */
  render(name: string, props?: Record<string, unknown>, slots?: Record<string, string>): string;
  /** The used components' CSS and the import map, for `<head>`. */
  head(): string;
  /** The module script that hydrates the used components, for the end of `<body>`. */
  scripts(): string;
  /** A whole page with `head()` put before `</head>` and `scripts()` before `</body>`. */
  finish(html: string): string;
  /**
   * Whether a rendered component was given a promise as a prop. Such a prop renders as pending
   * (its `zb-await` shows its pending content); `stream()` sends the resolved region with the
   * value after the page.
   */
  readonly pending: boolean;
  /** The page as a Node stream: `finish(html)`, then each resolved region as its promise settles. */
  stream(html: string): import('node:stream').Readable;
  /** The same as a web `Response` (fetch-style servers). */
  streamResponse(html: string, init?: ResponseInit): Response;
}

export interface Zubra {
  /** The components found, by file name (without the extension). */
  readonly names: string[];
  describe(name: string): ComponentInfo;
  render(name: string, props?: Record<string, unknown>, slots?: Record<string, string>): string;
  /** One page's renders, CSS and scripts. */
  page(options?: PageOptions): Page;
  /** Node's http: serves the browser modules and runtime under the prefix; true when it answered. */
  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): boolean;
  /** Fetch-style servers: a Response for the prefix's paths, or null. */
  fetch(request: Request): Promise<Response | null>;
  /** The import map (empty with `inline: false`, where the modules need none). */
  importMap(options?: PageOptions): string;
  head(names?: string[], options?: PageOptions): string;
  scripts(names?: string[], options?: PageOptions): string;
  /**
   * A framework's HTML with each shadow-DOM component's server-rendered template as a declarative
   * shadow root, and a hidden input for form-associated ones with a `name` (`forms: false` leaves
   * those out).
   */
  injectShadowRoots(html: string, options?: { forms?: boolean; lightDom?: boolean }): string;
  /** `injectShadowRoots` as a Node Transform stream, for streamed pages. */
  injectShadowRootsStream(options?: { forms?: boolean; lightDom?: boolean }): import('node:stream').Transform;
  /** A component's browser module (JavaScript). */
  module(name: string): string;
  /**
   * Static sites: write the browser modules and @zubra/runtime under `dir` (at `<dir>/_zubra/…`),
   * and with `inline: false` each component's stylesheet.
   */
  writeAssets(dir: string): void;
}

export interface ZubraOptions {
  /** The folder of components (default `components`). */
  components?: string;
  /** Where the browser modules are served (default `/_zubra`). */
  prefix?: string;
  /** Keep compiled output (default true); false recompiles on every request, for development. */
  cache?: boolean;
  /** Serve the runtime's production build, without hot reloading (default: `NODE_ENV` is `production`). */
  production?: boolean;
  /**
   * Compile for the Zubra DevTools extension and serve the runtime build it reads (default: on,
   * except in production; `ZUBRA_DEVTOOLS=1` turns it on there too).
   */
  devtools?: boolean;
  /**
   * Told when a render leaves out an attribute whose value isn't a safe URL, or leaves part of a
   * component's HTML for the browser (default `console.warn`).
   */
  warn?: (message: string) => void;
  /**
   * `'warn'` (the default): say once, for each place, when a render leaves part of a component's
   * HTML for the browser because the server can't compute it (a list derived through a loop, a
   * formatted date), the same places `zubra check --server` reports. `'ignore'` when that's
   * intended.
   */
  gaps?: 'warn' | 'ignore';
  /**
   * `false`: a page's head and scripts have no inline `<style>` or `<script>`, for a
   * Content-Security-Policy without `'unsafe-inline'` on a site that can't give each response a
   * nonce (a static site). The components' CSS is linked (`<prefix>/components/<name>.css`), each
   * module is a `<script type="module" src>`, and there is no import map: the modules are served
   * (and written by `writeAssets()`) with their imports of `@zubra/runtime`, `@zubra/sync` and
   * `imports` already resolved. A prop given as a promise still needs `page({ nonce })`.
   * Default `true`.
   */
  inline?: boolean;
  /**
   * `false`: a page's head has no `<link rel="modulepreload">` for the modules its components
   * load. By default it has one per module, so the browser fetches them together.
   */
  preload?: boolean;
}

export declare function createZubra(options?: ZubraOptions): Zubra;
export declare function parseAttributes(text: string): Record<string, string>;
export declare function propsFrom(attributeText: string, info: ComponentInfo): Record<string, unknown>;
/** The compiler @zubra/compiler will use (`{ kind: 'WebAssembly' | 'CLI', path }`), or null. */
export declare function findCompiler(): { kind: 'WebAssembly' | 'CLI'; path: string } | null;
