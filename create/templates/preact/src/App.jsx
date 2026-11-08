import { useState } from 'preact/hooks';
// Preact uses the element directly: props are set as properties, on<name> listens.
import './components/hello-counter.zb';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>{{title}}</h1>
      <hello-counter count={count} oncountchange={(event) => setCount(event.detail)} label="Clicks" />
      <p>Preact sees <span id="seen">{count}</span></p>
    </main>
  );
}
