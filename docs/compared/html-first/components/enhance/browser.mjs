// The README's copy button for Enhance: the browser half, on @enhance/custom-element. Enhance's
// pattern is to keep the server's markup and update it by hand on change.
import CustomElement from '@enhance/custom-element';
import CopyButtonElement from './copy-button-element.mjs';

class CopyButton extends CustomElement {
  static get observedAttributes() {
    return ['label'];
  }
  constructor() {
    super();
    this.button = this.querySelector('button');
    this.copy = this.copy.bind(this);
  }
  connectedCallback() {
    this.button.addEventListener('click', this.copy);
  }
  disconnectedCallback() {
    this.button.removeEventListener('click', this.copy);
  }
  render(args) {
    return CopyButtonElement(args);
  }
  labelChanged(value) {
    if (!this.copied) this.button.textContent = value;
  }
  async copy() {
    await navigator.clipboard.writeText(this.getAttribute('text') ?? '');
    this.copied = true;
    this.button.textContent = 'Copied!';
    this.button.classList.add('done');
    setTimeout(() => {
      this.copied = false;
      this.button.textContent = this.getAttribute('label') ?? 'Copy';
      this.button.classList.remove('done');
    }, 1500);
  }
}

customElements.define('copy-button', CopyButton);
