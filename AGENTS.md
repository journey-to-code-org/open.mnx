# Working in this repository

mnx is a compiler for web components: `.mnx` files in, custom elements, server HTML, typings and framework wrappers out. The Rust compiler is in `src/`, the browser runtime in `runtime/`, the npm packages in `compiler/`, `plugin/`, `server/`, `create/`, `editors/`, the component registry in `registry/`, and a tested app per framework and server in `examples/`.

## Skills

Read the skill before the task, not the source: each is written so an agent can do the job from it alone.

| Task | Skill |
|---|---|
| Write or change a component | `skills/mnx-component/SKILL.md` |
| Use a component from React, Vue, Svelte, Solid, Angular, Lit, Astro or plain HTML | `skills/mnx-consume/SKILL.md` |
| Run the compiler: check, compile, publish a library, add a registry component, convert React, migrate, serve | `skills/mnx-cli/SKILL.md` |
| Render on a server, or make a meta-framework page complete before JavaScript | `skills/mnx-server/SKILL.md` |

`npm create mnx` copies the first two into new projects, and `mnx build --lib` writes a consuming skill for the library it builds, so apps that use mnx carry their own.

## Changing the compiler or runtime

- Build: `cargo build --release`; the npm packages read `target/release/mnx` when `@mnx/compiler`'s WebAssembly build isn't present.
- Tests: `cargo test` (compiler), `cd runtime && npm test && npm run test:browser` (needs Playwright's Chromium), `cd plugin && npm test`, `cd compiler && npm test`, `node skills/test/skills.test.js`. `.github/workflows/ci.yml` runs every suite.
- Every behaviour is mutation-checked: when adding one, break it on purpose once and confirm a test fails.
- Commits are authored by Mikey Nichols with no trailers. Versions are bumped with `scripts/bump-version.sh`, and each release gets a `CHANGELOG.md` entry.
- The plans and decision records live in the project's docs (`plan/`), not in the repository; the README's rules are the reference for what the compiler does.
