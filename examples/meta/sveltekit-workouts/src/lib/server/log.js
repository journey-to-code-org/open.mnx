// The workout log, in the server's memory (seeded relative to today; a real app would use a
// database).
const DAY = 86_400_000;
export const EXERCISES = ['squat', 'deadlift', 'bench press', 'pull-up', 'row', 'plank'];
export const day = (time) => new Date(time).toISOString().slice(0, 10);

function seed(now = Date.now()) {
  const plan = [[0, 'squat', 5, 5, 4], [1, 'pull-up', 4, 8, 3], [3, 'deadlift', 3, 5, 5], [4, 'plank', 3, 1, 2], [6, 'bench press', 5, 5, 4], [9, 'row', 4, 10, 3], [10, 'squat', 5, 5, 4], [13, 'pull-up', 4, 6, 4]];
  return plan.map(([ago, exercise, sets, reps, effort], index) => ({ id: index + 1, exercise, sets, reps, effort, at: now - ago * DAY - 3_600_000 }));
}

const state = (globalThis.__workouts ??= { list: seed() });
export const reset = () => { state.list = seed(); };
export const workouts = () => [...state.list].sort((a, b) => b.at - a.at);
export function add(workout) {
  state.list.push({ ...workout, id: Math.max(0, ...state.list.map((item) => item.id)) + 1, at: Date.now() });
}
/** Workouts per day, `{ 'YYYY-MM-DD': count }`. */
export function perDay() {
  const counts = {};
  for (const workout of state.list) counts[day(workout.at)] = (counts[day(workout.at)] ?? 0) + 1;
  return counts;
}
export function thisWeek(now = Date.now()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return new Set(state.list.filter((workout) => workout.at >= start.getTime()).map((workout) => day(workout.at))).size;
}
