// A modal dialog on the native <dialog>. `open` is two-way: Escape and the close button set it
// to false and fire `openchange`. The default slot is the dialog's content.
import { LitElement, css, html } from 'lit';

export class DsDialog extends LitElement {
  static properties = { open: { type: Boolean }, heading: {} };
  static styles = css`
    dialog { border: 0; border-radius: 0.8rem; padding: 1.25rem; width: min(26rem, calc(100vw - 2rem)); box-shadow: 0 24px 64px #0d122040; }
    dialog::backdrop { background: #0d122066; }
    header { display: flex; align-items: center; gap: 1rem; }
    h2 { flex: 1; margin: 0; font-size: 1.1rem; }
    header button { border: 0; background: none; font-size: 1.4rem; line-height: 1; cursor: pointer; }
  `;
  constructor() {
    super();
    this.open = false;
    this.heading = '';
  }
  updated() {
    const dialog = this.renderRoot.querySelector('dialog');
    if (this.open && !dialog.open) dialog.showModal();
    else if (!this.open && dialog.open) dialog.close();
  }
  #close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent('openchange', { detail: false, bubbles: true, composed: true }));
  }
  render() {
    return html`
      <dialog aria-labelledby="heading" @close=${this.#close}>
        <header>
          <h2 id="heading">${this.heading}</h2>
          <button type="button" aria-label="Close" @click=${this.#close}>×</button>
        </header>
        <slot></slot>
      </dialog>
    `;
  }
}
customElements.define('ds-dialog', DsDialog);
