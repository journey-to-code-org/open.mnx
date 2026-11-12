// The README's copy button in WebUI (Microsoft): a template, its CSS, and a class for the click.
// WebUI's templates take paths, not expressions, so the label is two <if>s, and the style hook is a
// data attribute rather than a class (its rules forbid classList from script).
import { WebUIElement, attr, observable } from '@microsoft/webui-framework';

export class CopyButton extends WebUIElement {
  @attr text = '';
  @attr label = 'Copy';
  @observable copied = false;

  async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.text);
    this.copied = true;
    setTimeout(() => (this.copied = false), 1500);
  }
}

CopyButton.define('copy-button');
