// A labelled text input with an error message. `value` is two-way: it fires `valuechange` with
// the new text. The input is in the shadow root, where a form can't see it, so the element is
// form-associated and submits the value itself.
import { LitElement, css, html, nothing } from 'lit';

export class DsField extends LitElement {
  static formAssociated = true;
  static properties = {
    label: {},
    name: { reflect: true },
    value: {},
    required: { type: Boolean },
    error: {},
  };
  static styles = css`
    :host { display: grid; gap: 0.25rem; }
    label { font-weight: 600; }
    input { font: inherit; padding: 0.4rem 0.5rem; border: 1px solid var(--line, #d5d9e2); border-radius: 0.4rem; }
    input[aria-invalid=true] { border-color: #c0271b; }
    p { margin: 0; color: #c0271b; font-size: 0.85rem; }
  `;
  #internals = this.attachInternals?.();
  constructor() {
    super();
    this.label = '';
    this.name = '';
    this.value = '';
    this.required = false;
    this.error = '';
  }
  willUpdate(changed) {
    if (changed.has('value')) this.#internals?.setFormValue(this.value);
  }
  formResetCallback() {
    this.#change('');
  }
  #change(value) {
    this.value = value;
    this.dispatchEvent(new CustomEvent('valuechange', { detail: value, bubbles: true, composed: true }));
  }
  #keydown(event) {
    // A form's implicit submission (Enter in a text input) doesn't cross the shadow root.
    if (event.key === 'Enter') this.#internals?.form?.requestSubmit();
  }
  render() {
    return html`
      <label for="input">${this.label}</label>
      <input id="input" .value=${this.value} ?required=${this.required}
             aria-invalid=${this.error ? 'true' : 'false'} aria-describedby=${this.error ? 'error' : nothing}
             @input=${(event) => this.#change(event.target.value)} @keydown=${this.#keydown}>
      ${this.error ? html`<p id="error" role="alert">${this.error}</p>` : nothing}
    `;
  }
}
customElements.define('ds-field', DsField);
