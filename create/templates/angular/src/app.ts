import { Component, CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import './components/hello-counter.zb';

// Angular uses the element directly: [count] sets the property, (countchange) listens. For
// forms, ZubraModel from @zubra/runtime/angular makes an element work with ngModel and formControl.
@Component({
  selector: 'app-root',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <main>
      <h1>{{title}}</h1>
      <hello-counter [count]="count()" (countchange)="count.set($any($event).detail)" label="Clicks"></hello-counter>
      <p>Angular sees <span id="seen">{{ count() }}</span></p>
    </main>
  `,
})
export class App {
  count = signal(0);
}
