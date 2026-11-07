# Browser support

mnx 2.0 targets browsers with **Baseline 2025** features: everything Baseline Widely available, plus the features below, which became Baseline (newly available) by the end of 2025. When a newer feature is used, it's used only where the browser has it.

| Feature | Used for | Without it |
|---|---|---|
| Custom elements, shadow DOM, `<template>`, ES modules | Everything | Not supported |
| Declarative shadow DOM (`<template shadowrootmode>`) | Server-rendered shadow components | Not supported |
| `ElementInternals` (form-associated custom elements) | `form-associated` components | Not supported |
| Constructed stylesheets (`adoptedStyleSheets`) | Shadow component styles, `adoptStyles()` | Not supported |
| CSS `@scope` (Baseline since December 2025) | Light-DOM component styles stopping at slotted content | A light-DOM component's `<style>` doesn't apply; shadow components are unaffected |
| CSS cascade layers | Putting component styles under utilities and page CSS | Not supported |
| `Element.moveBefore()` (Chromium, Firefox; not Safari) | Keyed list moves that keep focus and iframe state | Used where present; otherwise rows move with `insertBefore` |
| TC39 Signals (not shipped anywhere yet) | Reactivity | The runtime's own implementation (`runtime/src/signal-impl.js`) |

The policy for 3.0 and later: a major version moves the target to the Baseline year before its release, and drops fallbacks for features that are Widely available by then.

The browser suites run in Chromium. Since 2.9, CI also runs the runtime's browser suite and the React and Vue example apps in Firefox and WebKit (Safari's engine), through Playwright. The counting of live objects in the leak suite needs Chromium's DevTools protocol, so it runs in Chromium only.

Known engine issues:
- **Firefox before 159** can apply a light-DOM component's `<style>` to content slotted into it, when that content sits beside the component's own elements of the same kind. Firefox shares styles between siblings that differ only in an attribute an `@scope` rule depends on ([bug 2075194](https://bugzilla.mozilla.org/show_bug.cgi?id=2075194), fixed in 159). Shadow components are unaffected.
- **Firefox** logs "The invalid form control … is not focusable" when a form with an invalid mnx control won't submit. It's only a message: Firefox does focus the input inside (the validation anchor), as Chromium and WebKit do, and the form is refused. `form.reportValidity()` logs nothing.
- **WebKit** clears long lists more slowly relative to building them than Chromium does (2,000 rows cleared in about 2.8× the time of creating 1,000). It isn't the quadratic case the benchmark guards against, so the ratio checks run in Chromium only.
