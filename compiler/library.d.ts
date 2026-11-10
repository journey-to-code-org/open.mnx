export interface LibraryOptions {
  /** The output directory (replaced). Default: `dist`. */
  out?: string;
  /** The package's name and version; default: the current directory's package.json. */
  name?: string;
  version?: string;
  /** The runtime module the elements import. Default: `@zubra/runtime`. */
  runtime?: string;
  /**
   * Compile for the Zubra DevTools extension (it records source paths): for a demo or staging
   * build, not a library you publish. Default: `ZUBRA_DEVTOOLS=1`.
   */
  devtools?: boolean;
}

export interface LibraryComponent {
  tag: string;
  /** The element's class name, as exported from the package's index. */
  name: string;
  /** The module path, without extension, relative to the output directory. */
  module: string;
}

/** Compile every component under `dir` into a publishable package (see library.js). */
export declare function buildLibrary(dir: string, options?: LibraryOptions): { components: LibraryComponent[]; warnings: string[] };
