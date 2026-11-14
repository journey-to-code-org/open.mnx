// An order's status, as a coloured label.
import { esc, read } from '../read.mjs';

export default function DsBadge({ html, state }) {
  const status = read(state, 'status', 'pending');
  return html`
    <style>
      ds-badge span { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 1rem; font-size: 0.8rem; font-weight: 600; background: #eef0f4; }
      ds-badge span[data-status=shipped] { background: #dcf5e4; color: #14602f; }
      ds-badge span[data-status=cancelled] { background: #fde3e1; color: #8f1d14; }
    </style>
    <span data-status="${esc(status)}">${esc(status.slice(0, 1).toUpperCase() + status.slice(1))}</span>
  `;
}
