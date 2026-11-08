// Habits, their logs ("YYYY-MM-DD" → count), streaks, and saving.

const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const shift = (day, n) => {
  const date = new Date(`${day}T12:00`);
  date.setDate(date.getDate() + n);
  return dayOf(date);
};

/** Days in a row that met the goal, ending today (or yesterday, if today isn't done yet). */
export function currentStreak(habit, today) {
  let day = (habit.log[today] ?? 0) >= habit.goal ? today : shift(today, -1);
  let count = 0;
  while ((habit.log[day] ?? 0) >= habit.goal) {
    count++;
    day = shift(day, -1);
  }
  return count;
}

export function bestStreak(habit) {
  const days = Object.keys(habit.log).filter((day) => habit.log[day] >= habit.goal).sort();
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    run = previous && shift(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return best;
}

/** Share of the last `days` days that met the goal. */
export function rate(habit, today, days = 30) {
  let met = 0;
  for (let i = 0; i < days; i++) if ((habit.log[shift(today, -i)] ?? 0) >= habit.goal) met++;
  return met / days;
}

function seed(today) {
  const log = (pattern, goal = 1) => {
    // `pattern` over the last 40 days, oldest first: a digit is that day's count.
    const out = {};
    [...pattern].forEach((count, index) => {
      if (count !== '0') out[shift(today, index - pattern.length)] = Number(count) * goal;
    });
    return out;
  };
  return [
    { id: 'h1', name: 'Read 20 pages', goal: 1, color: '#2563eb', log: log('1101111011110111111011101111110111111011') },
    { id: 'h2', name: 'Drink water', goal: 8, color: '#0891b2', log: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [shift(today, i - 40), [8, 6, 8, 8, 4, 8, 7, 8, 8, 8][i % 10]])) },
    { id: 'h3', name: 'Walk outside', goal: 1, color: '#16a34a', log: log('0110100110011101100111011011100111101110') },
    { id: 'h4', name: 'No phone after 10pm', goal: 1, color: '#7c3aed', log: log('0000000000000000000000000001101111011111') },
  ];
}

export function load(today) {
  try {
    const saved = JSON.parse(localStorage.getItem('zb-habits'));
    if (Array.isArray(saved)) return saved;
  } catch {}
  return seed(today);
}

export function save(habits) {
  try {
    localStorage.setItem('zb-habits', JSON.stringify(habits));
  } catch {}
}
