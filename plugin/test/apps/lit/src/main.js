import { html, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import '../components/rating.zb';
import '../components/card.zb';
import '../components/badge.zb';

const state = { stars: 1, items: ['a', 'b'], title: true, info: { color: 'red' }, log: [] };
const root = document.getElementById('root');
function update() {
  render(html`
    <zb-rating .value=${state.stars} @valuechange=${(event) => { state.stars = event.detail; update(); }} @change=${() => { state.log.push('change'); update(); }}></zb-rating>
    <p id="stars">${state.stars}</p>
    <zb-card heading="Lit">
      ${state.title ? html`<h2 slot="title">Custom</h2>` : null}
      ${repeat(state.items, (item) => item, (item) => html`<p>${item}</p>`)}
    </zb-card>
    <zb-badge label="x" .info=${state.info}></zb-badge>
    <p id="log">${state.log.join(',')}</p>`, root);
}
update();
window.app = {
  setItems: (items) => { state.items = items; update(); },
  setTitle: (title) => { state.title = title; update(); },
  setInfo: (info) => { state.info = info; update(); },
};
window.ready = true;
