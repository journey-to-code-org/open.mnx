# Focus: an Electron app

A desktop focus timer (25-minute sessions and breaks) in Electron. The window shows:
- the mode (the registry's `segmented-control`);
- the timer (`focus-timer`, built on the registry's `progress-ring`);
- what you're working on;
- today's log (`session-log`).

Finished sessions are saved as JSON in your user data folder, and each one ends with a desktop
notification.

```sh
cargo build                 # from the repository root (the compiler, until @mnx/compiler is on npm)
cd examples/desktop/focus-timer
npm install
npm start
```

The renderer is locked down the way Electron recommends:
- `contextIsolation`, `sandbox` and no Node.js;
- a preload (`preload.cjs`) that exposes three calls and nothing else;
- a Content Security Policy that allows only the app's own files:
  `script-src 'self'; style-src 'self'`, with no inline scripts, `eval` or inline styles.

The renderer is built with esbuild and mnx's esbuild plugin (`build.mjs`). The tests drive the
app through Playwright's Electron support, with a fake clock so 25 minutes take no time.

## What it found

- **mnx works under a strict CSP as it is.** Components' CSS is adopted as constructed
  stylesheets, which `style-src 'self'` doesn't block (it blocks `<style>` and `style=""`), and
  nothing is `eval`ed. A test checks the styles apply and the console has no violations.
- **`window.focus` is taken.** The first name for the preload's API was `focus`, which is
  `window.focus()`, so `contextBridge` refused it. (Not an mnx problem, but worth knowing in an
  app called Focus.)
- **A prop that seeds state needs an effect to follow changes.** `let left = seconds` reads
  `seconds` once. When the app switches modes, the timer has to notice the new length with an
  `effect()`. That's the same pattern `mnx convert` produces for React's
  `useState(prop)` + `useEffect`, and it suggests sugar such as a `let` that resets when a prop
  changes.
- **The renderer's `document.title` isn't the window's title.** Tests read the window's title
  from the main process.
