import { render } from 'solid-js/web';
import { createSignal, For, Show } from 'solid-js';
import '../components/rating.mnx';
import '../components/card.mnx';
import '../components/badge.mnx';

function App() {
  const [stars, setStars] = createSignal(1);
  const [items, setItems] = createSignal(['a', 'b']);
  const [title, setTitle] = createSignal(true);
  const [info, setInfo] = createSignal({ color: 'red' });
  const [log, setLog] = createSignal([]);
  Object.assign(window, { app: { setItems, setTitle, setInfo } });
  return (
    <>
      <mnx-rating prop:value={stars()} on:valuechange={(event) => setStars(event.detail)} on:change={() => setLog([...log(), 'change'])} />
      <p id="stars">{stars()}</p>
      <mnx-card heading="Solid">
        <Show when={title()}><h2 slot="title">Custom</h2></Show>
        <For each={items()}>{(item) => <p>{item}</p>}</For>
      </mnx-card>
      <mnx-badge label="x" prop:info={info()} />
      <p id="log">{log().join(',')}</p>
    </>
  );
}

render(() => <App />, document.getElementById('root'));
window.ready = true;
