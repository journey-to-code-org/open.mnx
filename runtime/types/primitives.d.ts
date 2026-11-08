/**
 * One tab stop for a group of items, with the arrow keys, Home and End moving focus among them
 * (the roving tabindex). Returns a cleanup.
 */
export declare function rovingFocus(
  container: Element,
  options: { selector: string; orientation?: 'vertical' | 'horizontal' | 'both'; loop?: boolean; onMove?: (item: HTMLElement) => void },
): () => void;
/**
 * Type to jump to the next item whose text starts with what was typed. Returns a cleanup.
 */
export declare function typeahead(
  container: Element,
  options: { selector: string; text?: (item: HTMLElement) => string; timeout?: number; onMatch?: (item: HTMLElement) => void },
): () => void;
