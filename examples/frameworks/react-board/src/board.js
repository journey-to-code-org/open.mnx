// The board's state and every change to it, as a reducer. Moves are kept in a history so they
// can be undone.

export const COLUMNS = [
  { id: 'backlog', heading: 'Backlog', limit: 0 },
  { id: 'todo', heading: 'To do', limit: 0 },
  { id: 'doing', heading: 'In progress', limit: 3 },
  { id: 'review', heading: 'Review', limit: 2 },
  { id: 'done', heading: 'Done', limit: 0 },
];

export const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds', 'Margaret Hamilton'];

const card = (id, title, points, assignee, tags, priority = 'normal') => ({ id, title, points, assignee, tags, priority });

export function initialBoard() {
  const cards = [
    card('c1', 'Sign-in with passkeys', 8, 'Ada Lovelace', ['auth', 'security'], 'high'),
    card('c2', 'Dark mode for settings', 3, 'Grace Hopper', ['ui']),
    card('c3', 'Export reports as CSV', 5, 'Linus Torvalds', ['reports']),
    card('c4', 'Rate-limit the public API', 5, 'Margaret Hamilton', ['api', 'security'], 'high'),
    card('c5', 'Empty states for lists', 2, '', ['ui'], 'low'),
    card('c6', 'Upgrade the build to Vite 8', 3, 'Linus Torvalds', ['tooling']),
    card('c7', 'Audit log for admins', 8, 'Ada Lovelace', ['security']),
    card('c8', 'Onboarding checklist', 5, 'Grace Hopper', ['ui', 'growth']),
  ];
  return {
    cards: Object.fromEntries(cards.map((item) => [item.id, item])),
    columns: { backlog: ['c5', 'c8'], todo: ['c3', 'c7'], doing: ['c1', 'c4'], review: ['c2'], done: ['c6'] },
    history: [],
  };
}

const columnOf = (state, id) => Object.keys(state.columns).find((column) => state.columns[column].includes(id));

/** `id` into `column`, before `before` (a card id), or at the end. */
function place(columns, id, column, before) {
  const next = Object.fromEntries(Object.entries(columns).map(([key, ids]) => [key, ids.filter((item) => item !== id)]));
  const list = next[column];
  const at = before ? list.indexOf(before) : -1;
  list.splice(at === -1 ? list.length : at, 0, id);
  return next;
}

export function reducer(state, action) {
  switch (action.type) {
    case 'move': {
      const { id, column, before = null } = action;
      if (before === id) return state;
      const columns = place(state.columns, id, column, before);
      if (JSON.stringify(columns) === JSON.stringify(state.columns)) return state;
      return { ...state, columns, history: [...state.history.slice(-19), state.columns] };
    }
    case 'shift': {
      // Shift+←/→ on a card: the neighbouring column, at its end.
      const from = COLUMNS.findIndex((column) => column.id === columnOf(state, action.id));
      const to = COLUMNS[from + action.by];
      return to ? reducer(state, { type: 'move', id: action.id, column: to.id }) : state;
    }
    case 'reorder': {
      const column = columnOf(state, action.id);
      const list = state.columns[column];
      const at = list.indexOf(action.id) + action.by;
      if (at < 0 || at >= list.length) return state;
      const before = action.by < 0 ? list[at] : list[at + 1] ?? null;
      return reducer(state, { type: 'move', id: action.id, column, before });
    }
    case 'save': {
      const { card: saved, column = 'backlog' } = action;
      const isNew = !state.cards[saved.id];
      return {
        ...state,
        cards: { ...state.cards, [saved.id]: saved },
        columns: isNew ? { ...state.columns, [column]: [...state.columns[column], saved.id] } : state.columns,
      };
    }
    case 'remove': {
      const { [action.id]: _, ...cards } = state.cards;
      const columns = Object.fromEntries(Object.entries(state.columns).map(([key, ids]) => [key, ids.filter((item) => item !== action.id)]));
      return { ...state, cards, columns, history: [] };
    }
    case 'undo':
      return state.history.length ? { ...state, columns: state.history.at(-1), history: state.history.slice(0, -1) } : state;
    case 'reset':
      return initialBoard();
    default:
      return state;
  }
}

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem('zb-board'));
    if (saved?.cards && saved?.columns) return { ...saved, history: [] };
  } catch {}
  return initialBoard();
}

export function save(state) {
  try {
    localStorage.setItem('zb-board', JSON.stringify({ cards: state.cards, columns: state.columns }));
  } catch {}
}
