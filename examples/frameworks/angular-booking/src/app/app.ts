import { Component, CUSTOM_ELEMENTS_SCHEMA, computed, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators, AbstractControl, ValidationErrors } from '@angular/forms';
import { inject } from '@angular/core';
import { EXTRAS, PLACES, usd } from './data';
// The guide's Angular page quotes the next lines and the @Component below (docs/guide/for-angular-developers.md).
// zubra-snippet:start angular-imports
import { ZubraModel } from '@zubra/runtime/angular';
import '../components/step-indicator.zb';
import '../components/choice-cards.zb';
import '../components/date-range.zb';
import '../components/quantity-stepper.zb';
import '../components/toggle-switch.zb';
// zubra-snippet:end angular-imports

interface Dates {
  start: string;
  end: string;
}

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const nightsOf = ({ start, end }: Dates) => (start && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 86400000)) : 0);
const stayValid = (control: AbstractControl): ValidationErrors | null => (nightsOf(control.value as Dates) >= 1 ? null : { dates: true });

// zubra-snippet:start angular-component
@Component({
  selector: 'booking-app',
  imports: [ReactiveFormsModule, ZubraModel],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
// zubra-snippet:end angular-component
export class App {
  readonly steps = ['Trip', 'Room', 'Extras', 'Details'];
  readonly extras = EXTRAS;
  readonly usd = usd;
  readonly today = day(0);
  step = signal(0);
  booked = signal<string | null>(null);

  form = inject(FormBuilder).nonNullable.group({
    trip: inject(FormBuilder).nonNullable.group({
      place: ['', Validators.required],
      dates: [{ start: day(14), end: day(17) } as Dates, stayValid],
      adults: [2, [Validators.min(1)]],
      children: [0],
    }),
    room: ['', Validators.required],
    extras: inject(FormBuilder).nonNullable.group({ breakfast: [false], late: [false], pickup: [false], pet: [false] }),
    details: inject(FormBuilder).nonNullable.group({
      name: ['', [Validators.required, Validators.minLength(2)]],
      email: ['', [Validators.required, Validators.email]],
      requests: [''],
    }),
  });

  value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  place = computed(() => PLACES.find((place) => place.id === this.value().trip?.place) ?? null);
  guests = computed(() => (this.value().trip?.adults ?? 0) + (this.value().trip?.children ?? 0));
  nights = computed(() => nightsOf(this.value().trip?.dates ?? { start: '', end: '' }));
  who = computed(() => {
    const { adults = 0, children = 0 } = this.value().trip ?? {};
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return children ? `${plural(adults, 'adult', 'adults')}, ${plural(children, 'child', 'children')}` : plural(adults, 'adult', 'adults');
  });
  when = computed(() => {
    const { start, end } = this.value().trip?.dates ?? { start: '', end: '' };
    if (!start || !end) return 'Not chosen yet';
    const format = (day: string) => shortDate.format(new Date(`${day}T12:00`));
    return `${format(start)} → ${format(end)} · ${this.nights()} night${this.nights() === 1 ? '' : 's'}`;
  });

  placeCards = PLACES.map((place) => ({ id: place.id, title: place.title, detail: place.detail, note: place.note, price: `from ${usd.format(Math.min(...place.rooms.map((room) => room.nightly)))}` }));
  /** The chosen place's rooms; those too small for the party can't be chosen. */
  roomCards = computed(() =>
    (this.place()?.rooms ?? []).map((room) => ({
      id: room.id,
      title: room.title,
      detail: room.detail,
      note: room.sleeps < this.guests() ? `Sleeps ${room.sleeps}: too small` : `Sleeps ${room.sleeps}`,
      price: `${usd.format(room.nightly)}/night`,
      disabled: room.sleeps < this.guests(),
    })),
  );
  room = computed(() => this.place()?.rooms.find((room) => room.id === this.value().room) ?? null);

  lines = computed(() => {
    const room = this.room();
    if (!room) return [];
    const stay = { nights: this.nights(), guests: this.guests() };
    const chosen = this.value().extras ?? {};
    return [
      { label: `${room.title} × ${stay.nights} night${stay.nights === 1 ? '' : 's'}`, amount: room.nightly * stay.nights },
      ...EXTRAS.filter((extra) => chosen[extra.id]).map((extra) => ({ label: extra.label, amount: extra.price(stay) })),
    ];
  });
  subtotal = computed(() => this.lines().reduce((sum, line) => sum + line.amount, 0));
  taxes = computed(() => Math.round(this.subtotal() * 0.12));
  total = computed(() => this.subtotal() + this.taxes());

  constructor() {
    // A different place, or more guests than the room sleeps, clears the room.
    this.form.controls.trip.valueChanges.subscribe(() => {
      const room = this.room();
      if (this.form.controls.room.value && (!room || room.sleeps < this.guests())) this.form.controls.room.setValue('');
    });
  }

  /** The form group for the current step. */
  current(): AbstractControl {
    return [this.form.controls.trip, this.form.controls.room, this.form.controls.extras, this.form.controls.details][this.step()];
  }

  next() {
    const group = this.current();
    group.markAllAsTouched();
    if (group.invalid) return;
    if (this.step() === this.steps.length - 1) return this.book();
    this.step.update((step) => step + 1);
  }

  back() {
    this.step.update((step) => Math.max(0, step - 1));
  }

  extraPrice(id: string) {
    const extra = EXTRAS.find((item) => item.id === id)!;
    return usd.format(extra.price({ nights: this.nights(), guests: this.guests() }));
  }

  book() {
    this.booked.set(`ZB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`);
  }

  restart() {
    this.form.reset();
    this.form.controls.trip.controls.dates.setValue({ start: day(14), end: day(17) });
    this.booked.set(null);
    this.step.set(0);
  }
}
