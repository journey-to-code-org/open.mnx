<script>
  import '../components/rating.zb';
  import '../components/card.zb';
  import '../components/badge.zb';

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

<zb-rating value={stars} onvaluechange={(event) => (stars = event.detail)} onchange={() => log.push('change')}></zb-rating>
<p id="stars">{stars}</p>
<zb-card heading="Svelte">
  {#if title}<h2 slot="title">Custom</h2>{/if}
  {#each items as item (item)}<p>{item}</p>{/each}
</zb-card>
<zb-badge label="x" info={info}></zb-badge>
<p id="log">{log.join(',')}</p>
