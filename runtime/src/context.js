// Context from the app: a `<zb-context>` element that answers the Context Protocol for the
// elements inside it, so an app's theme, locale or current user reaches every component without
// being passed down as props.
//
//   <zb-context .context=${theme} .value=${'dark'}>   …elements that inject(theme)…   </zb-context>
//
// It's a plain custom element with two properties, so every framework can use it as it is:
// Svelte `<zb-context {context} {value}>`, Solid `prop:context`, Angular `[context]`, Lit
// `.context`, plain HTML `el.value = …`. React and Vue have `ZubraContext` components
// (`@zubra/runtime/react`, `@zubra/runtime/vue`) that wrap it. The element is `display:
// contents`, so it adds no box to the layout.
//
// The value can be a plain value or a signal; subscribers hear each change either way. Any
// Context Protocol consumer is answered: Zubra's `inject()`, Lit's `@consume`, and so on. A
// consumer that asked before the element was given its context asks again when the element
// announces it with a `context-provider` event (children connect after their parent, so one
// given its context before it's in the document is there when they first ask).
//
// The element is in `context-element.js`; importing this module defines it.
import { defineContextElement } from './context-element.js';

export * from './context-element.js';

defineContextElement();
