export interface PropInfo { name: string; attribute: string; type: string; default: unknown; model: boolean; required: boolean }
export interface ComponentInfo { tag: string; shadow: boolean; form: boolean; props: PropInfo[]; events: string[] }

export interface Page {
  /** The components this page rendered, in order. */
  readonly used: string[];
  /** A component's server-rendered HTML (by its file name, or its tag). */
  render(name: string, props?: Record<string, unknown>, slots?: Record<string, string>): string;
  /** The used components' CSS and the import map, for `<head>`. */
  head(): string;
  /** The module script that hydrates the used components, for the end of `<body>`. */
  scripts(): string;
  /** A whole page with `head()` put before `</head>` and `scripts()` before `</body>`. */
  finish(html: string): string;
  /**
   * Whether a rendered component was given a promise as a prop. Such a prop renders as pending
   * (its `mnx-await` shows its pending content); `stream()` sends the resolved region with the
   * value after the page.
   */
  readonly pending: boolean;
  /** The page as a Node stream: `finish(html)`, then each resolved region as its promise settles. */
  stream(html: string): import('node:stream').Readable;
  /** The same as a web `Response` (fetch-style servers). */
  streamResponse(html: string, init?: ResponseInit): Response;
}

export interface Mnx {
  /** The components found, by file name (without the extension). */
  readonly names: string[];
  describe(name: string): ComponentInfo;
  render(name: string, props?: Record<string, unknown>, slots?: Record<string, string>): string;
  /** One page's renders, CSS and scripts. */
  page(): Page;
  /** Node's http: serves the browser modules and runtime under the prefix; true when it answered. */
  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): boolean;
  /** Fetch-style servers: a Response for the prefix's paths, or null. */
  fetch(request: Request): Promise<Response | null>;
  importMap(): string;
  head(names?: string[]): string;
  scripts(names?: string[]): string;
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
  /** Static sites: write the browser modules and @mnx/runtime under `dir` (at `<dir>/_mnx/…`). */
  writeAssets(dir: string): void;
}

export interface MnxOptions {
  /** The folder of components (default `components`). */
  components?: string;
  /** Where the browser modules are served (default `/_mnx`). */
  prefix?: string;
  /** Keep compiled output (default true); false recompiles on every request, for development. */
  cache?: boolean;
  /** Serve the runtime's production build, without hot reloading (default: `NODE_ENV` is `production`). */
  production?: boolean;
}

export declare function createMnx(options?: MnxOptions): Mnx;
export declare function parseAttributes(text: string): Record<string, string>;
export declare function propsFrom(attributeText: string, info: ComponentInfo): Record<string, unknown>;
/** The compiler @mnx/compiler will use (`{ kind: 'WebAssembly' | 'CLI', path }`), or null. */
export declare function findCompiler(): { kind: 'WebAssembly' | 'CLI'; path: string } | null;
