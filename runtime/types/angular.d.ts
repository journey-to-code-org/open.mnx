import type { ControlValueAccessor } from '@angular/forms';

/**
 * Makes an mnx element a form control (`ngModel`, `formControl`, `formControlName`) through its
 * `<prop>` + `<prop>change` pair. `mnxModel` alone binds the `value` pair (or the only pair);
 * `mnxModel="checked"` names one. A standalone directive: add it to the component's `imports`.
 */
export declare class MnxModel implements ControlValueAccessor {
  /** The prop to bind; empty for the `value` pair, or the only pair. */
  mnxModel: string;
  writeValue(value: unknown): void;
  registerOnChange(fn: (value: unknown) => void): void;
  registerOnTouched(fn: () => void): void;
  setDisabledState(disabled: boolean): void;
}
