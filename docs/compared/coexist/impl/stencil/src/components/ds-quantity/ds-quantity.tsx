// A number with − and + buttons, kept between `min` and `max`. `value` is two-way: it fires
// `valuechange` with the new number. Form-associated, as ds-field is and for the same reason.
import { AttachInternals, Component, Event, EventEmitter, Prop, Watch, forceUpdate, h } from '@stencil/core';

@Component({ tag: 'ds-quantity', styleUrl: 'ds-quantity.css', shadow: true, formAssociated: true })
export class DsQuantity {
  @Prop() label: string = '';
  @Prop({ reflect: true }) name: string = '';
  @Prop({ mutable: true }) value: number = 1;
  @Prop() min: number = 1;
  @Prop() max: number = 10;
  @Event({ eventName: 'valuechange' }) valueChange: EventEmitter<number>;
  @AttachInternals() internals: ElementInternals;
  private input: HTMLInputElement;

  @Watch('value')
  submitted() {
    this.internals.setFormValue?.(String(this.value));
  }
  componentWillLoad() {
    this.submitted();
  }
  formResetCallback() {
    this.change(this.min);
  }
  private change(value: number) {
    const next = Math.min(this.max, Math.max(this.min, value));
    if (next === this.value) {
      this.input.value = String(next); // put the clamped number back in the input
      return forceUpdate(this);
    }
    this.value = next;
    this.valueChange.emit(next);
  }
  private typed = (event: Event) => {
    const text = (event.target as HTMLInputElement).value;
    const n = Number(text);
    if (text !== '' && !Number.isNaN(n)) this.change(n);
  };

  render() {
    return [
      <label htmlFor="input">{this.label}</label>,
      <div>
        <button type="button" aria-label={`Decrease ${this.label}`} disabled={this.value <= this.min} onClick={() => this.change(this.value - 1)}>−</button>
        <input id="input" type="number" min={this.min} max={this.max} value={this.value} onChange={this.typed} ref={(el) => (this.input = el)} />
        <button type="button" aria-label={`Increase ${this.label}`} disabled={this.value >= this.max} onClick={() => this.change(this.value + 1)}>+</button>
      </div>,
    ];
  }
}
