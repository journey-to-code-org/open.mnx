// The toolbar popup: the current site's notes, and a box to add one.
import './components/note-list.zb';
import './components/note-composer.zb';
import { load, originOf, save, settings } from './notes.js';

const list = document.querySelector('note-list');
const composer = document.querySelector('note-composer');
const site = document.querySelector('#site');

// The site of the active tab. (`?url=` stands in for it when the popup is opened as a page: in
// the tests, and from "open in a tab".)
const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
const origin = originOf(new URL(location.href).searchParams.get('url') ?? tab?.url ?? '');

if (!origin) {
  site.textContent = 'Notes work on web pages (http and https).';
  composer.hidden = true;
} else {
  site.textContent = new URL(origin).host;
  composer.color = (await settings()).color;
  let notes = await load(origin);
  const show = () => (list.notes = notes);
  show();
  composer.addEventListener('add', async (event) => {
    notes = [{ id: crypto.randomUUID(), at: Date.now(), ...event.detail }, ...notes];
    show();
    await save(origin, notes);
  });
  list.addEventListener('remove', async (event) => {
    notes = notes.filter((note) => note.id !== event.detail);
    show();
    await save(origin, notes);
  });
}
document.body.dataset.ready = 'true';
