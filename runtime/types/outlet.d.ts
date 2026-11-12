/**
 * `<zb-outlet name="…" item={…}>` (experimental): a place in a component where the app's framework
 * renders its own content for `item`, through a portal. The React adapter fills it from a
 * `render<Name>` prop.
 */
export declare class ZubraOutletElement extends HTMLElement {
  readonly name: string;
  item: unknown;
  /** Who renders into this outlet, once claimed. */
  owner: { change(outlet: ZubraOutletElement): void; disconnect(outlet: ZubraOutletElement): void } | null;
}

/** The unclaimed outlets inside `host` (light DOM and shadow root). */
export declare function outletsOf(host: Element): ZubraOutletElement[];

/** Define `<zb-outlet>` (done on import; a no-op without `customElements`). */
export declare function defineOutletElement(): void;

declare global {
  interface HTMLElementTagNameMap {
    'zb-outlet': ZubraOutletElement;
  }
}
