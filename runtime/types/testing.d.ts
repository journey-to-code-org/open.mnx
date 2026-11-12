import type { ZubraElementClass } from './index.js';

export type Framework = 'html' | 'react' | 'vue';

/** The frameworks that can be mounted here: `html` always, `react` and `vue` when installed. */
export declare function frameworks(): Promise<Framework[]>;

export interface MountOptions {
  framework?: Framework;
  props?: Record<string, unknown>;
  /** Text for each slot: `{ default: 'Body', title: 'Heading' }`. */
  slots?: Record<string, string>;
  /** Where to mount (default: a new <div> in <body>, removed on unmount). */
  container?: HTMLElement;
}

export interface Mounted<E extends HTMLElement = HTMLElement> {
  readonly framework: Framework;
  readonly host: HTMLElement;
  /** The component's host element. */
  readonly element: E;
  /** The `detail` of each `name` event so far, as the framework's handler got it; with no name, every event as `[name, detail]`. */
  events(name: string): unknown[];
  events(): [string, unknown][];
  /** Change props through the framework (merged with the current ones), and settle. */
  set(props: Record<string, unknown>): Promise<void>;
  /** Remove it the framework's way. */
  unmount(): void;
}

/** Mount a compiled component through plain HTML, the React adapter or the Vue adapter. */
export declare function mount<E extends HTMLElement>(Element: ZubraElementClass<E>, options?: MountOptions): Promise<Mounted<E>>;
