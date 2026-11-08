# Migrating to 3.0

3.0 changes one thing in `.zb` scripts, and drops the CLI's 1.x name. JSX components (`.zb.jsx`/`.zb.tsx`) need nothing. Compiled code is unchanged: components built with 2.x (libraries from `zubra build --lib`, registry copies) run on the 3.0 runtime without a rebuild.

Run this once, on your 2.x code, before you compile it with 3.0:

```sh
zubra migrate src/**/*.zb --to 3 --check    # each place that would change (exit status 1 if any)
zubra migrate src/**/*.zb --to 3            # rewrite in place
```

Running it on code already written for 3.0 would wrap names that are meant as values. So run it once, at the upgrade.

## 1. A signal `const` means its value in the script

In 2.x, a `const` holding a signal (from `state()`, `computed()`, `inject()`, `hasSlot()` or `hydrated()`) meant its value in the template but the signal in the script, so the script called `.get()`. Since 3.0 it means its value in both:

```html
<script>
  import { state, computed } from '@zubra/runtime'
  const count = state(0)
  const doubled = count * 2            // derived from the value: stays in sync
  function log() { console.log(count) }  // the number
</script>
```

What stays the same:
- **`count.get()` and `count.set(…)` written out keep working**, so code that already called them needs no change.
- **`signal(count)` is the signal itself.** It's the identity function from `@zubra/runtime` (since 2.6), and the compiler leaves its argument alone.

What changes meaning is 2.x code that passed the signal itself: `watch(count, …)`, `formValue(count)`, `provide(theme, current)`, or a helper you wrote that takes a signal. In 3.0 those receive the value. `zubra migrate --to 3` wraps each in `signal(…)` and adds `signal` to the `@zubra/runtime` import. `signal(count)` means the signal in 2.x too, so the migrated code also compiles with 2.x.

2.6 to 2.11 warned at each such place. In this repository, the rewrite touched two runtime test fixtures and nothing else.

## 2. The CLI's 1.x name, `mnix`, is gone

Use `zubra`. `@zubra/unplugin` and the language server no longer look for `mnix` on `PATH`.

## Unchanged

- The `.zb` and JSX formats otherwise, the CLI's other commands and options, and the runtime's documented exports.
- The compiled-code interface (`abi: 2`). A library built with 2.x (`zubra build --lib`) runs on the 3.0 runtime, but its `package.json` declares `@zubra/runtime` `^2.x` as a peer, so npm reports a peer conflict next to 3.0. Rebuild it with 3.0 (its peer becomes `^3.0.0`), or tell npm with `overrides`.
- The hydration markers, and `<zb-each>` as the way to write lists (`plan/decisions/3.0-scope.md`).
- Browser support: the target moves to Baseline 2026 (`docs/browser-support.md`), and no fallback is dropped yet.
