// A FAST Element 3 app (in its own shadow root) built from zubra elements: the registry's
// quantity stepper and a price that reads the currency from FAST's context. Data goes down as
// :prop bindings and comes back up as the elements' valuechange events.
import { FASTElement, css, html, observable, repeat } from '@microsoft/fast-element';
import { Context } from '@microsoft/fast-element/context.js';
import { currency } from './currency.js';
import './components/quantity-stepper.zb';
import './components/line-price.zb';

const START = [
  { id: 'beans', name: 'Coffee beans', price: 14.5, qty: 1 },
  { id: 'filters', name: 'Paper filters', price: 3.25, qty: 2 },
  { id: 'mug', name: 'Enamel mug', price: 9, qty: 1 },
];

const line = html`
  <li data-line=${(l) => l.id}>
    <span class="name">${(l) => l.name}</span>
    <quantity-stepper
      :value=${(l) => l.qty}
      label=${(l) => l.name}
      @valuechange=${(l, c) => c.parent.setQty(l.id, c.event.detail)}
    ></quantity-stepper>
    <line-price :amount=${(l) => l.qty * l.price}></line-price>
  </li>
`;

const template = html`
  <h1>Order</h1>
  <ul>${repeat((x) => x.lines, line)}</ul>
  <p class="total">Total <line-price :amount=${(x) => x.lines.reduce((sum, l) => sum + l.qty * l.price, 0)}></line-price></p>
  <button type="button" class="reset" @click=${(x) => x.reset()}>Reset</button>
`;

const styles = css`
  :host { display: block; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
  ul { list-style: none; padding: 0; }
  li { display: grid; grid-template-columns: 1fr auto 6rem; align-items: center; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid #e5e5ea; }
  line-price { text-align: end; }
  .total { display: flex; justify-content: space-between; font-weight: 700; }
`;

export class OrderSheet extends FASTElement {
  lines = START.map((l) => ({ ...l }));

  connectedCallback() {
    // The page's currency, for every element inside (the zubra prices read it with inject()).
    Context.provide(this, currency, this.getAttribute('currency') ?? 'USD');
    super.connectedCallback();
  }

  setQty(id, qty) {
    this.lines = this.lines.map((l) => (l.id === id ? { ...l, qty } : l));
  }

  reset() {
    this.lines = START.map((l) => ({ ...l }));
  }
}
observable(OrderSheet.prototype, 'lines');

OrderSheet.define({ name: 'order-sheet', template, styles });
