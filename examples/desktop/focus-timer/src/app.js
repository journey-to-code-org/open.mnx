// The window: pick a mode, say what you're working on, run the timer; finished sessions are
// saved (by the main process, through the preload's `focusTimer` API) and logged.
import './components/focus-timer.mnx';
import './components/segmented-control.mnx';
import './components/session-log.mnx';

const LENGTHS = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
const modes = document.querySelector('segmented-control');
const timer = document.querySelector('focus-timer');
const task = document.querySelector('#task');
const what = document.querySelector('#what');
const log = document.querySelector('session-log');

const data = await window.focusTimer.load();
const lengths = { ...LENGTHS, ...data.lengths };
const today = new Date().toDateString();
let sessions = data.sessions.filter((session) => new Date(session.at).toDateString() === today);

modes.options = [{ value: 'focus', label: 'Focus' }, { value: 'short', label: 'Short break' }, { value: 'long', label: 'Long break' }];
function setMode(mode) {
  modes.value = mode;
  timer.seconds = lengths[mode];
  document.body.dataset.mode = mode;
  task.disabled = mode !== 'focus';
  what.textContent = mode === 'focus' ? task.value || 'Focus' : 'Break';
}
setMode('focus');
log.sessions = sessions;

modes.addEventListener('valuechange', (event) => setMode(event.detail));
task.addEventListener('input', () => (what.textContent = task.value || 'Focus'));
timer.addEventListener('running', (event) => window.focusTimer.running(event.detail));
timer.addEventListener('done', async (event) => {
  const session = { id: crypto.randomUUID(), mode: modes.value, task: modes.value === 'focus' ? task.value : '', seconds: event.detail, at: Date.now() };
  sessions = [...sessions, session];
  log.sessions = sessions;
  await window.focusTimer.finished(session);
  // After focus, a break (a long one every fourth); after a break, focus.
  const focused = sessions.filter((entry) => entry.mode === 'focus').length;
  setMode(session.mode === 'focus' ? (focused % 4 === 0 ? 'long' : 'short') : 'focus');
});
document.body.dataset.ready = 'true';
