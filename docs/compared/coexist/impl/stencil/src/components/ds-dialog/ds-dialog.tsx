// A modal dialog on the native <dialog>. `open` is two-way: Escape and the close button set it
// to false and fire `openchange`. The default slot is the dialog's content.
import { Component, Event, EventEmitter, Prop, h } from '@stencil/core';

@Component({ tag: 'ds-dialog', styleUrl: 'ds-dialog.css', shadow: true })
export class DsDialog {
  @Prop({ mutable: true }) open: boolean = false;
  @Prop() heading: string = '';
  @Event({ eventName: 'openchange' }) openChange: EventEmitter<boolean>;
  private dialog: HTMLDialogElement;

  componentDidRender() {
    if (this.open && !this.dialog.open) this.dialog.showModal();
    else if (!this.open && this.dialog.open) this.dialog.close();
  }
  private close = () => {
    if (!this.open) return;
    this.open = false;
    this.openChange.emit(false);
  };

  render() {
    return (
      <dialog aria-labelledby="heading" onClose={this.close} ref={(el) => (this.dialog = el)}>
        <header>
          <h2 id="heading">{this.heading}</h2>
          <button type="button" aria-label="Close" onClick={this.close}>×</button>
        </header>
        <slot></slot>
      </dialog>
    );
  }
}
