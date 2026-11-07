<script>
  import { untrack } from 'svelte';
  import './components/flip-card.mnx';
  import './components/grade-buttons.mnx';
  import './components/progress-ring.mnx';
  import { load, save, graded, today, seed } from './decks.js';

  const initial = load();
  let decks = $state(initial);
  $effect(() => save($state.snapshot(decks)));

  let deckId = $state(initial[0].id);
  let view = $state('study'); // 'study' | 'cards'
  const deck = $derived(decks.find((d) => d.id === deckId) ?? decks[0]);
  const due = $derived(deck.cards.filter((card) => card.due <= today()));
  const mastered = $derived(deck.cards.filter((card) => card.box >= 4).length);
  const boxes = $derived([1, 2, 3, 4, 5].map((box) => deck.cards.filter((card) => card.box === box).length));

  // The session: a queue of card ids, worked through front to back. Again puts a card at the end.
  let queue = $state([]);
  let flipped = $state(false);
  let tally = $state([0, 0, 0, 0]);
  let cramming = $state(false);
  const current = $derived(deck.cards.find((card) => card.id === queue[0]));

  function start(cards = due) {
    queue = cards.map((card) => card.id);
    tally = [0, 0, 0, 0];
    flipped = false;
  }
  $effect(() => {
    // A new deck starts a new session (and only that: grading changes `due`, untracked here).
    deckId;
    untrack(() => {
      cramming = false;
      start($state.snapshot(due));
    });
  });

  function grade(value) {
    if (!current || !flipped) return;
    const card = current;
    const next = graded(card, value);
    deck.cards = deck.cards.map((item) => (item.id === card.id ? next : item));
    tally[value]++;
    queue = value === 0 ? [...queue.slice(1), card.id] : queue.slice(1);
    flipped = false;
  }
  function cram() {
    cramming = true;
    start(deck.cards);
  }

  // Managing cards.
  let front = $state('');
  let back = $state('');
  function add(event) {
    event.preventDefault();
    deck.cards.push({ id: `${deck.id}-${Date.now().toString(36)}`, front: front.trim(), back: back.trim(), box: 1, due: 0 });
    front = '';
    back = '';
  }
  function remove(id) {
    deck.cards = deck.cards.filter((card) => card.id !== id);
    queue = queue.filter((item) => item !== id);
  }
  function resetProgress() {
    deck.cards = deck.cards.map((card) => ({ ...card, box: 1, due: 0 }));
    start(deck.cards);
  }
  function resetAll() {
    decks = seed();
    deckId = decks[0].id;
  }
</script>

<div class="app">
  <aside>
    <h1>Flash<b>cards</b></h1>
    <nav aria-label="Decks">
      {#each decks as d (d.id)}
        <button type="button" class:on={d.id === deckId} data-deck={d.id} onclick={() => (deckId = d.id)}>
          <span>{d.name}</span>
          <small>{d.cards.filter((card) => card.due <= today()).length} due</small>
        </button>
      {/each}
    </nav>
    <section class="stats" aria-label="Progress">
      <progress-ring value={mastered} max={deck.cards.length} label="Mastered">
        <strong class="mastered">{mastered}/{deck.cards.length}</strong><small>mastered</small>
      </progress-ring>
      <ol class="boxes" aria-label="Cards per box">
        {#each boxes as count, index}
          <li><span class="bar" style:height="{deck.cards.length ? (count / deck.cards.length) * 100 : 0}%"></span><b>{count}</b><small>Box {index + 1}</small></li>
        {/each}
      </ol>
    </section>
    <button type="button" class="link" onclick={resetAll}>Reset everything</button>
  </aside>

  <main>
    <header>
      <h2>{deck.name}</h2>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'study'} onclick={() => (view = 'study')}>Study</button>
        <button type="button" role="tab" aria-selected={view === 'cards'} onclick={() => (view = 'cards')}>Cards ({deck.cards.length})</button>
      </div>
    </header>

    {#if view === 'study'}
      {#if current}
        <p class="remaining">{queue.length} to go{cramming ? ' · reviewing everything' : ''}</p>
        {#key current.id}
          <flip-card {flipped} onflippedchange={(event) => (flipped = event.detail)}>
            <div slot="front" class="side"><small>Question</small><p class="front-text">{current.front}</p></div>
            <div slot="back" class="side"><small>Answer</small><p class="back-text">{current.back}</p></div>
          </flip-card>
        {/key}
        <grade-buttons disabled={!flipped} ongrade={(event) => grade(event.detail)}></grade-buttons>
        <p class="tip">{flipped ? 'How well did you know it? (1–4)' : 'Recall the answer, then flip the card.'}</p>
      {:else}
        <div class="done">
          <h3>{tally.some(Boolean) ? 'Session complete' : 'Nothing due'}</h3>
          {#if tally.some(Boolean)}
            <p class="tally">Again {tally[0]} · Hard {tally[1]} · Good {tally[2]} · Easy {tally[3]}</p>
          {:else}
            <p>Every card in this deck is scheduled for later.</p>
          {/if}
          <button type="button" class="primary cram" onclick={cram}>Review all {deck.cards.length} anyway</button>
        </div>
      {/if}
    {:else}
      <form class="add" onsubmit={add}>
        <input required placeholder="Front" aria-label="Front" bind:value={front} />
        <input required placeholder="Back" aria-label="Back" bind:value={back} />
        <button type="submit" class="primary">Add card</button>
      </form>
      <table>
        <thead><tr><th>Front</th><th>Back</th><th>Box</th><th></th></tr></thead>
        <tbody>
          {#each deck.cards as card (card.id)}
            <tr>
              <td>{card.front}</td>
              <td>{card.back}</td>
              <td><span class="box">{card.box}</span></td>
              <td><button type="button" class="remove" aria-label="Delete {card.front}" onclick={() => remove(card.id)}>×</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
      <button type="button" class="link reset-progress" onclick={resetProgress}>Reset this deck's progress</button>
    {/if}
  </main>
</div>

<style>
  .app { display: grid; grid-template-columns: 17rem 1fr; min-height: 100vh; }
  aside { display: flex; flex-direction: column; gap: 1.25rem; padding: 1.5rem 1.25rem; background: var(--sidebar); border-right: 1px solid var(--line); }
  h1 { margin: 0; font-size: 1.375rem; font-weight: 400; }
  h1 b { font-weight: 800; color: var(--accent); }
  nav { display: grid; gap: 0.25rem; }
  nav button { display: flex; justify-content: space-between; align-items: baseline; padding: 0.55rem 0.7rem; border: 0; border-radius: 0.6rem; background: none; text-align: left; }
  nav button.on { background: var(--surface); box-shadow: 0 1px 2px #0002; }
  nav small { color: var(--muted); }
  .stats { display: grid; justify-items: center; gap: 1rem; padding: 1rem; border-radius: 1rem; background: var(--surface); }
  .stats small { display: block; color: var(--muted); font-size: 0.75rem; }
  .mastered { font-size: 1.15rem; }
  .boxes { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.35rem; width: 100%; margin: 0; padding: 0; list-style: none; }
  .boxes li { display: grid; justify-items: center; grid-template-rows: 3.5rem auto auto; align-items: end; font-size: 0.75rem; }
  .bar { width: 100%; min-height: 2px; border-radius: 0.3rem 0.3rem 0 0; background: var(--accent); opacity: 0.75; }
  .link { align-self: flex-start; border: 0; background: none; padding: 0; color: var(--muted); text-decoration: underline; font-size: 0.8125rem; }
  main { padding: 1.5rem 2rem 3rem; max-width: 46rem; width: 100%; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1.25rem; }
  h2 { margin: 0; font-size: 1.5rem; }
  .tabs { display: flex; gap: 0.25rem; padding: 0.2rem; border-radius: 0.7rem; background: var(--sidebar); }
  .tabs button { border: 0; background: none; padding: 0.35rem 0.8rem; border-radius: 0.5rem; color: var(--muted); }
  .tabs button[aria-selected='true'] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px #0002; }
  .remaining { margin: 0 0 0.75rem; color: var(--muted); font-size: 0.875rem; }
  .side small { display: block; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; color: var(--muted); }
  .side p { margin: 0.5rem 0 0; font-size: 1.6rem; font-weight: 700; line-height: 1.3; }
  grade-buttons { margin-top: 1rem; }
  .tip { color: var(--muted); font-size: 0.875rem; text-align: center; }
  .done { display: grid; justify-items: center; gap: 0.25rem; padding: 3rem 1rem; border-radius: 1.25rem; background: var(--surface); text-align: center; }
  .done h3 { margin: 0; font-size: 1.375rem; }
  .add { display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.5rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 1rem; overflow: hidden; }
  th { text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 0.6rem 0.8rem; }
  td { padding: 0.55rem 0.8rem; border-top: 1px solid var(--line); }
  .box { display: inline-grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--sidebar); font-weight: 700; font-size: 0.8125rem; }
  .remove { border: 0; background: none; color: var(--muted); font-size: 1.1rem; padding: 0 0.4rem; }
  .reset-progress { margin-top: 1rem; }
  @media (max-width: 48rem) { .app { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--line); } main { padding: 1.25rem; } }
</style>
