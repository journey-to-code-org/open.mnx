import type { Compiler } from '@zubra/compiler/wasm';
import type { ComponentInfo, Page, PageOptions, PropInfo } from './index.js';

export type { ComponentInfo, PageOptions, PropInfo };

/** A page on a host without Node: as Node's, minus `stream()` (a Node Readable); use `streamResponse()`. */
export type EdgePage = Omit<Page, 'stream'>;

export interface EdgeZubra {
  /** The components given, by name. */
  readonly names: string[];
  describe(name: string): ComponentInfo;
  render(name: string, props?: Record<string, unknown>, slots?: Record<string, string>): string;
  page(options?: PageOptions): EdgePage;
  /** A Response for the components' browser modules under the prefix, or null for any other request. */
  fetch(request: Request): Promise<Response | null>;
  importMap(options?: PageOptions): string;
  head(names?: string[], options?: PageOptions): string;
  scripts(names?: string[], options?: PageOptions): string;
  injectShadowRoots(html: string, options?: { forms?: boolean; lightDom?: boolean }): string;
  /** A component's browser module (JavaScript). */
  module(name: string): string;
}

export interface EdgeOptions {
  /** The compiler's WebAssembly module (`import wasm from '@zubra/compiler/zubra.wasm'` in a Worker). */
  wasm?: WebAssembly.Module;
  /** Or an already made compiler (`createCompiler(wasm)` from `@zubra/compiler/wasm`). */
  compiler?: Compiler;
  /** `{ name: source }`: a name is the path without its extension (`forms/field`), or with it for `.zb.tsx`/`.zb.jsx`. */
  components: Record<string, string>;
  /** Where the browser modules are served (default `/_zubra`). */
  prefix?: string;
  /** Keep compiled output (default true). */
  cache?: boolean;
  /** Compile for the Zubra DevTools (default false: the runtime build they read isn't served from here). */
  devtools?: boolean;
  /** More import map entries; use it to point `@zubra/runtime` at a CDN, or at your static assets. */
  imports?: Record<string, string>;
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
   * `false`: no inline `<style>` or `<script>` in a page's head and scripts, as `createZubra`'s
   * on Node: stylesheet links, module scripts by `src`, and no import map (the components'
   * modules are served with their imports resolved). The runtime files you serve yourself import
   * each other by relative path, so they need nothing. Default `true`.
   */
  inline?: boolean;
}

export declare function createZubra(options: EdgeOptions): EdgeZubra;
export declare function parseAttributes(text: string): Record<string, string>;
export declare function propsFrom(attributeText: string, info: ComponentInfo): Record<string, unknown>;
