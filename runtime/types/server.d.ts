import type { MnxElementClass } from './index.js';

export interface RenderOptions {
  /** The element's prop values (JSON). */
  props?: Record<string, unknown>;
  /** Other attributes for the host (`class`, `id`, …). `true` writes a boolean attribute; `false` and nullish are left out. */
  attributes?: Record<string, string | number | boolean | null | undefined>;
  /** Supplied content by slot name (`default` for unnamed content), as HTML. */
  slots?: Record<string, string>;
}

/** Register how to server-render `tag`. Called by the build plugin's server output. */
export declare function registerRenderer(tag: string, render: (props: Record<string, unknown>, slots: Record<string, string>) => string): void;
/** Whether `Element` is an mnx element that can be rendered here. */
export declare function canRender(Element: unknown): Element is MnxElementClass;
/** The element's server-rendered HTML, which it hydrates in the browser. */
export declare function renderToString(Element: MnxElementClass, options?: RenderOptions): string;
