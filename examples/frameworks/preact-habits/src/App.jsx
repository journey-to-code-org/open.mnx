import { useEffect, useMemo, useState } from 'preact/hooks';
import './components/streak-grid.zb';
import './components/check-ring.zb';
import './components/color-swatches.zb';
import { bestStreak, currentStreak, dayOf, load, rate, save } from './habits.js';

const today = dayOf(new Date());
const longDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export function App() {
  const [habits, setHabits] = useState(() => load(today));
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', goal: 1, color: '#db2777' });
  useEffect(() => save(habits), [habits]);

  const change = (id, fn) => setHabits((list) => list.map((habit) => (habit.id === id ? fn(habit) : habit)));
  const setCount = (id, day, count) => change(id, (habit) => ({ ...habit, log: { ...habit.log, [day]: count } }));
  // Toggling a day in the grid: met ↔ not done.
  const toggle = (habit, day) => setCount(habit.id, day, (habit.log[day] ?? 0) >= habit.goal ? 0 : habit.goal);

  const doneToday = useMemo(() => habits.filter((habit) => (habit.log[today] ?? 0) >= habit.goal).length, [habits]);

  function add(event) {
    event.preventDefault();
    setHabits([...habits, { id: `h${Date.now().toString(36)}`, name: draft.name.trim(), goal: Math.max(1, Number(draft.goal) || 1), color: draft.color, log: {} }]);
    setDraft({ name: '', goal: 1, color: draft.color });
    setAdding(false);
  }

  return (
    <div class="app">
      <header>
        <div>
          <h1>Habits</h1>
          <p class="date">{longDate}</p>
        </div>
        <div class="today" aria-live="polite">
          <strong class="done-count">{doneToday}/{habits.length}</strong>
          <span>done today</span>
          <progress max={habits.length || 1} value={doneToday} aria-label="Done today" />
        </div>
      </header>

      <ul class="habits">
        {habits.map((habit) => {
          const count = habit.log[today] ?? 0;
          const streak = currentStreak(habit, today);
          return (
            <li key={habit.id} class="habit" data-id={habit.id} style={{ '--habit': habit.color }}>
              <div class="top">
                <check-ring value={count} goal={habit.goal} label={habit.name} onvaluechange={(event) => setCount(habit.id, today, event.detail)} />
                <div class="name">
                  <h2>{habit.name}</h2>
                  <p>{habit.goal > 1 ? `${count}/${habit.goal} today · ` : ''}<span class="streak">{streak ? `🔥 ${streak} day${streak === 1 ? '' : 's'}` : 'No streak yet'}</span></p>
                </div>
                <dl class="stats">
                  <div><dt>Best</dt><dd class="best">{bestStreak(habit)}</dd></div>
                  <div><dt>30 days</dt><dd class="rate">{Math.round(rate(habit, today) * 100)}%</dd></div>
                </dl>
                <button type="button" class="remove" aria-label={`Delete ${habit.name}`} onClick={() => setHabits(habits.filter((item) => item.id !== habit.id))}>×</button>
              </div>
              <streak-grid log={habit.log} goal={habit.goal} today={today} weeks={32} label={`${habit.name}: last 32 weeks`} ondaytoggle={(event) => toggle(habit, event.detail)} />
            </li>
          );
        })}
      </ul>

      {adding ? (
        <form class="add" onSubmit={add}>
          <h2>New habit</h2>
          <label>Name <input required autoFocus value={draft.name} onInput={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
          <label>Times a day <input type="number" min="1" max="20" value={draft.goal} onInput={(event) => setDraft({ ...draft, goal: event.currentTarget.value })} /></label>
          <div class="field">
            <span>Colour</span>
            <color-swatches name="color" value={draft.color} label="Colour" onvaluechange={(event) => setDraft({ ...draft, color: event.detail })} />
          </div>
          <div class="actions">
            <button type="button" onClick={() => setAdding(false)}>Cancel</button>
            <button type="submit" class="primary">Add habit</button>
          </div>
        </form>
      ) : (
        <button type="button" class="new primary" onClick={() => setAdding(true)}>+ New habit</button>
      )}
    </div>
  );
}
