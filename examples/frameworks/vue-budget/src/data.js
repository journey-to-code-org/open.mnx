// Categories, seed transactions for the last two months, and saving.
export const CATEGORIES = [
  { name: 'Housing', tone: 0, limit: 1400 },
  { name: 'Groceries', tone: 2, limit: 450 },
  { name: 'Eating out', tone: 4, limit: 180 },
  { name: 'Transport', tone: 1, limit: 160 },
  { name: 'Fun', tone: 5, limit: 120 },
  { name: 'Bills', tone: 3, limit: 220 },
  { name: 'Other', tone: 7, limit: 100 },
];
export const INCOME = ['Salary', 'Freelance', 'Gift'];

const pad = (n) => String(n).padStart(2, '0');
export const monthOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
export const shiftMonth = (month, by) => {
  const [y, m] = month.split('-').map(Number);
  return monthOf(new Date(y, m - 1 + by, 1));
};

function seed() {
  const now = new Date();
  const list = [];
  let id = 1;
  for (const back of [1, 0]) {
    const month = shiftMonth(monthOf(now), -back);
    const day = (d) => `${month}-${pad(Math.min(d, back ? 28 : now.getDate()))}`;
    const add = (d, kind, category, amount, note) => list.push({ id: `t${id++}`, date: day(d), kind, category, amount, note });
    add(1, 'income', 'Salary', 4200, 'Monthly pay');
    add(1, 'expense', 'Housing', 1400, 'Rent');
    add(3, 'expense', 'Groceries', 86.4, 'Market');
    add(5, 'expense', 'Bills', 64.99, 'Internet');
    add(6, 'expense', 'Eating out', 42.5, 'Ramen with Sam');
    add(9, 'expense', 'Transport', 55, 'Transit pass');
    add(12, 'expense', 'Groceries', 112.3, 'Weekly shop');
    add(14, 'expense', 'Fun', back ? 35 : 89, back ? 'Cinema' : 'Concert tickets');
    add(18, 'expense', 'Eating out', back ? 61 : 128.75, back ? 'Pizza night' : 'Birthday dinner');
    add(20, 'income', 'Freelance', back ? 600 : 350, 'Logo project');
    add(22, 'expense', 'Bills', 118.2, 'Electricity');
    add(25, 'expense', 'Groceries', 97.15, 'Weekly shop');
  }
  return list;
}

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem('zb-budget'));
    if (saved?.transactions) return saved;
  } catch {}
  return { transactions: seed(), limits: Object.fromEntries(CATEGORIES.map((c) => [c.name, c.limit])) };
}

export function save(state) {
  try {
    localStorage.setItem('zb-budget', JSON.stringify(state));
  } catch {}
}

export const money = (amount) => amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
