// The design system as custom elements: each element function (elements/, shared with the
// server) and what it does in the browser. The listeners are delegated, because morphdom
// replaces what's inside.
import { define } from './element.mjs';
import DsBadge from './elements/ds-badge.mjs';
import DsField from './elements/ds-field.mjs';
import DsQuantity from './elements/ds-quantity.mjs';
import DsTabs from './elements/ds-tabs.mjs';
import DsDialog from './elements/ds-dialog.mjs';
import DsTable from './elements/ds-table.mjs';

define('ds-badge', { render: DsBadge, props: { status: 'pending' } });

define('ds-field', {
  render: DsField,
  props: { label: '', name: '', value: '', required: false, error: '' },
  setup(element) {
    element.addEventListener('input', (event) => {
      element.value = event.target.value;
      element.emit('valuechange', element.value);
    });
  },
});

define('ds-quantity', {
  render: DsQuantity,
  props: { label: '', name: '', value: 1, min: 1, max: 10 },
  setup(element) {
    const change = (value) => {
      const next = Math.min(element.max, Math.max(element.min, value));
      if (next === element.value) return element.process(); // put the clamped number back in the input
      element.value = next;
      element.emit('valuechange', next);
    };
    element.addEventListener('click', (event) => {
      const step = event.target.closest('[data-step]')?.dataset.step;
      if (step) change(element.value + Number(step));
    });
    element.addEventListener('change', (event) => {
      const n = Number(event.target.value);
      if (event.target.value !== '' && !Number.isNaN(n)) change(n);
    });
  },
});

define('ds-tabs', {
  render: DsTabs,
  props: { tabs: [], selected: '', label: '' },
  setup(element) {
    const select = (id) => {
      element.selected = id;
      element.emit('selectedchange', id);
    };
    element.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (tab) select(tab.dataset.tab);
    });
    element.addEventListener('keydown', (event) => {
      const tabs = element.tabs;
      const index = tabs.findIndex((tab) => tab.id === element.selected);
      const last = tabs.length - 1;
      const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index <= 0 ? last : index - 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[next].id);
      queueMicrotask(() => element.querySelector('[aria-selected=true]')?.focus());
    });
  },
});

const Dialog = define('ds-dialog', {
  render: DsDialog,
  shadow: true,
  props: { open: false, heading: '' },
  setup(element) {
    const close = () => {
      if (!element.open) return;
      element.open = false;
      element.emit('openchange', false);
    };
    element.root.addEventListener('click', (event) => {
      if (event.target.closest('[aria-label=Close]')) close();
    });
    // `close` doesn't bubble, and morphdom keeps the <dialog>, so this listener stays on it.
    element.root.querySelector('dialog').addEventListener('close', close);
  },
});
// Follow `open` after each render: show the dialog modally, or close it.
Dialog.prototype.rendered = function () {
  const dialog = this.root.querySelector('dialog');
  if (this.open && !dialog.open) dialog.showModal();
  else if (!this.open && dialog.open) dialog.close();
};

define('ds-table', {
  render: DsTable,
  props: { caption: '', columns: [], rows: [], sort: '', descending: false },
  setup(element) {
    element.addEventListener('click', (event) => {
      const sort = event.target.closest('[data-sort]')?.dataset.sort;
      const view = event.target.closest('[data-view]')?.dataset.view;
      if (sort) {
        element.descending = element.sort === sort ? !element.descending : false;
        element.sort = sort;
      }
      if (view) element.emit('rowselect', element.rows.find((row) => String(row.id) === view).id);
    });
  },
});
