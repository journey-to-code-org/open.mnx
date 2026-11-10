# Zubra for Angular developers

Angular's strength here is its forms: reactive forms, validators and `formControlName` already know how to drive a control. A Zubra component can be that control. It is a standard custom element, so Angular uses it directly, and `@zubra/runtime/angular`'s `ZubraModel` directive makes it a form control, so `ngModel`, `formControl` and `formControlName` work on it.

The table is for writing components in Zubra; the rest of the page is for using them in your Angular app.

| Angular | Zubra |
|---|---|
| `label = input('Hi')` or `@Input() label = 'Hi'` | `<my-greeting label="Hi">`: the host tag's attributes are the props |
| `count = signal(0)`, `count.update((n) => n + 1)` | `let count = 0`, `count++` |
| `doubled = computed(() => this.count() * 2)` | `const doubled = count * 2` |
| `left = linkedSignal(() => this.seconds())` | `let left = from(seconds)`: follows the prop until assigned, starts over when it changes |
| `effect(() => { … })` | `effect(() => { … })`: tracks what it reads |
| `ngOnInit`, `ngOnDestroy` or `inject(DestroyRef).onDestroy(…)` | `onMount(() => { … return cleanup })` |
| `@if (a) { … } @else { … }` | `<zb-if test={a}>…<zb-else>…</zb-else></zb-if>` |
| `@for (item of items; track item.id) { … }` | `<zb-each items={items} as="item" key={item.id}>…</zb-each>` |
| `[class.open]="open"` | `class:open={open}` |
| `[style.font-size.px]="size"` | `style:font-size={size + "px"}` |
| `(click)="save()"`, `(submit)="save(); $event.preventDefault()"` | `onclick={save}`, `onsubmit.prevent={save}` |
| `select = output<string>()`, `this.select.emit(id)` | `emit('select', id)`, imported from `@zubra/runtime`: calling it declares it |
| `value = model(0)`, `[(value)]="n"` | `value:model={0}` on the host |
| `<ng-content />`, `<ng-content select="[footer]" />` | `<zb-slot>`, `<zb-slot name="footer">` |
| `inject(TOKEN)`, `providers` | `provide` / `inject` (with `createContext`) |
| `resource({ … })` | `resource()` with `<zb-await>` |
| component styles (emulated encapsulation) | `<style>`: always scoped |

## Using Zubra components in an Angular app

Import the `.zb` file for its side effect, which defines the element, and add `CUSTOM_ELEMENTS_SCHEMA` so Angular accepts the tag. These are the lines of the [booking wizard](../../examples/frameworks/angular-booking) that do it:

<!-- snippet: examples/frameworks/angular-booking/src/app/app.ts#angular-imports -->
```ts
import { ZubraModel } from '@zubra/runtime/angular';
import '../components/step-indicator.zb';
import '../components/choice-cards.zb';
import '../components/date-range.zb';
import '../components/quantity-stepper.zb';
import '../components/toggle-switch.zb';
```

<!-- snippet: examples/frameworks/angular-booking/src/app/app.ts#angular-component -->
```ts
@Component({
  selector: 'booking-app',
  imports: [ReactiveFormsModule, ZubraModel],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
```

Angular needs nothing more for the plain parts: `[items]="placeCards"` sets the property (objects and arrays arrive as values), `(stepselect)="step.set($any($event).detail)"` listens for the element's event (`detail` is the payload), and children are the element's slot content.

What Angular can't do alone is two-way binding: `[(value)]` listens for `valueChange`, and DOM events are lowercase (`valuechange`). `ZubraModel` solves that by making the element a form control. `zubraModel` alone binds the `value` pair; `zubraModel="checked"` names another `:model` prop:

<!-- snippet: examples/frameworks/angular-booking/src/app/app.html#angular-choice -->
```html
<choice-cards zubraModel formControlName="place" [items]="placeCards" [required]="true" label="Destination"></choice-cards>
```

<!-- snippet: examples/frameworks/angular-booking/src/app/app.html#angular-toggle -->
```html
<toggle-switch zubraModel="checked" [formControlName]="extra.id" [label]="extra.label" [description]="extra.description + ' · ' + extra.per" [extra]="extraPrice(extra.id)"></toggle-switch>
```

`ngModel` and `formControl` work the same way. A value can be an object: the wizard's `date-range` holds `{ start, end }` under one `formControlName`, with an ordinary Angular validator on it. The directive is a standalone class in the Angular Package Format, so it compiles ahead of time (peer dependencies `@angular/core` and `@angular/forms`, 16 or later). `npm create zubra` can start an Angular app with all of this set up.

## What you get with Angular's forms

Each line links the test that checks it. The tests run on every push.

- The form drives the element, and the element drives the form. `setValue()` reaches the element, `disable()` and `enable()` set `disabled`, `reset()` puts back the component's default, a change event updates the control, and leaving the element marks it touched ([`angular.test.js`](../../runtime/test/browser/angular.test.js)).
- Validity is the platform's as well as Angular's. A required Zubra control is `:invalid` in CSS while Angular's own validator flags the control, and the two agree ([`angular.test.js`](../../examples/frameworks/test/angular.test.js)).
- A whole multi-step form works on Zubra controls: required fields, an object-valued control with a custom validator, switches bound through `zubraModel="checked"`, values kept across steps, and `reset()` clearing every control ([`angular.test.js`](../../examples/frameworks/test/angular.test.js)).
- Slots follow Angular's template: content reordered by `@for`, an emptied slot showing its fallback again, and the element removed cleanly when the component is destroyed ([`angular.test.js`](../../runtime/test/browser/angular.test.js)).
- Ahead-of-time compilation: the Angular linker compiles `ZubraModel`, and its typings declare it the way Angular reads a library's directives ([`angular.test.js`](../../runtime/test/tools/angular.test.js)).
- The same `.zb` file also runs in React, Vue, Svelte, Solid, Lit, Preact, Astro and plain HTML apps, each row checked in CI ([the framework matrix](../framework-matrix.md)).

## What doesn't cross

The general rules, with the reasons, are in [What crosses the boundary](../what-crosses-the-boundary.md): props, events, slots and forms cross; render props, framework context and Suspense don't. For Angular in particular:

- **Template type checking.** With `CUSTOM_ELEMENTS_SCHEMA`, Angular doesn't check an element's bindings: a wrong property name or type compiles. Zubra's `--emit dts` writes declarations for the element class, but there is no Angular-specific typing yet, so this page doesn't claim typed templates.
- **Angular's own server rendering** has no row in the framework matrix, so nothing here promises it. Zubra elements render on the server through [`@zubra/server` and the CLI](../server-rendering.md); how that composes with Angular's SSR is untested.
- **Event names are lowercase** (`(valuechange)`, not `(valueChange)`), because they are DOM events.
- **Validation messages are yours.** `ZubraModel` moves values, `disabled` and touched state. Angular's validators and your error templates stay in charge.

**Which framework do you use alongside Zubra, and what would a page written for you need to show?** [Tell us in an issue](https://github.com/journey-to-code-org/zubra/issues/new).
