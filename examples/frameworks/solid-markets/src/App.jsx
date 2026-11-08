import { createMemo, createSignal, For, Show, onCleanup, createEffect } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import './components/price-tile.zb';
import './components/line-chart.zb';
import { HISTORY, SYMBOLS, initialQuotes, money, random, step } from './market.js';

export function App() {
  const next = random(2026);
  const [quotes, setQuotes] = createStore(initialQuotes(next));
  const [watching, setWatching] = createSignal(['NOVA', 'KELP', 'ARCH', 'VOLT']);
  const [selected, setSelected] = createSignal('NOVA');
  const [running, setRunning] = createSignal(true);
  const [speed, setSpeed] = createSignal(1);
  const [ticks, setTicks] = createSignal(0);
  const [hover, setHover] = createSignal(-1);
  const [alerts, setAlerts] = createStore([]);
  const [toasts, setToasts] = createSignal([]);
  const [holdings, setHoldings] = createStore([{ symbol: 'NOVA', shares: 10, cost: 175 }, { symbol: 'VOLT', shares: 120, cost: 22.1 }]);

  const quote = (symbol) => quotes.find((item) => item.symbol === symbol);
  const current = createMemo(() => quote(selected()));

  function tick() {
    setQuotes(produce((list) => {
      for (const item of list) {
        item.price = step(item.price, item, next);
        item.points = [...item.points, item.price].slice(-HISTORY);
      }
    }));
    setTicks((n) => n + 1);
    // Alerts that this tick crossed.
    alerts.forEach((alert, index) => {
      if (alert.fired) return;
      const price = quote(alert.symbol).price;
      if (alert.when === 'above' ? price >= alert.price : price <= alert.price) {
        setAlerts(index, 'fired', true);
        const message = `${alert.symbol} is ${alert.when} ${money(alert.price)} (now ${money(price)})`;
        setToasts((list) => [...list, { id: `${index}-${ticks()}`, message }]);
      }
    });
  }

  createEffect(() => {
    if (!running()) return;
    const timer = setInterval(tick, 1000 / speed());
    onCleanup(() => clearInterval(timer));
  });

  // Watchlist.
  const available = createMemo(() => SYMBOLS.map((info) => info.symbol).filter((symbol) => !watching().includes(symbol)));
  function remove(symbol) {
    setWatching((list) => list.filter((item) => item !== symbol));
    if (selected() === symbol) setSelected(watching()[0] ?? '');
  }

  // Alerts.
  const [when, setWhen] = createSignal('above');
  const [target, setTarget] = createSignal('');
  function addAlert(event) {
    event.preventDefault();
    const price = Number(target());
    if (!current() || !(price > 0)) return;
    setAlerts(alerts.length, { symbol: current().symbol, when: when(), price, fired: false });
    setTarget('');
  }

  // Holdings.
  const rows = createMemo(() => holdings.map((holding) => {
    const price = quote(holding.symbol).price;
    const value = price * holding.shares;
    return { ...holding, price, value, gain: value - holding.cost * holding.shares };
  }));
  const total = createMemo(() => rows().reduce((sum, row) => sum + row.value, 0));
  const gain = createMemo(() => rows().reduce((sum, row) => sum + row.gain, 0));
  function buy(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    const symbol = form.get('symbol');
    const shares = Number(form.get('shares'));
    if (!(shares > 0)) return;
    const price = quote(symbol).price;
    const at = holdings.findIndex((holding) => holding.symbol === symbol);
    if (at === -1) setHoldings(holdings.length, { symbol, shares, cost: price });
    else setHoldings(at, (holding) => ({ shares: holding.shares + shares, cost: (holding.cost * holding.shares + price * shares) / (holding.shares + shares) }));
    event.target.reset();
  }

  return (
    <div class="app">
      <header>
        <h1>mark<b>ets</b></h1>
        <span class={running() ? 'status live' : 'status'}>{running() ? 'Live' : 'Paused'} · tick {ticks()}</span>
        <div class="controls">
          <select aria-label="Speed" value={speed()} onChange={(event) => setSpeed(Number(event.target.value))}>
            <option value="1">1×</option>
            <option value="4">4×</option>
            <option value="10">10×</option>
          </select>
          <button type="button" class="toggle" onClick={() => setRunning(!running())}>{running() ? 'Pause' : 'Resume'}</button>
          <button type="button" class="step" disabled={running()} onClick={tick}>Step</button>
        </div>
      </header>

      <section class="watchlist" aria-label="Watchlist">
        <For each={watching()}>
          {(symbol) => (
            <price-tile
              attr:data-symbol={symbol}
              prop:symbol={symbol}
              prop:name={quote(symbol).name}
              prop:price={quote(symbol).price}
              prop:open={quote(symbol).open}
              prop:points={quote(symbol).points}
              prop:selected={selected() === symbol}
              on:tileselect={() => setSelected(symbol)}
              on:tileremove={() => remove(symbol)}
            />
          )}
        </For>
        <Show when={available().length}>
          <label class="add">
            <span>Watch</span>
            <select aria-label="Add a symbol" onChange={(event) => { setWatching([...watching(), event.target.value]); event.target.value = ''; }}>
              <option value="">Add…</option>
              <For each={available()}>{(symbol) => <option value={symbol}>{symbol}</option>}</For>
            </select>
          </label>
        </Show>
      </section>

      <div class="columns">
        <section class="panel detail">
          <Show when={current()} fallback={<p class="muted">Pick a symbol.</p>}>
            {(item) => (
              <>
                <div class="detail-head">
                  <div><h2>{item().symbol}</h2><span class="muted">{item().name}</span></div>
                  <strong class="big">{money(item().price)}</strong>
                </div>
                <line-chart prop:points={item().points} prop:label={`${item().symbol} price`} on:pointhover={(event) => setHover(event.detail)} />
                <p class="muted hover">{hover() >= 0 ? `${item().points.length - 1 - hover()} ticks ago: ${money(item().points[hover()])}` : `Last ${item().points.length} ticks`}</p>
                <form class="alert-form" onSubmit={addAlert}>
                  <span>Alert me when {item().symbol} goes</span>
                  <select aria-label="Direction" value={when()} onChange={(event) => setWhen(event.target.value)}>
                    <option value="above">above</option>
                    <option value="below">below</option>
                  </select>
                  <input type="number" step="0.01" min="0" required aria-label="Alert price" placeholder={item().price.toFixed(2)} value={target()} onInput={(event) => setTarget(event.target.value)} />
                  <button type="submit">Set alert</button>
                </form>
                <ul class="alerts">
                  <For each={alerts}>
                    {(alert) => <li classList={{ fired: alert.fired }}>{alert.symbol} {alert.when} {money(alert.price)} {alert.fired ? '· triggered' : '· watching'}</li>}
                  </For>
                </ul>
              </>
            )}
          </Show>
        </section>

        <section class="panel portfolio">
          <h2>Portfolio</h2>
          <table>
            <thead><tr><th>Symbol</th><th class="num">Shares</th><th class="num">Value</th><th class="num">Gain</th></tr></thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <tr data-symbol={row.symbol}>
                    <td>{row.symbol}</td>
                    <td class="num">{row.shares}</td>
                    <td class="num value">{money(row.value)}</td>
                    <td class={row.gain >= 0 ? 'num gain up' : 'num gain down'}>{row.gain >= 0 ? '+' : '−'}{money(Math.abs(row.gain))}</td>
                  </tr>
                )}
              </For>
            </tbody>
            <tfoot><tr><td colSpan="2">Total</td><td class="num total">{money(total())}</td><td class={gain() >= 0 ? 'num up' : 'num down'}>{gain() >= 0 ? '+' : '−'}{money(Math.abs(gain()))}</td></tr></tfoot>
          </table>
          <form class="buy" onSubmit={buy}>
            <select name="symbol" aria-label="Symbol">
              <For each={SYMBOLS}>{(info) => <option>{info.symbol}</option>}</For>
            </select>
            <input name="shares" type="number" min="1" step="1" required placeholder="Shares" aria-label="Shares" />
            <button type="submit" class="primary">Buy at market</button>
          </form>
        </section>
      </div>

      <div class="toasts" role="status" aria-live="polite">
        <For each={toasts()}>
          {(toast) => (
            <div class="toast">
              <span>{toast.message}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setToasts((list) => list.filter((item) => item.id !== toast.id))}>×</button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
