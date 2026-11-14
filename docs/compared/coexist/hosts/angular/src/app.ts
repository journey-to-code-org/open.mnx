// The order desk in Angular, which uses the elements as they are: [property] in, (event) out.
// `ds` defines them, for whichever tool built them (impl/<tool>/elements.*).
import { Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, computed, signal, viewChild } from '@angular/core';
import 'ds';
// @ts-ignore: plain JavaScript shared by every host
import { COLUMNS, PRICE, TABS, money, orderFrom, seed } from '../../../shared/data.js';

interface Order { id: number; customer: string; quantity: number; total: number; status: string }

@Component({
  selector: 'order-desk',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <main>
      <h1>Order desk</h1>
      <ds-tabs label="Sections" [tabs]="tabs" [selected]="tab()" (selectedchange)="tab.set($event.detail)"></ds-tabs>
      <div role="tabpanel" aria-label="Orders" [hidden]="tab() !== 'orders'">
        <p data-testid="summary">{{ orders().length }} orders, {{ shipped() }} shipped</p>
        <ds-table caption="Orders" [columns]="columns" [rows]="orders()" (rowselect)="view($event.detail)"></ds-table>
      </div>
      <div role="tabpanel" aria-label="New order" [hidden]="tab() !== 'new'">
        <form #form novalidate (submit)="add($event)">
          <ds-field label="Customer" name="customer" [required]="true" [value]="customer()" [error]="error()" (valuechange)="customer.set($event.detail)"></ds-field>
          <ds-quantity label="Quantity" name="quantity" [min]="1" [max]="10" [value]="quantity()" (valuechange)="quantity.set($event.detail)"></ds-quantity>
          <p data-testid="total">Total: {{ money(quantity() * price) }}</p>
          <button type="submit">Add order</button>
        </form>
      </div>
      <ds-dialog [heading]="order() ? 'Order ' + order()!.id : ''" [open]="open()" (openchange)="open.set($event.detail)">
        @if (order(); as item) {
          <div>
            <p data-testid="detail">{{ item.customer }}: {{ item.quantity }} × Trail mug, {{ money(item.total) }}</p>
            <p><ds-badge [status]="item.status"></ds-badge></p>
            <button type="button" [disabled]="item.status !== 'pending'" (click)="ship()">Mark shipped</button>
          </div>
        }
      </ds-dialog>
      <p role="status">{{ message() }}</p>
    </main>
  `,
})
export class App {
  readonly tabs = TABS;
  readonly columns = COLUMNS;
  readonly price = PRICE;
  readonly money = money;
  orders = signal<Order[]>(seed());
  tab = signal('orders');
  customer = signal('');
  quantity = signal(1);
  error = signal('');
  viewing = signal<number | null>(null);
  open = signal(false);
  message = signal('');
  form = viewChild.required<ElementRef<HTMLFormElement>>('form');
  order = computed(() => this.orders().find((item) => item.id === this.viewing()));
  shipped = computed(() => this.orders().filter((item) => item.status === 'shipped').length);

  add(event: Event) {
    event.preventDefault();
    const next: Order = orderFrom(new FormData(this.form().nativeElement), this.orders());
    if (!next.customer) return this.error.set('Customer is required');
    this.orders.update((orders) => [...orders, next]);
    this.message.set(`Added order ${next.id} for ${next.customer}`);
    this.error.set('');
    this.customer.set('');
    this.quantity.set(1);
    this.tab.set('orders');
  }
  view(id: number) {
    this.viewing.set(id);
    this.open.set(true);
  }
  ship() {
    this.orders.update((orders) => orders.map((item) => (item.id === this.viewing() ? { ...item, status: 'shipped' } : item)));
    this.message.set(`Order ${this.viewing()} shipped`);
    this.open.set(false);
  }
}
