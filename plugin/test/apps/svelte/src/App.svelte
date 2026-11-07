<script>
  import '../components/rating.mnx';
  import '../components/card.mnx';
  import '../components/badge.mnx';

  let stars = $state(1);
  let items = $state(['a', 'b']);
  let title = $state(true);
  let info = $state({ color: 'red' });
  let log = $state([]);
  window.app = {
    setItems: (next) => (items = next),
    setTitle: (next) => (title = next),
    setInfo: (next) => (info = next),
  };
</script>

<mnx-rating value={stars} onvaluechange={(event) => (stars = event.detail)} onchange={() => log.push('change')}></mnx-rating>
<p id="stars">{stars}</p>
<mnx-card heading="Svelte">
  {#if title}<h2 slot="title">Custom</h2>{/if}
  {#each items as item (item)}<p>{item}</p>{/each}
</mnx-card>
<mnx-badge label="x" info={info}></mnx-badge>
<p id="log">{log.join(',')}</p>
