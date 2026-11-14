// A number with − and + buttons, kept between `min` and `max`. `value` is two-way: it fires
// `valuechange` with the new number. Form-associated, as ds-field is and for the same reason.
import { LitElement, css, html } from 'lit';

export class DsQuantity extends LitElement {
  static formAssociated = true;
  static properties = {
    label: {},
    name: { reflect: true },
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
  };
  static styles = css`
    :host { display: grid; gap: 0.25rem; }
    label { font-weight: 600; }
    div { display: flex; gap: 0.25rem; }
    input { font: inherit; width: 4rem; padding: 0.4rem 0.5rem; border: 1px solid var(--line, #d5d9e2); border-radius: 0.4rem; text-align: center; }
    button { width: 2.2rem; border: 1px solid var(--line, #d5d9e2); border-radius: 0.4rem; background: var(--surface, #fff); cursor: pointer; }
    button:disabled { opacity: 0.4; cursor: default; }
  `;
  #internals = this.attachInternals?.();
  constructor() {
    super();
    this.label = '';
    this.name = '';
    this.value = 1;
    this.min = 1;
    this.max = 10;
  }
  willUpdate(changed) {
    if (changed.has('value')) this.#internals?.setFormValue(String(this.value));
  }
  formResetCallback() {
    this.#change(this.min);
  }
  #change(value) {
    const next = Math.min(this.max, Math.max(this.min, value));
    if (next === this.value) return this.requestUpdate(); // put the clamped number back in the input
    this.value = next;
    this.dispatchEvent(new CustomEvent('valuechange', { detail: next, bubbles: true, composed: true }));
  }
  #typed(event) {
    const n = Number(event.target.value);
    if (event.target.value !== '' && !Number.isNaN(n)) this.#change(n);
  }
  render() {
    return html`
      <label for="input">${this.label}</label>
      <div>
        <button type="button" aria-label="Decrease ${this.label}" ?disabled=${this.value <= this.min} @click=${() => this.#change(this.value - 1)}>−</button>
        <input id="input" type="number" min=${this.min} max=${this.max} .value=${String(this.value)} @change=${this.#typed}>
        <button type="button" aria-label="Increase ${this.label}" ?disabled=${this.value >= this.max} @click=${() => this.#change(this.value + 1)}>+</button>
      </div>
    `;
  }
}
customElements.define('ds-quantity', DsQuantity);
