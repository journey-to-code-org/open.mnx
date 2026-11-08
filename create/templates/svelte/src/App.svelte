<script>
  // Svelte uses the element directly: props are set as properties, on<name> listens.
  import './components/hello-counter.zb';

  let count = $state(0);
</script>

<main>
  <h1>{{title}}</h1>
  <hello-counter {count} oncountchange={(event) => (count = event.detail)} label="Clicks"></hello-counter>
  <p>Svelte sees <span id="seen">{count}</span></p>
</main>
