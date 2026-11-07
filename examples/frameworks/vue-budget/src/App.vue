<script setup>
import { computed, reactive, ref, watch } from 'vue';
import MoneyInput from './components/money-input.mnx';
import SegmentedControl from './components/segmented-control.mnx';
import DonutChart from './components/donut-chart.mnx';
import BudgetBar from './components/budget-bar.mnx';
import { CATEGORIES, INCOME, load, save, monthOf, shiftMonth, money } from './data.js';

const state = reactive(load());
watch(state, () => save(state), { deep: true });

const month = ref(monthOf(new Date()));
const monthName = computed(() => new Date(`${month.value}-01T12:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
const inMonth = computed(() => state.transactions.filter((t) => t.date.startsWith(month.value)));
const income = computed(() => inMonth.value.filter((t) => t.kind === 'income').reduce((sum, t) => sum + t.amount, 0));
const spent = computed(() => inMonth.value.filter((t) => t.kind === 'expense').reduce((sum, t) => sum + t.amount, 0));

const byCategory = computed(() =>
  CATEGORIES.map((category) => ({
    ...category,
    limit: state.limits[category.name] ?? 0,
    spent: inMonth.value.filter((t) => t.kind === 'expense' && t.category === category.name).reduce((sum, t) => sum + t.amount, 0),
  })),
);
const segments = computed(() => byCategory.value.filter((c) => c.spent > 0).map((c) => ({ label: c.name, value: Math.round(c.spent * 100) / 100, tone: c.tone })));

// Filters: the donut's selection and the kind, both v-model on mnx elements.
const selected = ref('');
const kind = ref('all');
const kinds = [{ value: 'all', label: 'All' }, { value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }];
watch(month, () => (selected.value = ''));

const shown = computed(() =>
  inMonth.value
    .filter((t) => (kind.value === 'all' || t.kind === kind.value) && (!selected.value || t.category === selected.value))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
);
const days = computed(() => {
  const groups = new Map();
  for (const t of shown.value) groups.set(t.date, [...(groups.get(t.date) ?? []), t]);
  return [...groups].map(([date, items]) => ({ date, items, label: new Date(`${date}T12:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) }));
});

// The add form.
const today = () => new Date().toISOString().slice(0, 10);
const blank = () => ({ kind: 'expense', amount: null, category: 'Groceries', date: today(), note: '' });
const draft = reactive(blank());
watch(() => draft.kind, (next) => (draft.category = next === 'income' ? INCOME[0] : 'Groceries'));
const form = ref(null);

function add() {
  if (!form.value.reportValidity()) return;
  state.transactions.push({ ...draft, id: `t${Date.now().toString(36)}`, note: draft.note.trim() || draft.category });
  Object.assign(draft, { ...blank(), kind: draft.kind, category: draft.category, date: draft.date });
  month.value = draft.date.slice(0, 7);
}
function remove(id) {
  state.transactions = state.transactions.filter((t) => t.id !== id);
}
const toneOf = (t) => (t.kind === 'income' ? 'income' : `t${CATEGORIES.find((c) => c.name === t.category)?.tone ?? 7}`);
</script>

<template>
  <header class="top">
    <h1>Pocket <b>budget</b></h1>
    <nav class="months" aria-label="Month">
      <button type="button" class="prev" aria-label="Previous month" @click="month = shiftMonth(month, -1)">‹</button>
      <strong class="month">{{ monthName }}</strong>
      <button type="button" class="next" aria-label="Next month" @click="month = shiftMonth(month, 1)">›</button>
    </nav>
  </header>

  <section class="totals">
    <div><span>Income</span><b class="income">{{ money(income) }}</b></div>
    <div><span>Spent</span><b class="spent">{{ money(spent) }}</b></div>
    <div><span>Left</span><b class="left" :class="{ negative: income - spent < 0 }">{{ money(income - spent) }}</b></div>
  </section>

  <div class="grid">
    <section class="panel chart">
      <h2>Where it went</h2>
      <DonutChart v-if="segments.length" v-model="selected" :segments="segments" label="Spending by category">
        <span class="middle-label">{{ selected || 'Spent' }}</span>
        <strong class="middle-total">{{ money(selected ? segments.find((s) => s.label === selected)?.value ?? 0 : spent) }}</strong>
      </DonutChart>
      <p v-else class="empty">No spending this month.</p>
    </section>

    <section class="panel budgets">
      <h2>Budgets</h2>
      <BudgetBar v-for="c in byCategory" :key="c.name" :data-category="c.name" :label="c.name" :spent="c.spent" :limit="c.limit" />
      <details>
        <summary>Change limits</summary>
        <div class="limits">
          <label v-for="c in CATEGORIES" :key="c.name">
            <span>{{ c.name }}</span>
            <MoneyInput v-model="state.limits[c.name]" :label="`${c.name} limit`" />
          </label>
        </div>
      </details>
    </section>

    <section class="panel add">
      <h2>Add</h2>
      <form ref="form" @submit.prevent="add" novalidate>
        <SegmentedControl v-model="draft.kind" :options="[{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }]" label="Kind" />
        <MoneyInput v-model="draft.amount" name="amount" :required="true" :min="0.01" label="Amount" />
        <select v-model="draft.category" aria-label="Category">
          <option v-for="name in draft.kind === 'income' ? INCOME : CATEGORIES.map((c) => c.name)" :key="name">{{ name }}</option>
        </select>
        <input v-model="draft.date" type="date" required aria-label="Date" />
        <input v-model="draft.note" placeholder="Note (optional)" aria-label="Note" />
        <button type="submit" class="primary">Add {{ draft.kind }}</button>
      </form>
    </section>

    <section class="panel list">
      <div class="list-head">
        <h2>Transactions</h2>
        <SegmentedControl v-model="kind" :options="kinds" label="Show" />
      </div>
      <p v-if="selected" class="filter">Only {{ selected }} <button type="button" class="clear" @click="selected = ''">Show all</button></p>
      <p v-if="!days.length" class="empty">Nothing here.</p>
      <div v-for="day in days" :key="day.date" class="day">
        <h3>{{ day.label }}</h3>
        <ul>
          <li v-for="t in day.items" :key="t.id" :data-id="t.id">
            <span class="dot" :class="toneOf(t)"></span>
            <span class="what"><b>{{ t.note }}</b><small>{{ t.category }}</small></span>
            <span class="amount" :class="t.kind">{{ t.kind === 'income' ? '+' : '−' }}{{ money(t.amount) }}</span>
            <button type="button" class="remove" :aria-label="`Delete ${t.note}`" @click="remove(t.id)">×</button>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
h1 { margin: 0; font-size: 1.5rem; font-weight: 400; letter-spacing: -0.02em; }
h1 b { font-weight: 800; color: var(--accent); }
.months { display: flex; align-items: center; gap: 0.5rem; }
.months strong { min-width: 9.5rem; text-align: center; }
.totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-bottom: 1rem; }
.totals div { display: grid; padding: 0.9rem 1.1rem; border-radius: 1rem; background: var(--surface); box-shadow: var(--shadow); }
.totals span { font-size: 0.8125rem; color: var(--muted); }
.totals b { font-size: 1.5rem; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.totals .income { color: var(--ok); }
.totals .negative { color: var(--danger); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-areas: "chart budgets" "add budgets" "list list"; gap: 1rem; align-items: start; }
.chart { grid-area: chart; } .budgets { grid-area: budgets; } .add { grid-area: add; } .list { grid-area: list; }
@media (max-width: 52rem) { .grid { grid-template-columns: 1fr; grid-template-areas: "chart" "budgets" "add" "list"; } .totals b { font-size: 1.15rem; } }
.panel { padding: 1.1rem 1.2rem; border-radius: 1rem; background: var(--surface); box-shadow: var(--shadow); }
h2 { margin: 0 0 0.9rem; font-size: 1rem; }
.middle-label { display: block; font-size: 0.75rem; color: var(--muted); }
.middle-total { font-size: 1rem; }
.budgets { display: grid; gap: 0.7rem; }
.budgets h2 { margin: 0; }
details summary { cursor: pointer; color: var(--accent); font-weight: 600; font-size: 0.875rem; }
.limits { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: 0.6rem; margin-top: 0.75rem; }
.limits label { display: grid; gap: 0.25rem; font-size: 0.8125rem; color: var(--muted); }
.add form { display: grid; gap: 0.6rem; }
.list-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
.list-head h2 { margin: 0; }
.filter { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; color: var(--muted); }
.clear { padding: 0.2rem 0.5rem; font-size: 0.8125rem; }
.day h3 { margin: 0.9rem 0 0.3rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
ul { margin: 0; padding: 0; list-style: none; }
li { display: grid; grid-template-columns: 0.6rem 1fr auto auto; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-top: 1px solid var(--line); }
.what { display: grid; }
.what small { color: var(--muted); }
.dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: #64748b; }
.dot.income { background: var(--ok); }
.dot.t0 { background: #4f46e5; } .dot.t1 { background: #0891b2; } .dot.t2 { background: #16a34a; } .dot.t3 { background: #ca8a04; }
.dot.t4 { background: #ea580c; } .dot.t5 { background: #db2777; } .dot.t6 { background: #7c3aed; }
.amount { font-weight: 700; font-variant-numeric: tabular-nums; }
.amount.income { color: var(--ok); }
.remove { padding: 0 0.45rem; border: 0; background: none; color: var(--muted); font-size: 1.1rem; }
.remove:hover { color: var(--danger); }
.empty { color: var(--muted); }
</style>
