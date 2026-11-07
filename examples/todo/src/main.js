// Importing a component defines its element; the page's <todo-app> starts by itself.
import './components/todo-app.mnx';

const app = document.querySelector('todo-app');
const KEY = 'mnx-todo';

// Props are properties: give it the saved list, and save what it reports.
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (Array.isArray(saved)) app.items = saved;
} catch {
  // Nothing saved yet, or storage is unavailable.
}
app.addEventListener('change', (event) => {
  try { localStorage.setItem(KEY, JSON.stringify(event.detail)); } catch { /* storage unavailable */ }
});
window.ready = true;
