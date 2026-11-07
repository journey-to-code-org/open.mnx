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
  emit?: 'html' | 'js' | 'css' | 'dts' | 'manifest';
  runtime?: string;
  keepImports?: boolean;
  noImports?: boolean;
  cssImport?: string;
  cssImportInline?: string;
  framework?: 'react' | 'vue' | 'none';
  modulePath?: string;
  props?: Record<string, unknown>;
  slots?: Record<string, string>;
}

export interface Request extends Options {
  path: string;
  /** Every source the compilation needs, by absolute path. */
  files: Record<string, string>;
}

export declare function available(): boolean;
export declare function request(request: Request): Response;
export declare function sources(path: string, files?: Record<string, string>): Record<string, string>;
export declare function compileFile(path: string, options?: Options): Response;
