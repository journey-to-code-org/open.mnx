// The one place compiled mnx code gets reactivity from.
//
// If the platform provides the TC39 Signals API natively, use it. Otherwise fall back to our
// implementation of the same API. Nothing else in the runtime may depend on which one it got,
// so the day browsers ship `Signal`, this file is the only thing that changes behavior.
import { Signal as Implementation } from './signal-impl.js';

export const Signal = globalThis.Signal ?? Implementation;
export const isNative = Signal !== Implementation;
