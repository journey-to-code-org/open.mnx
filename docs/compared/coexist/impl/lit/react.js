// The design system as React components, through @lit/react: each element's class, and the
// React name of each event it fires.
import React from 'react';
import { createComponent } from '@lit/react';
import { DsBadge } from './components/ds-badge.js';
import { DsField } from './components/ds-field.js';
import { DsQuantity } from './components/ds-quantity.js';
import { DsTabs } from './components/ds-tabs.js';
import { DsDialog } from './components/ds-dialog.js';
import { DsTable } from './components/ds-table.js';

export const Badge = createComponent({ react: React, tagName: 'ds-badge', elementClass: DsBadge });
export const Field = createComponent({ react: React, tagName: 'ds-field', elementClass: DsField, events: { onValueChange: 'valuechange' } });
export const Quantity = createComponent({ react: React, tagName: 'ds-quantity', elementClass: DsQuantity, events: { onValueChange: 'valuechange' } });
export const Tabs = createComponent({ react: React, tagName: 'ds-tabs', elementClass: DsTabs, events: { onSelectedChange: 'selectedchange' } });
export const Dialog = createComponent({ react: React, tagName: 'ds-dialog', elementClass: DsDialog, events: { onOpenChange: 'openchange' } });
export const DataTable = createComponent({ react: React, tagName: 'ds-table', elementClass: DsTable, events: { onRowSelect: 'rowselect' } });
