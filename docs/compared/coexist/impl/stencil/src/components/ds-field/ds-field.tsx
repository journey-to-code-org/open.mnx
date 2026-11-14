// A labelled text input with an error message. `value` is two-way: it fires `valuechange` with
// the new text. The input is in the shadow root, where a form can't see it, so the element is
// form-associated and submits the value itself.
import { AttachInternals, Component, Event, EventEmitter, Prop, Watch, h } from '@stencil/core';

@Component({ tag: 'ds-field', styleUrl: 'ds-field.css', shadow: true, formAssociated: true })
export class DsField {
  @Prop() label: string = '';
  @Prop({ reflect: true }) name: string = '';
  @Prop({ mutable: true }) value: string = '';
  @Prop() required: boolean = false;
  @Prop() error: string = '';
  @Event({ eventName: 'valuechange' }) valueChange: EventEmitter<string>;
  @AttachInternals() internals: ElementInternals;

  @Watch('value')
  submitted() {
    this.internals.setFormValue?.(this.value);
  }
  componentWillLoad() {
    this.submitted();
  }
  formResetCallback() {
    this.change('');
  }
  private change(value: string) {
    this.value = value;
    this.valueChange.emit(value);
  }
  private keydown = (event: KeyboardEvent) => {
    // A form's implicit submission (Enter in a text input) doesn't cross the shadow root.
    if (event.key === 'Enter') this.internals.form?.requestSubmit();
  };

  render() {
    return [
      <label htmlFor="input">{this.label}</label>,
      <input id="input" value={this.value} required={this.required}
             aria-invalid={this.error ? 'true' : 'false'} aria-describedby={this.error ? 'error' : null}
             onInput={(event) => this.change((event.target as HTMLInputElement).value)} onKeyDown={this.keydown} />,
      this.error ? <p id="error" role="alert">{this.error}</p> : null,
    ];
  }
}
