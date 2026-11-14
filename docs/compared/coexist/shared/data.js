// The data every host starts from, whatever built the components.
export const PRICE = 12.5; // one Trail mug

export const TABS = [
  { id: 'orders', label: 'Orders' },
  { id: 'new', label: 'New order' },
];

export const COLUMNS = [
  { key: 'id', label: 'Order' },
  { key: 'customer', label: 'Customer', sortable: true },
  { key: 'quantity', label: 'Mugs' },
  { key: 'total', label: 'Total', type: 'money', sortable: true },
  { key: 'status', label: 'Status', type: 'status' },
];

export const seed = () => [
  { id: 1001, customer: 'Mabel', quantity: 4, total: 50, status: 'shipped' },
  { id: 1002, customer: 'Otis', quantity: 1, total: 12.5, status: 'pending' },
  { id: 1003, customer: 'Ines', quantity: 2, total: 25, status: 'cancelled' },
];

/** The next order, from what the form submitted (a FormData, so the controls must be in it). */
export function orderFrom(formData, orders) {
  const quantity = Number(formData.get('quantity'));
  return {
    id: Math.max(1000, ...orders.map((order) => order.id)) + 1,
    customer: String(formData.get('customer') ?? '').trim(),
    quantity,
    total: quantity * PRICE,
    status: 'pending',
  };
}

export const money = (amount) => `$${Number(amount).toFixed(2)}`;
