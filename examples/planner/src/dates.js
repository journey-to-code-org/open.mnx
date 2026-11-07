// Dates are local calendar days as "YYYY-MM-DD" strings and times as "HH:MM": they sort as
// text, compare as text, and survive JSON.

const pad = (n) => String(n).padStart(2, '0');

export const toDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const fromDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const today = () => toDay(new Date());
export const addDays = (day, n) => {
  const date = fromDay(day);
  date.setDate(date.getDate() + n);
  return toDay(date);
};
export const daysBetween = (from, to) => Math.round((fromDay(to) - fromDay(from)) / 86400000);

/** "YYYY-MM" for the month a day is in, and months before or after it. */
export const monthOf = (day) => day.slice(0, 7);
export const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(y, m - 1 + n, 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
};

/** The weeks (Monday first) that cover a month: arrays of 7 days. */
export function weeksOf(month) {
  const first = fromDay(`${month}-01`);
  const start = addDays(toDay(first), -((first.getDay() + 6) % 7));
  const weeks = [];
  for (let day = start; weeks.length === 0 || monthOf(day) <= month; ) {
    const week = [];
    for (let i = 0; i < 7; i++, day = addDays(day, 1)) week.push(day);
    weeks.push(week);
  }
  return weeks;
}

const monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' });
const longDay = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDay = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric' });
export const formatMonth = (month) => monthName.format(fromDay(`${month}-01`));
export const formatDay = (day) => longDay.format(fromDay(day));
export const formatShortDay = (day) => shortDay.format(fromDay(day));

/** "today", "tomorrow", "in 5 days", "3 days ago". */
export function relative(day, from = today()) {
  const n = daysBetween(from, day);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export const money = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
