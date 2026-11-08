import type { ControlValueAccessor } from '@angular/forms';
import type * as i0 from '@angular/core';

/**
 * Makes a zubra element a form control (`ngModel`, `formControl`, `formControlName`) through its
 * `<prop>` + `<prop>change` pair. `zubraModel` alone binds the `value` pair (or the only pair);
 * `zubraModel="checked"` names one. A standalone directive: add it to the component's `imports`.
 */
export declare class ZubraModel implements ControlValueAccessor {
  /** The prop to bind; empty for the `value` pair, or the only pair. */
  zubraModel: string;
  writeValue(value: unknown): void;
  registerOnChange(fn: (value: unknown) => void): void;
  registerOnTouched(fn: () => void): void;
  setDisabledState(disabled: boolean): void;
  // What Angular's ahead-of-time compiler reads to use the directive in a template (as in any
  // Angular library's typings).
  static ɵfac: i0.ɵɵFactoryDeclaration<ZubraModel, never>;
  static ɵdir: i0.ɵɵDirectiveDeclaration<ZubraModel, '[zubraModel]', ['zubraModel'], { zubraModel: { alias: 'zubraModel'; required: false } }, {}, never, never, true, never>;
}
