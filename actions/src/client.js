// @zubra/actions in the browser: a form that posts to a 'use server' function is sent with fetch
// instead, so the page stays put. Without this script (or without JavaScript), the same form posts
// normally and the server redirects back. Everything here is the platform's: a `submit` listener,
// FormData, fetch, `aria-busy`, and two DOM events on the form.
//
//   beforeaction  cancelable; before the request (detail: { formData })
//   action        after it (detail: { value } or { error, status })
//
//   <form action={save} onaction={(event) => (saved = event.detail.value)}>
//
// A form opts out with `data-zb-native`. Forms inside a shadow root: call `enhance(shadowRoot)`.
const MOUNT = '/_zb/action/';

function target(form, submitter) {
  const action = submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? '';
  const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase();
  return method === 'post' && action.startsWith(MOUNT) ? action : null;
}

async function submit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || event.defaultPrevented || form.hasAttribute('data-zb-native')) return;
  const action = target(form, event.submitter);
  if (!action) return;
  event.preventDefault();
  const formData = new FormData(form, event.submitter ?? undefined);
  const before = new CustomEvent('beforeaction', { bubbles: true, cancelable: true, detail: { formData } });
  if (!form.dispatchEvent(before)) return;
  form.setAttribute('aria-busy', 'true');
  let detail;
  try {
    const response = await fetch(action, { method: 'POST', body: formData, headers: { accept: 'application/json' } });
    const next = response.headers.get('zb-location');
    if (next) {
      location.assign(next);
      return;
    }
    if (response.redirected) {
      location.assign(response.url);
      return;
    }
    const type = response.headers.get('content-type') ?? '';
    const value = type.includes('application/json') ? await response.json() : null;
    detail = response.ok ? { value } : { error: value?.error ?? response.statusText, status: response.status };
  } catch (error) {
    detail = { error: error.message, status: 0 };
  } finally {
    form.removeAttribute('aria-busy');
  }
  form.dispatchEvent(new CustomEvent('action', { bubbles: true, detail }));
}

/** Enhance the forms under `root` (the document already is; pass a shadow root for its forms). */
export function enhance(root) {
  root.addEventListener('submit', submit);
}

enhance(document);
