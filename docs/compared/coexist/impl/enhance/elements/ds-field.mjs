// A labelled text input with an error message. The input carries `name`, so a form submits it
// before any JavaScript.
import { esc, read } from '../read.mjs';

export default function DsField({ html, state }) {
  const label = read(state, 'label', '');
  const name = read(state, 'name', '');
  const value = read(state, 'value', '');
  const required = read(state, 'required', false);
  const error = read(state, 'error', '');
  const id = `f-${state.instanceID}`;
  return html`
    <style>
      ds-field { display: grid; gap: 0.25rem; }
      ds-field label { font-weight: 600; }
      ds-field input { font: inherit; padding: 0.4rem 0.5rem; border: 1px solid var(--line, #d5d9e2); border-radius: 0.4rem; }
      ds-field input[aria-invalid=true] { border-color: #c0271b; }
      ds-field p { margin: 0; color: #c0271b; font-size: 0.85rem; }
    </style>
    <label for="${id}">${esc(label)}</label>
    <input id="${id}" ${name ? `name="${esc(name)}"` : ''} value="${esc(value)}" ${required ? 'required' : ''}
           aria-invalid="${error ? 'true' : 'false'}" ${error ? `aria-describedby="${id}-error"` : ''}>
    ${error ? `<p id="${id}-error" role="alert">${esc(error)}</p>` : ''}
  `;
}
