// The currency, shared through the Web Components context protocol: FAST's Context provides it, and
// zubra components read it with inject(). One key, two libraries.
import { Context } from '@microsoft/fast-element/context.js';

export const currency = Context.create('currency', 'USD');
