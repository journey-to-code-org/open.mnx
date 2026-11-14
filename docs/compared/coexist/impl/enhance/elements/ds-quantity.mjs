// A number with − and + buttons, kept between `min` and `max`. The input carries `name`, so a
// form submits it before any JavaScript.
import { esc, read } from '../read.mjs';

export default function DsQuantity({ html, state }) {
  const label = read(state, 'label', '');
  const name = read(state, 'name', '');
  const value = read(state, 'value', 1);
  const min = read(state, 'min', 1);
  const max = read(state, 'max', 10);
  const id = `q-${state.instanceID}`;
  return html`
    <style>
      ds-quantity { display: grid; gap: 0.25rem; }
      ds-quantity label { font-weight: 600; }
      ds-quantity div { display: flex; gap: 0.25rem; }
      ds-quantity input { font: inherit; width: 4rem; padding: 0.4rem 0.5rem; border: 1px solid var(--line, #d5d9e2); border-radius: 0.4rem; text-align: center; }
      ds-quantity button { width: 2.2rem; border: 1px solid var(--line, #d5d9e2); border-radius: 0.4rem; background: var(--surface, #fff); cursor: pointer; }
      ds-quantity button:disabled { opacity: 0.4; cursor: default; }
    </style>
    <label for="${id}">${esc(label)}</label>
    <div>
      <button type="button" data-step="-1" aria-label="Decrease ${esc(label)}" ${value <= min ? 'disabled' : ''}>−</button>
      <input id="${id}" ${name ? `name="${esc(name)}"` : ''} type="number" min="${min}" max="${max}" value="${value}">
      <button type="button" data-step="1" aria-label="Increase ${esc(label)}" ${value >= max ? 'disabled' : ''}>+</button>
    </div>
  `;
}
