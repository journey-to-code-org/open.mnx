export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  help: string | null;
}

export interface Response {
  ok: boolean;
  /** The compiled text (null for `command: 'check'` or on error). */
  output: string | null;
  /** The error, rendered for a terminal. */
  error: string | null;
  /** Warnings, rendered for a terminal. */
  warnings: string[];
  /** Every error and warning, for editors. */
  diagnostics: Diagnostic[];
}

export interface Options {
  command?: 'compile' | 'check';
  emit?: 'html' | 'js' | 'css' | 'dts' | 'manifest' | 'html-data' | 'interface';
  runtime?: string;
  keepImports?: boolean;
  noImports?: boolean;
  cssImport?: string;
  cssImportInline?: string;
  framework?: 'react' | 'vue' | 'svelte' | 'solid' | 'none';
  modulePath?: string;
  props?: Record<string, unknown>;
  slots?: Record<string, string>;
  /** What `slots` is written in: zubra template syntax (the default here) or rendered HTML. */
  slotSource?: 'template' | 'html';
  /** For `emit: 'html'`: leave what only the browser can compute for the element. */
  partial?: boolean;
}

export interface Request extends Options {
  path: string;
  /** Every source the compilation needs, by absolute path. */
  files: Record<string, string>;
}

/** The text of zubra's hydration-marker comments, for tools that remove comments: keep these. */
export declare const ZUBRA_MARKER_COMMENT: RegExp;
export declare function available(): boolean;
export declare function request(request: Request): Response;
export declare function sources(path: string, files?: Record<string, string>): Record<string, string>;
export declare function compileFile(path: string, options?: Options): Response;

export interface RenderOptions {
  /** The host's prop values. */
  props?: Record<string, unknown>;
  /** Supplied content by slot name (`default` for unnamed content). */
  slots?: Record<string, string>;
  /** What `slots` is written in: rendered HTML, kept as written (the default), or zubra template syntax. */
  slotSource?: 'html' | 'template';
  /** Leave what only the browser can compute for the element (the default), instead of an error. */
  partial?: boolean;
  /** The sources, by absolute path, instead of reading them from disk. */
  files?: Record<string, string>;
}

export interface Rendered {
  /** The server-rendered markup, which the element hydrates. */
  html: string;
  /** The scoped stylesheets of the component and the components it uses. */
  css: string;
  warnings: string[];
}

export declare class CompileError extends Error {
  diagnostics: Diagnostic[];
}

/** Server-render a component. Throws a `CompileError` on errors. */
export declare function render(path: string, options?: RenderOptions): Rendered;
/** A component's server-rendered HTML. Throws a `CompileError` on errors. */
export declare function renderToString(path: string, options?: RenderOptions): string;
