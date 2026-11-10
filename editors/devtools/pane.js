// The Zubra pane in the Elements panel: reads the selected node ($0) through the page's
// `__ZUBRA_DEVTOOLS__` (runtime/src/devtools.js) and shows it. Only `inspectedWindow.eval`: no
// content script, no host permissions. It re-reads when the selection changes, and when the
// page's update counter moves while the pane is visible.
import { render } from './render.js';

const pane = document.getElementById('pane');
const inspected = chrome.devtools.inspectedWindow;
document.documentElement.dataset.theme = chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';

// Runs in the page: connect (which loads the reading side once), then inspect the selection.
const READ = `(() => {
  const hook = globalThis.__ZUBRA_DEVTOOLS__;
  if (!hook) return { missing: true };
  hook.connect();
  if (!hook.ready) return { loading: true };
  return hook.inspect($0);
})()`;
const UPDATES = 'globalThis.__ZUBRA_DEVTOOLS__?.updates ?? null';

const evaluate = (code) => new Promise((resolve) => {
  inspected.eval(code, (result, exception) => resolve(exception ? { error: exception.value ?? exception.description ?? 'the page threw' } : result));
});

/** Put the rendered HTML in the pane. render() escapes every value from the page; parsing it
 * with DOMParser (no scripts run there) rather than assigning innerHTML keeps that plain. */
function show(html) {
  pane.replaceChildren(...new DOMParser().parseFromString(html, 'text/html').body.childNodes);
}

let lastUpdates = null;
let reading = false;
async function read(attempt = 0) {
  if (reading) return;
  reading = true;
  const result = await evaluate(READ);
  reading = false;
  show(render(result));
  lastUpdates = result?.update ?? null;
  // The reading side is loading (a dynamic import): try again shortly.
  if (result?.loading && attempt < 40) setTimeout(() => read(attempt + 1), 50);
}

pane.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-file]');
  if (!button) return;
  const { file, line, column } = button.dataset;
  evaluate(`globalThis.__ZUBRA_DEVTOOLS__?.open(${JSON.stringify(file)}, ${Number(line)}, ${Number(column)})`);
});

chrome.devtools.panels.elements.onSelectionChanged.addListener(() => read());
// A navigation in the inspected page: start over.
chrome.devtools.network?.onNavigated?.addListener(() => setTimeout(() => read(), 300));

// Follow updates while visible: one cheap counter read, a full read only when it moved.
setInterval(async () => {
  if (document.visibilityState !== 'visible') return;
  const updates = await evaluate(UPDATES);
  if (updates !== null && updates !== lastUpdates) read();
}, 500);

read();
