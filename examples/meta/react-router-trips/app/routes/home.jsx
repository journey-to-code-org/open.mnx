// The trip: who paid for what, who's up and down, and a form to add an expense. The loader and
// action run on the server; <Form> posts without a page load once JavaScript is running.
import { useEffect, useRef, useState } from 'react';
import { data, Form, useFetcher, useNavigation } from 'react-router';
import BalanceList from '../../zubra/balance-list.zb';
import MoneyInput from '../../zubra/money-input.zb';
import SegmentedControl from '../../zubra/segmented-control.zb';
import { add, balances, CATEGORIES, list, PEOPLE, remove } from '../lib/trip.server.js';

export const meta = () => [{ title: 'Trip budget' }];

export function loader() {
  return { expenses: list(), balances: balances(), people: PEOPLE, categories: CATEGORIES };
}

export async function action({ request }) {
  const form = await request.formData();
  if (form.get('intent') === 'delete') {
    remove(Number(form.get('id')));
    return { ok: true };
  }
  const expense = {
    what: String(form.get('what') ?? '').trim(),
    category: String(form.get('category') ?? ''),
    cents: Math.round(Number(form.get('amount')) * 100),
    paidBy: String(form.get('paidBy') ?? ''),
    split: form.getAll('split').map(String).filter((name) => PEOPLE.includes(name)),
  };
  const errors = {};
  if (!expense.what) errors.what = 'What was it for?';
  if (!(expense.cents > 0)) errors.amount = 'An amount above $0.';
  if (!CATEGORIES.includes(expense.category)) errors.category = 'Pick a category.';
  if (!PEOPLE.includes(expense.paidBy)) errors.paidBy = 'Who paid?';
  if (!expense.split.length) errors.split = 'Split it with at least one person.';
  if (Object.keys(errors).length) return data({ errors }, { status: 400 });
  add(expense);
  return { ok: true };
}

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

export default function Home({ loaderData, actionData }) {
  const { expenses, balances, people, categories } = loaderData;
  const navigation = useNavigation();
  const form = useRef(null);
  const [category, setCategory] = useState('food');
  const [amount, setAmount] = useState(null);
  const errors = actionData?.errors ?? {};
  const total = expenses.reduce((sum, expense) => sum + expense.cents, 0);

  // A saved expense clears the form.
  useEffect(() => {
    if (actionData?.ok && navigation.state === 'idle') {
      form.current?.reset();
      setAmount(null);
    }
  }, [actionData, navigation.state]);

  return (
    <main>
      <h1>Trip budget</h1>
      <p className="lede">{expenses.length} expenses, {money(total)} in all.</p>
      <section>
        <h2>Balances</h2>
        <BalanceList balances={balances} />
      </section>
      <section>
        <h2>Expenses</h2>
        <ul className="expenses">
          {expenses.map((expense) => <Expense key={expense.id} expense={expense} />)}
        </ul>
      </section>
      <section>
        <h2>Add an expense</h2>
        <Form method="post" ref={form} className="add" noValidate>
          <label>What <input name="what" required /></label>
          {errors.what && <p className="error">{errors.what}</p>}
          <MoneyInput name="amount" label="Amount" required value={amount} onValueChange={(event) => setAmount(event.detail)} />
          {errors.amount && <p className="error">{errors.amount}</p>}
          <SegmentedControl name="category" label="Category" value={category} onValueChange={(event) => setCategory(event.detail)} options={categories.map((value) => ({ value, label: value }))} />
          <label>Paid by
            <select name="paidBy" defaultValue={people[0]}>{people.map((name) => <option key={name}>{name}</option>)}</select>
          </label>
          <fieldset>
            <legend>Split between</legend>
            {people.map((name) => <label key={name}><input type="checkbox" name="split" value={name} defaultChecked /> {name}</label>)}
          </fieldset>
          {errors.split && <p className="error">{errors.split}</p>}
          <button disabled={navigation.state !== 'idle'}>{navigation.state === 'submitting' ? 'Adding…' : 'Add expense'}</button>
        </Form>
      </section>
    </main>
  );
}

function Expense({ expense }) {
  const fetcher = useFetcher();
  return (
    <li hidden={fetcher.state !== 'idle'}>
      <span className="what">{expense.what} <small>{expense.category}</small></span>
      <span>{expense.paidBy} paid {money(expense.cents)}, split {expense.split.length} ways</span>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="id" value={expense.id} />
        <button aria-label={`Delete ${expense.what}`}>✕</button>
      </fetcher.Form>
    </li>
  );
}
