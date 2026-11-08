// The café: the menu and the order are plain JavaScript state; the components are Zubra
// elements styled with Tailwind.
import './app.css';
// The same CSS as a string, for the shadow-DOM component: page CSS doesn't reach into shadow
// roots, so adoptStyles() puts it in every Zubra shadow root (Tailwind 4 writes its theme
// variables for `:root, :host`, so they're defined there too).
import tailwind from './app.css?inline';
import { adoptStyles } from '@zubra/runtime';
import './components/category-tabs.zb';
import './components/menu-card.zb';
import './components/order-summary.zb';
import { menu } from './menu.js';

adoptStyles(tailwind);

const order = new Map(); // `${id}:${size}` → count
let category = 'All';
let placed = false;

const tabs = document.querySelector('#tabs');
const list = document.querySelector('#menu');
const summary = document.querySelector('#order');

tabs.categories = ['All', ...new Set(menu.map((item) => item.category))];
tabs.addEventListener('valuechange', (event) => {
  category = event.detail;
  render();
});

const cards = new Map(menu.map((item) => {
  const card = document.createElement('menu-card');
  card.item = item;
  card.dataset.id = item.id;
  card.addEventListener('add', ({ detail: { id, size } }) => {
    const key = `${id}:${size}`;
    order.set(key, (order.get(key) ?? 0) + 1);
    placed = false;
    render();
  });
  return [item.id, card];
}));

summary.addEventListener('remove', ({ detail: key }) => {
  const count = order.get(key) - 1;
  if (count > 0) order.set(key, count);
  else order.delete(key);
  render();
});
summary.addEventListener('checkout', () => {
  order.clear();
  placed = true;
  render();
});

function render() {
  const shown = menu.filter((item) => category === 'All' || item.category === category);
  list.replaceChildren(...shown.map((item) => cards.get(item.id)));
  for (const [id, card] of cards) {
    card.count = [...order].filter(([key]) => key.startsWith(`${id}:`)).reduce((sum, [, count]) => sum + count, 0);
  }
  summary.placed = placed;
  summary.lines = [...order].map(([key, count]) => {
    const [id, size] = key.split(':');
    const item = menu.find((entry) => entry.id === id);
    return { key, name: item.name, size, price: item.prices[size], count };
  });
}

render();
