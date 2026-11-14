// A table of records. `columns` is `[{ key, label, sortable?, type? }]` (`type` "money" or
// "status"); `rows` is the records, each with an `id`. A sortable column's header sorts by it,
// ascending then descending. Each row's View button fires `rowselect` with the row's id.
import { Component, Event, EventEmitter, Prop, State, h } from '@stencil/core';

interface Column { key: string; label: string; sortable?: boolean; type?: 'money' | 'status' }
type Row = Record<string, any>;

@Component({ tag: 'ds-table', styleUrl: 'ds-table.css', shadow: true })
export class DsTable {
  @Prop() caption: string = '';
  @Prop() columns: Column[] | string = [];
  @Prop() rows: Row[] | string = [];
  @State() sortKey: string = '';
  @State() descending: boolean = false;
  @Event({ eventName: 'rowselect' }) rowSelect: EventEmitter<number>;

  // Arrays arrive as properties from a framework and as JSON attributes in server HTML.
  private list<T>(value: T[] | string): T[] {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }
  private sorted(): Row[] {
    const rows = this.list(this.rows);
    const key = this.sortKey;
    if (!key) return rows;
    const compare = (a: Row, b: Row) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
    return [...rows].sort((a, b) => (this.descending ? compare(b, a) : compare(a, b)));
  }
  private sortBy(key: string) {
    this.descending = this.sortKey === key ? !this.descending : false;
    this.sortKey = key;
  }
  private cell(row: Row, column: Column) {
    if (column.type === 'status') return <ds-badge status={row[column.key]}></ds-badge>;
    if (column.type === 'money') return `$${row[column.key].toFixed(2)}`;
    return row[column.key];
  }

  render() {
    const columns = this.list(this.columns);
    return (
      <table>
        <caption>{this.caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.key} aria-sort={column.key !== this.sortKey ? null : this.descending ? 'descending' : 'ascending'}>
                {column.sortable
                  ? <button type="button" onClick={() => this.sortBy(column.key)}>{column.label}</button>
                  : <span>{column.label}</span>}
              </th>
            ))}
            <th scope="col"><span>Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {this.sorted().map((row) => (
            <tr key={row.id}>
              {columns.map((column) => <td>{this.cell(row, column)}</td>)}
              <td><button type="button" aria-label={`View order ${row.id}`} onClick={() => this.rowSelect.emit(row.id)}>View</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
}
