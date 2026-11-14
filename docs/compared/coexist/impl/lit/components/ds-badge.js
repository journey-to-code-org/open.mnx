// An order's status, as a coloured label.
import { LitElement, css, html } from 'lit';

export class DsBadge extends LitElement {
  static properties = { status: {} };
  static styles = css`
    span { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 1rem; font-size: 0.8rem; font-weight: 600; background: #eef0f4; }
    span[data-status=shipped] { background: #dcf5e4; color: #14602f; }
    span[data-status=cancelled] { background: #fde3e1; color: #8f1d14; }
  `;
  constructor() {
    super();
    this.status = 'pending';
  }
  render() {
    return html`<span data-status=${this.status}>${this.status.slice(0, 1).toUpperCase() + this.status.slice(1)}</span>`;
  }
}
customElements.define('ds-badge', DsBadge);
