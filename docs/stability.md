# Stability: what may change, and how

Zubra is moving fast on purpose, and this page says so rather than leaving it to the version numbers. It also lists everything the project maintains, with a tier for each, so you can tell what you can build on and what may still go.

## The stage: pre-adoption

Nobody depends on Zubra in production yet, so it follows the platform as soon as the platform moves: a new standard lands, and Zubra uses it in the next release. That has meant majors close together (1.0 to 5.x in its first week; `CHANGELOG.md` has each).

What doesn't change in this stage:

- **Within a major, nothing Stable breaks.** The `.zb` format, the CLI, the runtime's public API and the compiled ABI (see "Contracts") break only in a major.
- **Every change is in `CHANGELOG.md`.** A major's entry says what broke and how to upgrade; a Supported change's entry says what to do.

What this stage leaves out, on purpose: separate migration guides and a `zubra migrate` command. Both existed and were removed in 5.0.x, since there was no one to migrate.

**When this stage ends:** when the first project outside the author's ships on Zubra, or the first issue reports a break in someone else's code, whichever comes first. From then on:

- a Stable change needs a deprecation that warns for at least two minors before the major that makes it;
- every major ships with a migration guide, and with an automatic migration where the change is mechanical;
- this section records the date the stage ended.

## Tiers

| Tier | What it promises |
|---|---|
| **Stable** | Breaks only in a major. |
| **Supported** | Tested in CI on every change, and kept. May change in a minor; the changelog entry says what to do. |
| **Experimental** | May change or go in any release. Use it to try an idea, not to ship. |

Every npm package entry and command below has a tier; `docs/test/stability.test.js` fails when one is added without a row here, or a row names one that no longer exists. "Tested by" names the CI job (`.github/workflows/ci.yml`); "Used by" names an example or app that depends on it, which is the reason it exists.

## Contracts

| Contract | Tier | Notes |
|---|---|---|
| The `.zb` format and `.zb.jsx` / `.zb.tsx` front ends | Stable | The README's rules are the reference |
| The compiled ABI (`abi: 3`) | Stable | The runtime still runs `abi: 2` output |
| CLI commands, flags and exit codes | Stable | Except the commands marked below |
| The Custom Elements Manifest and typings the compiler writes | Stable | |
| Hydration markers (processing instructions) | Stable | The runtime still reads 4.x comment markers |
| The `zubra request` / `zubra serve` JSON protocol | Supported | What the server clients speak |
| The compiler's error and warning text | Supported | Tools should read `--format json` codes, not the prose |

## npm packages

### `@zubra/runtime`

| Entry | Tier | Tested by | Used by |
|---|---|---|---|
| `@zubra/runtime` | Stable | Runtime (unit, browser, tools); engines | Every example |
| `@zubra/runtime/signal` | Stable | Runtime | Examples that share state |
| `@zubra/runtime/effect` | Stable | Runtime | Examples |
| `@zubra/runtime/spread` | Stable | Runtime | Registry, converted React components |
| `@zubra/runtime/zag` | Stable | Runtime; registry | Registry `combo-box` |
| `@zubra/runtime/primitives` | Stable | Runtime; registry | Registry menus, tabs |
| `@zubra/runtime/motion` | Supported | Runtime (both outputs) | Zubra UI motion components |
| `@zubra/runtime/track` | Experimental | Runtime (unit, browser) | Async `resource()` fetchers in `.zb` scripts; nothing outside its tests yet |
| `@zubra/runtime/react` | Stable | Framework and meta-framework examples | React and Next.js examples |
| `@zubra/runtime/vue` | Stable | Framework and meta-framework examples | Vue and Nuxt examples |
| `@zubra/runtime/angular` | Stable | Framework examples | Angular booking |
| `@zubra/runtime/server` | Stable | Runtime; meta-framework examples | Next.js, Nuxt, SvelteKit, SolidStart |
| `@zubra/runtime/bridge` | Supported | Runtime (React 19, 18, Vue 3) | Nothing outside its tests yet |
| `@zubra/runtime/context` | Supported | Runtime (plain HTML, React 19, 18, Vue 3) | Nothing outside its tests yet |
| `@zubra/runtime/forms` | Supported | Runtime (four form libraries) | Nothing outside its tests yet |
| `@zubra/runtime/navigation` | Supported | Runtime (React Router, Vue Router) | Nothing outside its tests yet |
| `@zubra/runtime/testing` | Supported | WebAssembly compiler (`examples/testing-vitest`) | `examples/testing-vitest` |
| `@zubra/runtime/outlet` | Experimental | Runtime (React 19, 18) | Nothing; React only, client only |

### `@zubra/compiler`

| Entry | Tier | Tested by | Used by |
|---|---|---|---|
| `@zubra/compiler` | Stable | WebAssembly compiler; plugin | The bundler plugin, `@zubra/server` |
| `@zubra/compiler/wasm` | Stable | WebAssembly compiler | Edge servers, the playground |
| `@zubra/compiler/zubra.wasm` | Stable | WebAssembly compiler | Same |
| `@zubra/compiler/library` | Stable | Framework examples (`zubra build --lib`) | `examples/frameworks/ui` |
| `@zubra/compiler/embed` | Supported | WebAssembly compiler (`embed.test.js`) | Nothing yet; not tried on a live WordPress site or Shopify store |
| `@zubra/compiler/mcp` | Supported | WebAssembly compiler (`npm test`) | Nothing yet |
| `bin zubra` | Stable | Compiler (Rust) | Everything |

### `@zubra/server`

| Entry | Tier | Tested by | Used by |
|---|---|---|---|
| `@zubra/server` | Stable | Plugin job (`server/`) | Help desk, meta-framework examples |
| `@zubra/server/express` | Stable | Plugin job; server example | Help desk |
| `@zubra/server/fastify` | Stable | Plugin job | Its tests |
| `@zubra/server/hono` | Stable | Plugin job; hypermedia examples | Hono bike shop |
| `@zubra/server/edge` | Supported | WebAssembly compiler (`edge.test.js`); edge jobs | Worker examples |
| `@zubra/server/hono-edge` | Supported | Hono bike shop on a Cloudflare Worker | `examples/edge/hono-bikes-worker` |

### `@zubra/unplugin`

| Entry | Tier | Tested by | Used by |
|---|---|---|---|
| `@zubra/unplugin` | Stable | Plugin job | Every bundled example |
| `@zubra/unplugin/vite` | Stable | Plugin job; framework examples | Most examples |
| `@zubra/unplugin/rollup` | Stable | Plugin job | Its tests |
| `@zubra/unplugin/webpack` | Stable | Plugin job | Its tests |
| `@zubra/unplugin/esbuild` | Stable | Plugin job | Its tests |
| `@zubra/unplugin/loader` | Stable | Meta-framework examples | Next.js conference (Turbopack) |
| `@zubra/unplugin/astro` | Stable | Meta-framework examples; demo gallery | Astro examples |
| `@zubra/unplugin/astro/server` | Stable | Same | Same |
| `@zubra/unplugin/astro/client` | Stable | Same | Same |
| `@zubra/unplugin/client` | Stable | Type declarations only | Vite apps' `.zb` imports |
| `@zubra/unplugin/rspack` | Experimental | **No test** | Nothing. One line over unplugin; promoted when a test builds with Rspack |

### `@zubra/actions`

A sibling: needed only for `'use server'` functions.

| Entry | Tier | Tested by | Used by |
|---|---|---|---|
| `@zubra/actions` | Supported | Plugin job (`actions/`, with and without JavaScript in Chromium) | Standup, Tailgate |
| `@zubra/actions/client` | Supported | Same | Same |
| `@zubra/actions/build` | Supported | Same; Sync and Actions on a Cloudflare Worker | Standup worker |
| `@zubra/actions/edge` | Supported | Sync and Actions on a Cloudflare Worker | Standup worker |
| `@zubra/actions/express` | Supported | Plugin job | Its tests |
| `@zubra/actions/fastify` | Supported | Plugin job | Its tests |
| `@zubra/actions/hono` | Supported | Plugin job | Its tests |
| `bin zubra-actions` | Supported | Sync and Actions on a Cloudflare Worker | Standup worker |

### `@zubra/sync`

A sibling: needed only for `'use collection'` state.

| Entry | Tier | Tested by | Used by |
|---|---|---|---|
| `@zubra/sync` | Supported | Plugin job (`sync/`, and against the `zubra-sync` binary); local-first example | Standup, Tailgate, CineStack |
| `@zubra/sync/connect` | Supported | Same | Same |
| `@zubra/sync/server` | Supported | Same | Same |
| `@zubra/sync/sqlite` | Supported | Same | Standup |
| `@zubra/sync/durable` | Supported | Sync and Actions on a Cloudflare Worker | Standup worker, Tailgate's Worker deploy |

### Tooling packages

| Entry | Tier | Tested by | Used by |
|---|---|---|---|
| `bin create-zubra` | Stable | Framework examples (every template, and the first ten minutes scripted) | `npm create zubra` |
| `@zubra/language-server` | Supported | Editor support | The VS Code extension |
| `@zubra/language-server/analysis` | Supported | Editor support | Same |
| `bin zubra-language-server` | Supported | Editor support | Same |
| `prettier-plugin-zubra` | Supported | Prettier plugin | Projects that format with Prettier |

## Everything else Zubra maintains

Not npm entries, so not checked by the test above; listed so the whole surface is in one place.

| Piece | Tier | Tested by | Used by |
|---|---|---|---|
| `zubra` crate (the compiler as a Rust library) | Supported | Compiler (Rust) | The CLI, the WebAssembly build. Not published to crates.io yet |
| `include_zb!` (`macros/`, `zubra-macros`) | Experimental | Compiler (`cargo test --workspace`); non-JS backend examples (Axum garden) | `examples/backends/axum-garden`. Not published |
| `zubra-sync` binary (`sync-server/`) | Supported | Plugin job (`npm run test:binary`) | The Sync tests against a non-Node server |
| The release binaries | Stable | Compiler (`scripts/package-binary.test.sh`) | `@zubra/compiler`'s fallback, non-JS servers |
| Python package `zubra` (Jinja, Django) | Supported | Python package | Flask garden |
| Ruby gem `zubra` (Rails helpers) | Supported | Ruby and PHP packages | Nothing yet |
| PHP package `zubra/zubra` | Supported | Ruby and PHP packages | Nothing yet |
| Its Laravel service provider and Blade directives | Experimental | **Not executed in CI** (no Laravel install) | Nothing |
| Phoenix helpers | — | Not built | — |
| The component registry (`zubra add`) | Supported | Runtime (registry, both outputs, three browsers) | Copied into projects, which then own them |
| Skills (`skills/`) | Supported | Skills | `npm create zubra`, agents |
| `npx zubra mcp` | Supported | WebAssembly compiler | Coding agents |
| `zubra build --embed` (WordPress plugin, Shopify extension, snippets) | Supported | WebAssembly compiler (`embed.test.js`, the plugin run under PHP, Liquid rendered) | Nothing yet |
| VS Code extension (Marketplace `JourneytoCode`) | Supported | Editor support | Editors |
| DevTools browser extension | Supported | Editor support | Browsers |
| Playground and demo gallery (GitHub Pages) | Supported | WebAssembly compiler; demo gallery | The site |

## Supported framework versions

The adapters are tested against these, in the framework and meta-framework example jobs. A version outside this table may work; it isn't tested.

| Framework | Tested |
|---|---|
| React | 19 and 18 |
| Vue | 3 |
| Angular | 22 |
| Svelte | 5 (SvelteKit 3) |
| Solid | 1 (SolidStart 2) |
| Lit | 3 |
| Preact | 10 |
| Next.js | 16 |
| Nuxt | 4 |
| React Router | 8 |
| Astro | 7 (the `npm create zubra` template) |
| Eleventy | 3 |

Exact versions are in each example's `package.json` and lockfile; `docs/framework-matrix.md` has what each adapter does.
