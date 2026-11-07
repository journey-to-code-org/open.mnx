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
| `Element.moveBefore()` (Chromium) | Keyed list moves that keep focus and iframe state | Used where present; otherwise rows move with `insertBefore` |
| TC39 Signals (not shipped anywhere yet) | Reactivity | The runtime's own implementation (`runtime/src/signal-impl.js`) |

The policy for 3.0 and later: a major version moves the target to the Baseline year before its release, and drops fallbacks for features that are Widely available by then.

The browser suites run in Chromium. The features above are standard, but other engines aren't tested in CI yet.
