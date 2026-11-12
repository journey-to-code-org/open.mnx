export interface EmbedOptions {
  /** Output folder (default `embed`). */
  out?: string;
  /** The entry's and plugin's name (default: package.json's name, as a slug). */
  name?: string;
  /** Where the files will be hosted, for the HTML snippets (default `./`). */
  base?: string;
  /** The runtime's production build (default: the installed @zubra/runtime's). */
  runtimeDir?: string;
}

/** Build the embed folder: one entry script, WordPress plugin, Shopify extension, HTML snippets. */
export declare function buildEmbed(dir: string, options?: EmbedOptions): {
  components: { tag: string; file: string }[];
  files: string[];
};

/** The `@zubra/runtime` production build's folder. */
export declare function runtimeDirectory(from?: string): string;
