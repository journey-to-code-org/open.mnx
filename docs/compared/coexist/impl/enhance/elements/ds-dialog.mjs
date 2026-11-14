// A modal dialog on the native <dialog>. The default slot is the dialog's content. In the
// browser it has a shadow root: Enhance fills light-DOM slots by rewriting the element's HTML
// once, which would throw away the children a framework keeps updating.
import { esc, read } from '../read.mjs';

export default function DsDialog({ html, state }) {
  const heading = read(state, 'heading', '');
  return html`
    <style>
      dialog { border: 0; border-radius: 0.8rem; padding: 1.25rem; width: min(26rem, calc(100vw - 2rem)); box-shadow: 0 24px 64px #0d122040; }
      dialog::backdrop { background: #0d122066; }
      header { display: flex; align-items: center; gap: 1rem; }
      h2 { flex: 1; margin: 0; font-size: 1.1rem; }
      header button { border: 0; background: none; font-size: 1.4rem; line-height: 1; cursor: pointer; }
    </style>
    <dialog aria-labelledby="heading">
      <header>
        <h2 id="heading">${esc(heading)}</h2>
        <button type="button" aria-label="Close">×</button>
      </header>
      <slot></slot>
    </dialog>
  `;
}
