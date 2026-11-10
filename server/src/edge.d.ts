import type { Compiler } from '@zubra/compiler/wasm';
import type { ComponentInfo, Page, PropInfo } from './index.js';

export type { ComponentInfo, PropInfo };

/** A page on a host without Node: as Node's, minus `stream()` (a Node Readable); use `streamResponse()`. */
export type EdgePage = Omit<Page, 'stream'>;

export interface EdgeZubra {
  /** The components given, by name. */
  readonly names: string[];
  describe(name: string): ComponentInfo;
  render(name: string, props?: Record<string, unknown>, slots?: Record<string, string>): string;
  page(): EdgePage;
  /** A Response for the components' browser modules under the prefix, or null for any other request. */
  fetch(request: Request): Promise<Response | null>;
  importMap(): string;
  head(names?: string[]): string;
  scripts(names?: string[]): string;
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
}

export declare function createZubra(options: EdgeOptions): EdgeZubra;
export declare function parseAttributes(text: string): Record<string, string>;
export declare function propsFrom(attributeText: string, info: ComponentInfo): Record<string, unknown>;
