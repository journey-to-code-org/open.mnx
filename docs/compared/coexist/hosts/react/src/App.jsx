// The order desk in React. `ds` is the design system's React binding for whichever tool built it
// (impl/<tool>/react.*); nothing else in this file knows which.
import { useRef, useState } from 'react';
import { Badge, DataTable, Dialog, Field, Quantity, Tabs } from 'ds';
import { COLUMNS, PRICE, TABS, money, orderFrom, seed } from '../../../shared/data.js';

export function App() {
  const [orders, setOrders] = useState(seed);
  const [tab, setTab] = useState('orders');
  const [customer, setCustomer] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const form = useRef(null);
  const order = orders.find((item) => item.id === viewing);

  function add(event) {
    event.preventDefault();
    const next = orderFrom(new FormData(form.current), orders);
    if (!next.customer) return setError('Customer is required');
    setOrders([...orders, next]);
    setMessage(`Added order ${next.id} for ${next.customer}`);
    setError('');
    setCustomer('');
    setQuantity(1);
    setTab('orders');
  }
  function view(id) {
    setViewing(id);
    setOpen(true);
  }
  function ship() {
    setOrders(orders.map((item) => (item.id === viewing ? { ...item, status: 'shipped' } : item)));
    setMessage(`Order ${viewing} shipped`);
    setOpen(false);
  }

  return (
    <main>
      <h1>Order desk</h1>
      <Tabs label="Sections" tabs={TABS} selected={tab} onSelectedChange={(event) => setTab(event.detail)} />
      <div role="tabpanel" aria-label="Orders" hidden={tab !== 'orders'}>
        <p data-testid="summary">{orders.length} orders, {orders.filter((item) => item.status === 'shipped').length} shipped</p>
        <DataTable caption="Orders" columns={COLUMNS} rows={orders} onRowSelect={(event) => view(event.detail)} />
      </div>
      <div role="tabpanel" aria-label="New order" hidden={tab !== 'new'}>
        <form ref={form} onSubmit={add} noValidate>
          <Field label="Customer" name="customer" required value={customer} error={error} onValueChange={(event) => setCustomer(event.detail)} />
          <Quantity label="Quantity" name="quantity" min={1} max={10} value={quantity} onValueChange={(event) => setQuantity(event.detail)} />
          <p data-testid="total">Total: {money(quantity * PRICE)}</p>
          <button type="submit">Add order</button>
        </form>
      </div>
      <Dialog heading={order ? `Order ${order.id}` : ''} open={open} onOpenChange={(event) => setOpen(event.detail)}>
        {order && (
          <div>
            <p data-testid="detail">{order.customer}: {order.quantity} × Trail mug, {money(order.total)}</p>
            <p><Badge status={order.status} /></p>
            <button type="button" disabled={order.status !== 'pending'} onClick={ship}>Mark shipped</button>
          </div>
        )}
      </Dialog>
      <p role="status">{message}</p>
    </main>
  );
}
