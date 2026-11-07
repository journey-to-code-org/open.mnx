// The planner's data: one list of events, held in a signal, saved to localStorage. The app
// provides it as context (the Web Components context protocol); any component below it gets it
// with `usePlanner()`, without props passed down through every level.

import { Signal, createContext, inject, computed } from '@mnx/runtime';
import { today, addDays } from './dates.js';

export const Planner = createContext(null);

export const CATEGORIES = ['party', 'work', 'family', 'travel', 'other'];
export const RSVPS = ['pending', 'yes', 'maybe', 'no'];

let next = Date.now();
const uid = (prefix) => `${prefix}${(next++).toString(36)}`;

export function blankEvent(day = today()) {
  return { id: '', title: '', day, start: '18:00', end: '21:00', location: '', category: 'party', budget: 0, notes: '' };
}

/** Create the store. `storage` is a Storage (localStorage) or null. */
export function createPlanner(storage, key = 'mnx-planner') {
  let saved = null;
  try {
    saved = JSON.parse(storage?.getItem(key) ?? 'null');
  } catch {}
  const events = new Signal.State(Array.isArray(saved) ? saved : sample());

  const set = (list) => {
    events.set(list);
    try {
      storage?.setItem(key, JSON.stringify(list));
    } catch {}
  };
  const change = (id, fn) => set(events.get().map((event) => (event.id === id ? fn(event) : event)));
  const inList = (name) => ({
    add: (id, item) => change(id, (event) => ({ ...event, [name]: [...event[name], { ...item, id: uid(name[0]) }] })),
    update: (id, itemId, patch) =>
      change(id, (event) => ({ ...event, [name]: event[name].map((item) => (item.id === itemId ? { ...item, ...patch } : item)) })),
    remove: (id, itemId) => change(id, (event) => ({ ...event, [name]: event[name].filter((item) => item.id !== itemId) })),
  });

  return {
    events,
    find: (id) => events.get().find((event) => event.id === id) ?? null,
    /** Add an event, or update the one with its id. Returns the id. */
    save(details) {
      if (details.id && events.get().some((event) => event.id === details.id)) {
        change(details.id, (event) => ({ ...event, ...details }));
        return details.id;
      }
      const id = uid('e');
      set([...events.get(), { guests: [], schedule: [], expenses: [], tasks: [], ...details, id }]);
      return id;
    },
    remove: (id) => set(events.get().filter((event) => event.id !== id)),
    guests: inList('guests'),
    schedule: inList('schedule'),
    expenses: inList('expenses'),
    tasks: inList('tasks'),
  };
}

/** The store from the nearest planner above, and its events as a signal. */
export function usePlanner() {
  const store = inject(Planner);
  return {
    events: computed(() => store.get()?.events.get() ?? []),
    act: (name, ...args) => {
      const [group, method] = name.split('.');
      const target = store.get();
      return method ? target[group][method](...args) : target[group](...args);
    },
  };
}

/** A few events around today, so a first visit has something to show. */
function sample() {
  const day = today();
  let n = 0;
  const id = (p) => `${p}sample${n++}`;
  return [
    {
      id: 'e-launch',
      title: 'Launch party',
      day: addDays(day, 3),
      start: '19:00',
      end: '23:00',
      location: 'The Roof, 5th floor',
      category: 'party',
      budget: 1200,
      notes: 'Celebrate shipping 2.0.',
      guests: [
        { id: id('g'), name: 'Ada Lovelace', email: 'ada@example.com', rsvp: 'yes', plusOne: true },
        { id: id('g'), name: 'Grace Hopper', email: 'grace@example.com', rsvp: 'maybe', plusOne: false },
        { id: id('g'), name: 'Alan Turing', email: 'alan@example.com', rsvp: 'pending', plusOne: false },
      ],
      schedule: [
        { id: id('s'), time: '19:00', title: 'Doors open' },
        { id: id('s'), time: '20:00', title: 'Demo and toast' },
        { id: id('s'), time: '21:00', title: 'Music' },
      ],
      expenses: [
        { id: id('x'), label: 'Venue', category: 'venue', amount: 600, paid: true },
        { id: id('x'), label: 'Catering', category: 'food', amount: 450, paid: false },
      ],
      tasks: [
        { id: id('t'), title: 'Book the venue', done: true },
        { id: id('t'), title: 'Send invitations', done: false },
        { id: id('t'), title: 'Order the cake', done: false },
      ],
    },
    {
      id: 'e-standup',
      title: 'Quarterly planning',
      day: addDays(day, 8),
      start: '09:30',
      end: '12:00',
      location: 'Room 2',
      category: 'work',
      budget: 0,
      notes: '',
      guests: [],
      schedule: [],
      expenses: [],
      tasks: [{ id: id('t'), title: 'Draft the agenda', done: false }],
    },
    {
      id: 'e-trip',
      title: 'Weekend in the mountains',
      day: addDays(day, -4),
      start: '08:00',
      end: '18:00',
      location: 'Blackwater Falls',
      category: 'travel',
      budget: 300,
      notes: '',
      guests: [],
      schedule: [],
      expenses: [{ id: id('x'), label: 'Cabin', category: 'lodging', amount: 220, paid: true }],
      tasks: [],
    },
  ];
}

/** An event as an iCalendar file. */
export function toIcs(event) {
  const stamp = (day, time) => `${day.replaceAll('-', '')}T${time.replace(':', '')}00`;
  const text = (value) => String(value).replace(/[\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mnx//planner//EN',
    'BEGIN:VEVENT',
    `UID:${event.id}@mnx-planner`,
    `DTSTART:${stamp(event.day, event.start)}`,
    `DTEND:${stamp(event.day, event.end)}`,
    `SUMMARY:${text(event.title)}`,
    event.location ? `LOCATION:${text(event.location)}` : null,
    event.notes ? `DESCRIPTION:${text(event.notes)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}
