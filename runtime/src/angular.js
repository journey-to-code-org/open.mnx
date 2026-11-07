// Angular adapter: mnx elements in Angular forms.
//
//   import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
//   import { FormsModule } from '@angular/forms';
//   import { MnxModel } from '@mnx/runtime/angular';
//   import './rating.mnx';
//
//   @Component({
//     imports: [FormsModule, MnxModel],
//     schemas: [CUSTOM_ELEMENTS_SCHEMA],
//     template: `<mnx-rating mnxModel [(ngModel)]="stars" (change)="saved()"></mnx-rating>`,
//   })
//
// Angular needs nothing else for an mnx element: `[heading]="x"` sets the property,
// `(valuechange)="…"` listens for the event, and children are the element's slot content.
// What it can't do on its own is two-way binding, because `[(value)]` listens for
// `valueChange` and the element fires `valuechange`. `mnxModel` makes the element a form control
// instead (ngModel, formControl, formControlName), using the `<prop>` + `<prop>change` pair:
// `mnxModel` alone picks the `value` pair (or the only pair), `mnxModel="checked"` names one.
//
// The class is published the way Angular libraries are (partial declarations), so the Angular
// CLI's linker compiles it in AOT builds, and JIT compiles it at runtime.
import * as i0 from '@angular/core';
import { ChangeDetectorRef, DestroyRef, ElementRef, forwardRef, inject } from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import { models } from './vue.js';

const clone = (value) => (value && typeof value === 'object' ? structuredClone(value) : value);

function metaOf(element) {
  const meta = element.constructor?.mnx ?? customElements.get(element.localName)?.mnx;
  if (!meta) throw new TypeError(`mnx: mnxModel is on <${element.localName}>, which isn't a defined mnx element (import its .mnx module first)`);
  return meta;
}

export class MnxModel {
  /** The prop to bind; empty for the `value` pair, or the only pair. */
  mnxModel = '';
  #element = inject(ElementRef).nativeElement;
  #changes = inject(ChangeDetectorRef);
  #pair = null;
  #onChange = () => {};
  #onTouched = () => {};

  constructor() {
    const listener = (event) => {
      if (event.target !== this.#element) return;
      const pair = this.#resolve();
      if (event.type !== pair.event) return;
      this.#onChange(event.detail);
      this.#changes.markForCheck();
    };
    const touched = () => this.#onTouched();
    // Every `…change` event is caught here, so the pair can be settled lazily (the element may be
    // defined after the directive is created).
    const types = new Set();
    const listen = () => {
      for (const { event } of models(metaOf(this.#element))) {
        if (types.has(event)) continue;
        types.add(event);
        this.#element.addEventListener(event, listener);
      }
    };
    customElements.whenDefined(this.#element.localName).then(listen);
    this.#element.addEventListener('focusout', touched);
    inject(DestroyRef).onDestroy(() => {
      for (const type of types) this.#element.removeEventListener(type, listener);
      this.#element.removeEventListener('focusout', touched);
    });
  }

  #resolve() {
    if (this.#pair) return this.#pair;
    const meta = metaOf(this.#element);
    const pairs = models(meta);
    const pair = this.mnxModel
      ? pairs.find((candidate) => candidate.prop === this.mnxModel)
      : pairs.find((candidate) => candidate.prop === 'value') ?? (pairs.length === 1 ? pairs[0] : undefined);
    if (!pair) {
      const named = pairs.map((candidate) => `\`${candidate.prop}\``).join(', ') || 'none';
      throw new TypeError(this.mnxModel
        ? `mnx: <${meta.tag}> has no \`${this.mnxModel}\` + \`${this.mnxModel.toLowerCase()}change\` pair for mnxModel (pairs: ${named})`
        : `mnx: mnxModel on <${meta.tag}> needs a name, e.g. mnxModel="${pairs[0]?.prop ?? 'value'}" (pairs: ${named})`);
    }
    return (this.#pair = pair);
  }

  writeValue(value) {
    const set = () => {
      const { prop } = this.#resolve();
      // Forms reset to null: that's the component's default.
      this.#element[prop] = value ?? clone(metaOf(this.#element).props[prop].default);
    };
    if (customElements.get(this.#element.localName)) set();
    else customElements.whenDefined(this.#element.localName).then(set);
  }

  registerOnChange(fn) { this.#onChange = fn; }
  registerOnTouched(fn) { this.#onTouched = fn; }

  setDisabledState(disabled) {
    const { props } = metaOf(this.#element);
    if ('disabled' in props) this.#element.disabled = disabled;
    else this.#element.toggleAttribute('disabled', disabled);
  }

  static ɵfac = i0.ɵɵngDeclareFactory({
    minVersion: '12.0.0', version: '17.0.0', ngImport: i0, type: MnxModel, deps: [], target: i0.ɵɵFactoryTarget.Directive,
  });
  static ɵdir = i0.ɵɵngDeclareDirective({
    minVersion: '14.0.0', version: '17.0.0', type: MnxModel, isStandalone: true, selector: '[mnxModel]',
    inputs: { mnxModel: 'mnxModel' },
    providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MnxModel), multi: true }],
    exportAs: ['mnxModel'],
    ngImport: i0,
  });
}
