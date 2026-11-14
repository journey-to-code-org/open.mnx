// A tab list. `tabs` is `[{ id, label }]`; `selected` is two-way: it fires `selectedchange` with
// the chosen tab's id. Arrow keys, Home and End move between the tabs and choose the one they
// land on. The panels are the page's.
import { LitElement, css, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

export class DsTabs extends LitElement {
  static properties = { tabs: { type: Array }, selected: {}, label: {} };
  static styles = css`
    [role=tablist] { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line, #d5d9e2); }
    [role=tab] { padding: 0.5rem 0.9rem; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; background: none; color: var(--muted, #667085); font: inherit; font-weight: 600; cursor: pointer; }
    [role=tab][aria-selected=true] { color: var(--ink, #1d2130); border-bottom-color: var(--accent, #2f5fd0); }
  `;
  constructor() {
    super();
    this.tabs = [];
    this.selected = '';
    this.label = '';
  }
  #select(id) {
    this.selected = id;
    this.dispatchEvent(new CustomEvent('selectedchange', { detail: id, bubbles: true, composed: true }));
  }
  async #move(event) {
    const index = this.tabs.findIndex((tab) => tab.id === this.selected);
    const last = this.tabs.length - 1;
    const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index <= 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this.#select(this.tabs[next].id);
    await this.updateComplete;
    this.renderRoot.querySelector('[aria-selected=true]')?.focus();
  }
  render() {
    return html`
      <div role="tablist" aria-label=${this.label || nothing} @keydown=${this.#move}>
        ${repeat(this.tabs, (tab) => tab.id, (tab) => html`
          <button type="button" role="tab" aria-selected=${tab.id === this.selected ? 'true' : 'false'}
                  tabindex=${tab.id === this.selected ? 0 : -1} @click=${() => this.#select(tab.id)}>${tab.label}</button>
        `)}
      </div>
    `;
  }
}
customElements.define('ds-tabs', DsTabs);
