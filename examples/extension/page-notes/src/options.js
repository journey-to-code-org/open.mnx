// The options page: the widget on pages, the default colour, sites it's hidden on, and export.
import './components/toggle-switch.zb';
import './components/color-swatches.zb';
import { all, saveSettings, settings } from './notes.js';

const toggle = document.querySelector('toggle-switch');
const swatches = document.querySelector('color-swatches');
const hidden = document.querySelector('#hidden');
const current = await settings();

toggle.checked = current.widget;
swatches.value = current.color;
toggle.addEventListener('checkedchange', (event) => saveSettings({ widget: event.detail }));
swatches.addEventListener('valuechange', (event) => saveSettings({ color: event.detail }));

function showHidden(origins) {
  hidden.replaceChildren(...origins.map((origin) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Show again';
    button.addEventListener('click', async () => {
      const rest = (await settings()).hidden.filter((entry) => entry !== origin);
      await saveSettings({ hidden: rest });
      showHidden(rest);
    });
    item.append(`${new URL(origin).host} `, button);
    return item;
  }));
  hidden.closest('section').hidden = origins.length === 0;
}
showHidden(current.hidden);

document.querySelector('#export').addEventListener('click', async () => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(await all(), null, 2)], { type: 'application/json' }));
  link.download = 'page-notes.json';
  link.click();
  URL.revokeObjectURL(link.href);
});
document.body.dataset.ready = 'true';
