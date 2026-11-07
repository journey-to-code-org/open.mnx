// The signed-in user, shared through the Web Components context protocol: Lit's ContextProvider
// provides it, and mnx components read it with inject(). One key, two libraries.
import { createContext } from '@lit/context';

export const userContext = createContext(Symbol('user'));
