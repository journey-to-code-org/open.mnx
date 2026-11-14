// The design system as Vue components, written by hand (../vue-wrap.js): each element's props
// and their types, whether it takes v-model, and its events, repeated from the components.
import './elements.js';
import { wrap } from '../vue-wrap.js';

export const Badge = wrap('ds-badge', { status: { type: String, default: 'pending' } });
export const Field = wrap('ds-field', { label: String, name: String, value: { type: String, default: '' }, required: Boolean, error: { type: String, default: '' } }, { model: true });
export const Quantity = wrap('ds-quantity', { label: String, name: String, value: { type: Number, default: 1 }, min: { type: Number, default: 1 }, max: { type: Number, default: 10 } }, { model: true });
export const Tabs = wrap('ds-tabs', { tabs: { type: Array, default: () => [] }, selected: { type: String, default: '' }, label: { type: String, default: '' } }, { events: ['selectedchange'] });
export const Dialog = wrap('ds-dialog', { open: Boolean, heading: { type: String, default: '' } }, { events: ['openchange'] });
export const DataTable = wrap('ds-table', { caption: { type: String, default: '' }, columns: { type: Array, default: () => [] }, rows: { type: Array, default: () => [] } }, { events: ['rowselect'] });
