// The trip's expenses, in memory (one trip, for the example).
export const PEOPLE = ['Ana', 'Ben', 'Chloé', 'Dev'];
export const CATEGORIES = ['food', 'lodging', 'travel', 'fun'];

const SEED = [
  { what: 'Cabin, two nights', category: 'lodging', cents: 48000, paidBy: 'Ana', split: PEOPLE },
  { what: 'Groceries', category: 'food', cents: 13250, paidBy: 'Ben', split: PEOPLE },
  { what: 'Gas', category: 'travel', cents: 6400, paidBy: 'Dev', split: ['Ana', 'Dev'] },
];
let expenses;
let next;
export function reset() {
  next = 1;
  expenses = SEED.map((expense) => ({ id: next++, ...expense, split: [...expense.split] }));
}
reset();

export const list = () => expenses;
export function add(expense) {
  expenses = [...expenses, { id: next++, ...expense }];
}
export function remove(id) {
  expenses = expenses.filter((expense) => expense.id !== id);
}

/** Each person's balance in cents: what they paid, minus their share of what they were in on. */
export function balances() {
  const totals = Object.fromEntries(PEOPLE.map((name) => [name, 0]));
  for (const { cents, paidBy, split } of expenses) {
    totals[paidBy] += cents;
    const share = Math.floor(cents / split.length);
    split.forEach((name, index) => (totals[name] -= share + (index < cents - share * split.length ? 1 : 0)));
  }
  return PEOPLE.map((name) => ({ name, cents: totals[name] }));
}
