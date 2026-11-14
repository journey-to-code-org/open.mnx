// No design system: components that render nothing, so measure.mjs can subtract what a host
// weighs by itself from what it weighs with each tool's components.
const None = () => null;
export { None as Badge, None as Field, None as Quantity, None as Tabs, None as Dialog, None as DataTable };
