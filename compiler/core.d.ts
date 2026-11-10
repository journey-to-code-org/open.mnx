// @zubra/compiler/wasm: the compiler without a host (no file system, no process), for Cloudflare
// Workers, Deno, browsers and Node. You hand it the compiler's WebAssembly module and the sources.
import type { FormatOptions, RenderOptions, Rendered, Request, Response } from './index.js';

export { CompileError, ZUBRA_MARKER_COMMENT, ZUBRA_MARKER_DIRECTIVE, ZUBRA_MARKER_PATTERN } from './index.js';
export type { Diagnostic, FormatOptions, Options, Rendered, Request, Response } from './index.js';

/** `RenderOptions` where `files` is required: there is no disk to read the sources from. */
export interface PortableRenderOptions extends Omit<RenderOptions, 'files'> {
  /** Every source the render needs, by the path it is imported under, the component itself included. */
  files: Record<string, string>;
}

export interface Compiler {
  /** One request: JSON-shaped in, the response out (the compiler's `request` interface). */
  request(request: Request): Response;
  /** Server-render a component. Throws a `CompileError` on errors. */
  render(path: string, options: PortableRenderOptions): Rendered;
  /** A component's server-rendered HTML. Throws a `CompileError` on errors. */
  renderToString(path: string, options: PortableRenderOptions): string;
  /** `source` laid out as `zubra fmt` does it; throws a `CompileError` when it doesn't parse. */
  format(source: string, options?: FormatOptions): string;
}

/** One request to an instantiated compiler's exports. */
export declare function requestWith(exports: WebAssembly.Exports, body: Request): Response;
/** `render`, `renderToString` and `format` over any `request` function. */
export declare function over(request: (body: Request) => Response): Compiler;
/**
 * A compiler over the WebAssembly module you give it: a `WebAssembly.Module` (what a Worker's
 * bundler gives you for `import wasm from '@zubra/compiler/zubra.wasm'`), an instance, or its exports.
 */
export declare function createCompiler(wasm: WebAssembly.Module | WebAssembly.Instance | WebAssembly.Exports): Compiler;
