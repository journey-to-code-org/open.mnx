/** One type error, placed in the `.zb` file it came from when it came from one. */
export interface TypeDiagnostic {
  file: string;
  line: number;
  column: number;
  /** `TS2322`, or `zubra` for a component that doesn't compile. */
  code: string;
  message: string;
}

/** The `.zb` files in `paths` (files, or folders searched without node_modules). */
export function components(paths: string[]): string[];

/** The project's own `tsc` (from its `typescript` package). */
export function findTsc(from: string): string;

/**
 * Have the project's TypeScript check the components in `paths` (files or folders): their
 * scripts, every template expression, child props and event handlers.
 */
export function checkTypes(
  paths: string[],
  options?: {
    root?: string;
    tsc?: string;
    /** Keep the generated files (in `out`) afterwards. */
    keep?: boolean;
    /** Where the generated files go: `.zubra-types` at the root by default. */
    out?: string;
    /** A folder of its own inside `.zubra-types`, for a check running beside another. */
    folder?: string;
    /** Text to check in place of what's on disk, by path (an editor's unsaved files). */
    texts?: Record<string, string>;
  },
): { diagnostics: TypeDiagnostic[]; checked: number; out: string };

/** `file:line:column - error TS1234: message`. */
export function formatDiagnostic(diagnostic: TypeDiagnostic, cwd?: string): string;
