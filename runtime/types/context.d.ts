/**
 * `<zb-context>`: answers the Context Protocol for the elements inside it. Set `context` (a key
 * from `createContext()`, or any protocol key) and `value` (a value or a signal).
 */
export declare class ZubraContextElement extends HTMLElement {
  context: unknown;
  value: unknown;
}

/** Define `<zb-context>` (done on import; a no-op without `customElements`). */
export declare function defineContextElement(): void;

declare global {
  interface HTMLElementTagNameMap {
    'zb-context': ZubraContextElement;
  }
}
