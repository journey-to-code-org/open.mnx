// Content script, in the extension's isolated world: it can use chrome.storage, but it can't
// define custom elements (`customElements` is null there). So it hands this site's notes to the
// widget, which runs in the page's own world, as JSON in DOM events, and takes "hide" back.
import { load, originOf, saveSettings, settings } from './notes.js';

const origin = originOf(location.href);

async function send() {
  const options = await settings();
  const show = options.widget && !options.hidden.includes(origin);
  const notes = show ? await load(origin) : [];
  document.dispatchEvent(new CustomEvent('page-notes:data', { detail: JSON.stringify(notes) }));
}

if (origin) {
  // The widget asks when it's ready (it may load before or after this script); changes push.
  document.addEventListener('page-notes:ready', send);
  document.addEventListener('page-notes:hide', async () => {
    const { hidden } = await settings();
    await saveSettings({ hidden: [...new Set([...hidden, origin])] });
  });
  chrome.storage.onChanged.addListener(send);
  send();
}
