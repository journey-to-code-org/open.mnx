# Working in this repository

Zubra is a compiler for web components: `.zb` files in, custom elements, server HTML, typings and framework wrappers out. The Rust compiler is in `src/`, the browser runtime in `runtime/`, the npm packages in `compiler/`, `plugin/`, `server/`, `create/`, `editors/`, the component registry in `registry/`, and a tested app per framework and server in `examples/`.

## Skills

Read the skill before the task, not the source: each is written so an agent can do the job from it alone.

| Task | Skill |
|---|---|
| Write or change a component | `skills/zubra-component/SKILL.md` |
| Use a component from React, Vue, Svelte, Solid, Angular, Lit, Astro or plain HTML | `skills/zubra-consume/SKILL.md` |
| Run the compiler: check, compile, publish a library, add a registry component, convert React, serve | `skills/zubra-cli/SKILL.md` |
| Render on a server, or make a meta-framework page complete before JavaScript | `skills/zubra-server/SKILL.md` |

`npm create zubra` copies the first two into new projects, and `zubra build --lib` writes a consuming skill for the library it builds, so apps that use Zubra carry their own.

## Changing the compiler or runtime

- Build: `cargo build --release`; the npm packages read `target/release/zubra` when `@zubra/compiler`'s WebAssembly build isn't present.
- Tests: `cargo test` (compiler), `cd runtime && npm test && npm run test:browser` (needs Playwright's Chromium), `cd plugin && npm test`, `cd compiler && npm test`, `node skills/test/skills.test.js`. `.github/workflows/ci.yml` runs every suite.
- Every behaviour is mutation-checked: when adding one, break it on purpose once and confirm a test fails.
- Commits are authored by Mikey Nichols with no trailers. Versions are bumped with `scripts/bump-version.sh`, and each release gets a `CHANGELOG.md` entry. Merging the bump to `main` releases it (`.github/workflows/release.yml`: npm with provenance, the tag, the GitHub release); don't tag or publish by hand.
- The plans and decision records live in the project's docs (`plan/`), not in the repository; the README's rules are the reference for what the compiler does.
