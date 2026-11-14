// The design system as React components: Stencil's React output target writes them
// (generated/react), naming each event prop after the DOM event (`onValuechange`). The host
// uses React's casing (`onValueChange`), so the four with events are renamed here by hand.
import { DsDialog, DsField, DsQuantity, DsTable, DsTabs } from './generated/react/components.ts';

export { DsBadge as Badge } from './generated/react/components.ts';
export const Field = ({ onValueChange, ...props }) => <DsField {...props} onValuechange={onValueChange} />;
export const Quantity = ({ onValueChange, ...props }) => <DsQuantity {...props} onValuechange={onValueChange} />;
export const Tabs = ({ onSelectedChange, ...props }) => <DsTabs {...props} onSelectedchange={onSelectedChange} />;
export const Dialog = ({ onOpenChange, ...props }) => <DsDialog {...props} onOpenchange={onOpenChange} />;
export const DataTable = ({ onRowSelect, ...props }) => <DsTable {...props} onRowselect={onRowSelect} />;
