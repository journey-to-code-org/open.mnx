import { render } from 'solid-js/web';
import { createSignal, For, Show } from 'solid-js';
import '../components/rating.zb';
import '../components/card.zb';
import '../components/badge.zb';

function App() {
  const [stars, setStars] = createSignal(1);
  const [items, setItems] = createSignal(['a', 'b']);
  const [title, setTitle] = createSignal(true);
  const [info, setInfo] = createSignal({ color: 'red' });
  const [log, setLog] = createSignal([]);
  Object.assign(window, { app: { setItems, setTitle, setInfo } });
  return (
    <>
      <zb-rating prop:value={stars()} on:valuechange={(event) => setStars(event.detail)} on:change={() => setLog([...log(), 'change'])} />
      <p id="stars">{stars()}</p>
      <zb-card heading="Solid">
        <Show when={title()}><h2 slot="title">Custom</h2></Show>
        <For each={items()}>{(item) => <p>{item}</p>}</For>
      </zb-card>
      <zb-badge label="x" prop:info={info()} />
      <p id="log">{log().join(',')}</p>
    </>
  );
}

render(() => <App />, document.getElementById('root'));
window.ready = true;
