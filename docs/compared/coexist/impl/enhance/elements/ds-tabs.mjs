// A tab list. `tabs` is `[{ id, label }]`. The panels are the page's.
import { esc, read } from '../read.mjs';

export default function DsTabs({ html, state }) {
  const tabs = read(state, 'tabs', []);
  const selected = read(state, 'selected', '');
  const label = read(state, 'label', '');
  return html`
    <style>
      ds-tabs [role=tablist] { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line, #d5d9e2); }
      ds-tabs [role=tab] { padding: 0.5rem 0.9rem; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; background: none; color: var(--muted, #667085); font: inherit; font-weight: 600; cursor: pointer; }
      ds-tabs [role=tab][aria-selected=true] { color: var(--ink, #1d2130); border-bottom-color: var(--accent, #2f5fd0); }
    </style>
    <div role="tablist" ${label ? `aria-label="${esc(label)}"` : ''}>
      ${tabs.map((tab) => `<button type="button" role="tab" id="tab-${esc(tab.id)}" data-tab="${esc(tab.id)}" aria-selected="${tab.id === selected ? 'true' : 'false'}" tabindex="${tab.id === selected ? 0 : -1}">${esc(tab.label)}</button>`).join('')}
    </div>
  `;
}
