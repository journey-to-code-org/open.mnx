// A table of records. `columns` is `[{ key, label, sortable?, type? }]` (`type` "money" or
// "status"); `rows` is the records, each with an `id`. A sortable column's header sorts by it,
// ascending then descending. Each row's View button fires `rowselect` with the row's id.
import { LitElement, css, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import './ds-badge.js';

export class DsTable extends LitElement {
  static properties = {
    caption: {},
    columns: { type: Array },
    rows: { type: Array },
    sortKey: { state: true },
    descending: { state: true },
  };
  static styles = css`
    table { width: 100%; border-collapse: collapse; }
    caption { text-align: left; font-weight: 600; padding-bottom: 0.5rem; }
    th, td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--line, #d5d9e2); }
    th button { font: inherit; font-weight: inherit; border: 0; background: none; padding: 0; cursor: pointer; }
    th[aria-sort=ascending] button::after { content: " ▲"; }
    th[aria-sort=descending] button::after { content: " ▼"; }
    td button { border: 1px solid var(--line, #d5d9e2); border-radius: 0.4rem; background: var(--surface, #fff); cursor: pointer; }
  `;
  constructor() {
    super();
    this.caption = '';
    this.columns = [];
    this.rows = [];
    this.sortKey = '';
    this.descending = false;
  }
  get #sorted() {
    const key = this.sortKey;
    if (!key) return this.rows;
    const compare = (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
    return [...this.rows].sort((a, b) => (this.descending ? compare(b, a) : compare(a, b)));
  }
  #sortBy(key) {
    this.descending = this.sortKey === key ? !this.descending : false;
    this.sortKey = key;
  }
  #cell(row, column) {
    if (column.type === 'status') return html`<ds-badge status=${row[column.key]}></ds-badge>`;
    if (column.type === 'money') return `$${row[column.key].toFixed(2)}`;
    return row[column.key];
  }
  render() {
    return html`
      <table>
        <caption>${this.caption}</caption>
        <thead>
          <tr>
            ${repeat(this.columns, (column) => column.key, (column) => html`
              <th scope="col" aria-sort=${column.key !== this.sortKey ? nothing : this.descending ? 'descending' : 'ascending'}>
                ${column.sortable
                  ? html`<button type="button" @click=${() => this.#sortBy(column.key)}>${column.label}</button>`
                  : html`<span>${column.label}</span>`}
              </th>
            `)}
            <th scope="col"><span>Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${repeat(this.#sorted, (row) => row.id, (row) => html`
            <tr>
              ${this.columns.map((column) => html`<td>${this.#cell(row, column)}</td>`)}
              <td><button type="button" aria-label="View order ${row.id}"
                          @click=${() => this.dispatchEvent(new CustomEvent('rowselect', { detail: row.id, bubbles: true, composed: true }))}>View</button></td>
            </tr>
          `)}
        </tbody>
      </table>
    `;
  }
}
customElements.define('ds-table', DsTable);
