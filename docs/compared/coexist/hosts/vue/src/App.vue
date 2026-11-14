<script setup>
// The order desk in Vue. `ds` is the design system's Vue binding for whichever tool built it
// (impl/<tool>/vue.*); nothing else in this file knows which.
import { computed, ref } from 'vue';
import { Badge, DataTable, Dialog, Field, Quantity, Tabs } from 'ds';
import { COLUMNS, PRICE, TABS, money, orderFrom, seed } from '../../../shared/data.js';

const orders = ref(seed());
const tab = ref('orders');
const customer = ref('');
const quantity = ref(1);
const error = ref('');
const viewing = ref(null);
const open = ref(false);
const message = ref('');
const form = ref(null);
const order = computed(() => orders.value.find((item) => item.id === viewing.value));
const shipped = computed(() => orders.value.filter((item) => item.status === 'shipped').length);

function add() {
  const next = orderFrom(new FormData(form.value), orders.value);
  if (!next.customer) return (error.value = 'Customer is required');
  orders.value = [...orders.value, next];
  message.value = `Added order ${next.id} for ${next.customer}`;
  error.value = '';
  customer.value = '';
  quantity.value = 1;
  tab.value = 'orders';
}
function view(id) {
  viewing.value = id;
  open.value = true;
}
function ship() {
  orders.value = orders.value.map((item) => (item.id === viewing.value ? { ...item, status: 'shipped' } : item));
  message.value = `Order ${viewing.value} shipped`;
  open.value = false;
}
</script>

<template>
  <main>
    <h1>Order desk</h1>
    <Tabs label="Sections" :tabs="TABS" :selected="tab" @selectedchange="tab = $event.detail" />
    <div role="tabpanel" aria-label="Orders" :hidden="tab !== 'orders'">
      <p data-testid="summary">{{ orders.length }} orders, {{ shipped }} shipped</p>
      <DataTable caption="Orders" :columns="COLUMNS" :rows="orders" @rowselect="view($event.detail)" />
    </div>
    <div role="tabpanel" aria-label="New order" :hidden="tab !== 'new'">
      <form ref="form" novalidate @submit.prevent="add">
        <Field label="Customer" name="customer" :required="true" v-model="customer" :error="error" />
        <Quantity label="Quantity" name="quantity" :min="1" :max="10" v-model="quantity" />
        <p data-testid="total">Total: {{ money(quantity * PRICE) }}</p>
        <button type="submit">Add order</button>
      </form>
    </div>
    <Dialog :heading="order ? `Order ${order.id}` : ''" :open="open" @openchange="open = $event.detail">
      <div v-if="order">
        <p data-testid="detail">{{ order.customer }}: {{ order.quantity }} × Trail mug, {{ money(order.total) }}</p>
        <p><Badge :status="order.status" /></p>
        <button type="button" :disabled="order.status !== 'pending'" @click="ship">Mark shipped</button>
      </div>
    </Dialog>
    <p role="status">{{ message }}</p>
  </main>
</template>
