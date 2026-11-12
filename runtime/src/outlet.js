// Outlets (experimental): a place in a Zubra component where the app's framework renders its
// own components, with the app's context, state and events, through a portal.
//
//   <!-- row-list.zb -->
//   <zb-each items={items} as="item" key={item.id}>
//     <li><zb-outlet name="row" item={item}></zb-outlet></li>
//   </zb-each>
//
//   // React
//   <RowList items={rows} renderRow={(item) => <Row item={item} />} />
//
// Slots let the consumer put content *in* a component; an outlet lets the component ask the
// consumer for content *per item*, which is what render props and scoped slots do inside one
// framework. The component stays the owner of the structure (the list, its keys, its order);
// the framework renders what goes in each outlet, as a portal, so React context, hooks and
// event handlers work there as anywhere else in the app.
//
// Protocol: a connected `<zb-outlet>` fires a bubbling, composed `outletconnect` event. A
// listener that serves outlets of that name calls `event.claim({ change, disconnect })` and
// stops it: `change(outlet)` is called when the outlet's `item` changes, `disconnect(outlet)`
// when it leaves the document. Outlets connected before anyone listened are found with
// `outletsOf(host)`. A keyed move disconnects and reconnects the outlet node itself, so a
// renderer that keys its portal by the node (as the React adapter does) keeps what's in it.
const Base = globalThis.HTMLElement ?? class {};

export class ZubraOutletElement extends Base {
  #item = undefined;
  /** Who renders into this outlet: `{ change, disconnect }`, or null. */
  owner = null;

  /** Which of the consumer's renderers fills it. */
  get name() {
    return this.getAttribute('name') ?? '';
  }

  /** The data the component gives the renderer for this outlet. */
  get item() {
    return this.#item;
  }

  set item(value) {
    if (Object.is(value, this.#item)) return;
    this.#item = value;
    this.owner?.change(this);
  }

  connectedCallback() {
    if (!this.style.display) this.style.display = 'contents';
    if (this.owner) return;
    const event = new Event('outletconnect', { bubbles: true, composed: true });
    event.outlet = this;
    event.claim = (owner) => {
      this.owner = owner;
      event.stopPropagation();
    };
    this.dispatchEvent(event);
  }

  disconnectedCallback() {
    const owner = this.owner;
    this.owner = null;
    owner?.disconnect(this);
  }
}

/** The unclaimed outlets inside `host` (its light DOM and its shadow root), in document order. */
export function outletsOf(host) {
  const found = [...host.querySelectorAll('zb-outlet')];
  if (host.shadowRoot) found.push(...host.shadowRoot.querySelectorAll('zb-outlet'));
  return found.filter((outlet) => !outlet.owner);
}

/** Define `<zb-outlet>` (once; a no-op without `customElements`). */
export function defineOutletElement() {
  const registry = globalThis.customElements;
  if (registry && !registry.get('zb-outlet')) registry.define('zb-outlet', ZubraOutletElement);
}

defineOutletElement();
