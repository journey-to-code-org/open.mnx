export interface Prop {
  name: string;
  /** The attribute, or null for a property-only prop. */
  attribute: string | null;
  type: string;
  default: unknown;
  description?: string;
}

export interface Component {
  tag: string;
  name: string;
  description: string;
  props: Prop[];
  events: { name: string; detail: string | null; description?: string }[];
  slots: string[];
  /** Props with a `<prop>change` event: two-way. */
  models: string[];
  module: string;
  /** Where it was loaded from (a manifest, a folder, a package name). */
  origin: string;
}

export type Framework = 'html' | 'react' | 'vue' | 'svelte' | 'solid' | 'angular';

/** Components from a Custom Elements Manifest. */
export declare function fromManifest(manifest: object, origin?: string): Component[];
/** Components from manifests, component folders or installed packages. */
export declare function loadComponents(sources: string[], options?: { cwd?: string }): Component[];
/** How to use a component from a framework. */
export declare function usage(component: Component, framework?: Framework, from?: string): string;
/** Props a component doesn't have and events it doesn't fire, in markup. */
export declare function check(components: Component[], markup: string): { tag: string; attribute: string; problem: string; suggestion: string | null }[];
/** Answer one JSON-RPC message (null for a notification). */
export declare function handle(components: Component[], message: object): object | null;
/** Serve MCP over standard input and output until input ends. */
export declare function serve(components: Component[], streams?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Promise<void>;
