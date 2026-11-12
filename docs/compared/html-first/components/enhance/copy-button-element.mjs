// The README's copy button for Enhance: the server render, a function of attributes.
export default function CopyButtonElement({ html, state }) {
  const { attrs = {} } = state;
  const { label = 'Copy' } = attrs;
  return html`
    <style>
      button.done { color: green; }
    </style>
    <button type="button">${label}</button>
  `;
}
