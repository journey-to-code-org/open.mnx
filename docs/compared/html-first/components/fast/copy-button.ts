// The README's copy button in FAST Element 3 (imperative templates, the documented decorators).
import { FASTElement, attr, css, html, observable } from '@microsoft/fast-element';

const template = html<CopyButton>`
  <button type="button" class="${(x) => (x.copied ? 'done' : '')}" @click="${(x) => x.copy()}">
    ${(x) => (x.copied ? 'Copied!' : x.label)}
  </button>
`;

const styles = css`
  button.done { color: green; }
`;

export class CopyButton extends FASTElement {
  @attr text = '';
  @attr label = 'Copy';
  @observable copied = false;

  async copy() {
    await navigator.clipboard.writeText(this.text);
    this.copied = true;
    setTimeout(() => (this.copied = false), 1500);
  }
}

CopyButton.define({ name: 'copy-button', template, styles });
