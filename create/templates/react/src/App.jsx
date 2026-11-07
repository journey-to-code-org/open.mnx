import { useState } from 'react';
// Imported into React, a component is a React component (typed, with onCountChange).
import HelloCounter from './components/hello-counter.mnx';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>{{title}}</h1>
      <HelloCounter count={count} onCountChange={(event) => setCount(event.detail)} label="Clicks" />
      <p>React sees <span id="seen">{count}</span></p>
    </main>
  );
}
