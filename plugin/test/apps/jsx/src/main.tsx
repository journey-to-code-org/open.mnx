import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Counter from './counter.mnx.tsx';
import CounterElement from './counter.mnx.tsx?element';

function App() {
  const [count, setCount] = useState(1);
  return (
    <>
      <Counter id="react" count={count} step={2} onCountChange={(event: CustomEvent<number>) => setCount(event.detail)} />
      <p id="count">{count}</p>
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<App />));
Object.assign(window, { kind: typeof CounterElement === 'function' && CounterElement.mnx.tag, ready: true });
