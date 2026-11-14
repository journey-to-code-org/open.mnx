// The design system as React components, written by hand: Enhance has no React output. React 19
// sets an element's properties and listens for its events itself, so each is the tag with the
// events' names changed.
import './elements.js';

export const Badge = (props) => <ds-badge {...props} />;
export const Field = ({ onValueChange, ...props }) => <ds-field {...props} onvaluechange={onValueChange} />;
export const Quantity = ({ onValueChange, ...props }) => <ds-quantity {...props} onvaluechange={onValueChange} />;
export const Tabs = ({ onSelectedChange, ...props }) => <ds-tabs {...props} onselectedchange={onSelectedChange} />;
export const Dialog = ({ onOpenChange, ...props }) => <ds-dialog {...props} onopenchange={onOpenChange} />;
export const DataTable = ({ onRowSelect, ...props }) => <ds-table {...props} onrowselect={onRowSelect} />;
