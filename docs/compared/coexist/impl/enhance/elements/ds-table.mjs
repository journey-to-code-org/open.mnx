// A table of records. `columns` is `[{ key, label, sortable?, type? }]` (`type` "money" or
// "status"); `rows` is the records, each with an `id`. `sort` and `descending` are the
// element's own state in the browser.
import { esc, read } from '../read.mjs';
import DsBadge from './ds-badge.mjs';

export default function DsTable({ html, state }) {
  const caption = read(state, 'caption', '');
  const columns = read(state, 'columns', []);
  const rows = read(state, 'rows', []);
  const sort = read(state, 'sort', '');
  const descending = read(state, 'descending', false);
  const compare = (a, b) => (a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0);
  const sorted = sort ? [...rows].sort((a, b) => (descending ? compare(b, a) : compare(a, b))) : rows;
  const cell = (row, column) => {
    // A nested element is written out with its content, as @enhance/ssr would expand it.
    if (column.type === 'status') return `<ds-badge status="${esc(row[column.key])}">${DsBadge({ html, state: { attrs: { status: row[column.key] } } }).replace(/<style>[\s\S]*?<\/style>/, '')}</ds-badge>`;
    if (column.type === 'money') return `$${row[column.key].toFixed(2)}`;
    return esc(row[column.key]);
  };
  return html`
    <style>
      ds-table table { width: 100%; border-collapse: collapse; }
      ds-table caption { text-align: left; font-weight: 600; padding-bottom: 0.5rem; }
      ds-table th, ds-table td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--line, #d5d9e2); }
      ds-table th button { font: inherit; font-weight: inherit; border: 0; background: none; padding: 0; cursor: pointer; }
      ds-table th[aria-sort=ascending] button::after { content: " ▲"; }
      ds-table th[aria-sort=descending] button::after { content: " ▼"; }
      ds-table td button { border: 1px solid var(--line, #d5d9e2); border-radius: 0.4rem; background: var(--surface, #fff); cursor: pointer; }
    </style>
    <table>
      <caption>${esc(caption)}</caption>
      <thead>
        <tr>
          ${columns.map((column) => `<th scope="col" ${column.key === sort ? `aria-sort="${descending ? 'descending' : 'ascending'}"` : ''}>${column.sortable ? `<button type="button" data-sort="${esc(column.key)}">${esc(column.label)}</button>` : `<span>${esc(column.label)}</span>`}</th>`).join('')}
          <th scope="col"><span>Actions</span></th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((row) => `<tr id="row-${esc(row.id)}">${columns.map((column) => `<td>${cell(row, column)}</td>`).join('')}<td><button type="button" data-view="${esc(row.id)}" aria-label="View order ${esc(row.id)}">View</button></td></tr>`).join('')}
      </tbody>
    </table>
  `;
}
