import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { App } from './App';
import { kinds } from './kinds';

const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<App />));
Object.assign(window, { kinds, ready: true });
