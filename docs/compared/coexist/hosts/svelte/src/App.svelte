<script>
  // The order desk in Svelte, which uses the elements as they are: properties in, events out.
  // `ds` defines them, for whichever tool built them (impl/<tool>/elements.*).
  import 'ds';
  import { COLUMNS, PRICE, TABS, money, orderFrom, seed } from '../../../shared/data.js';

  let orders = $state.raw(seed());
  let tab = $state('orders');
  let customer = $state('');
  let quantity = $state(1);
  let error = $state('');
  let viewing = $state(null);
  let open = $state(false);
  let message = $state('');
  let form;
  const order = $derived(orders.find((item) => item.id === viewing));
  const shipped = $derived(orders.filter((item) => item.status === 'shipped').length);

  function add(event) {
    event.preventDefault();
    const next = orderFrom(new FormData(form), orders);
    if (!next.customer) return (error = 'Customer is required');
    orders = [...orders, next];
    message = `Added order ${next.id} for ${next.customer}`;
    error = '';
    customer = '';
    quantity = 1;
    tab = 'orders';
  }
  function view(id) {
    viewing = id;
    open = true;
  }
  function ship() {
    orders = orders.map((item) => (item.id === viewing ? { ...item, status: 'shipped' } : item));
    message = `Order ${viewing} shipped`;
    open = false;
  }
</script>

<main>
  <h1>Order desk</h1>
  <ds-tabs label="Sections" tabs={TABS} selected={tab} onselectedchange={(event) => (tab = event.detail)}></ds-tabs>
  <div role="tabpanel" aria-label="Orders" hidden={tab !== 'orders'}>
    <p data-testid="summary">{orders.length} orders, {shipped} shipped</p>
    <ds-table caption="Orders" columns={COLUMNS} rows={orders} onrowselect={(event) => view(event.detail)}></ds-table>
  </div>
  <div role="tabpanel" aria-label="New order" hidden={tab !== 'new'}>
    <form bind:this={form} onsubmit={add} novalidate>
      <ds-field label="Customer" name="customer" required value={customer} {error} onvaluechange={(event) => (customer = event.detail)}></ds-field>
      <ds-quantity label="Quantity" name="quantity" min={1} max={10} value={quantity} onvaluechange={(event) => (quantity = event.detail)}></ds-quantity>
      <p data-testid="total">Total: {money(quantity * PRICE)}</p>
      <button type="submit">Add order</button>
    </form>
  </div>
  <ds-dialog heading={order ? `Order ${order.id}` : ''} {open} onopenchange={(event) => (open = event.detail)}>
    {#if order}
      <div>
        <p data-testid="detail">{order.customer}: {order.quantity} × Trail mug, {money(order.total)}</p>
        <p><ds-badge status={order.status}></ds-badge></p>
        <button type="button" disabled={order.status !== 'pending'} onclick={ship}>Mark shipped</button>
      </div>
    {/if}
  </ds-dialog>
  <p role="status">{message}</p>
</main>
