// Content script, in the page's own world (`"world": "MAIN"`), where custom elements exist. It
// shows the notes the bridge sends. The page can see these events too, so the data is only ever
// displayed as text (mnx escapes it), and a "hide" from the page only hides the widget.
import './components/page-notes-widget.mnx';

const widget = document.createElement('page-notes-widget');
document.addEventListener('page-notes:data', (event) => {
  try {
    widget.notes = JSON.parse(event.detail);
  } catch {
    return;
  }
  if (!widget.isConnected) document.documentElement.append(widget);
});
widget.addEventListener('hide', () => document.dispatchEvent(new CustomEvent('page-notes:hide')));
document.dispatchEvent(new CustomEvent('page-notes:ready'));
