# Contributing to Zubra

Thanks for looking. Bug reports, reproductions, and corrections to the documentation are all welcome, and a short issue with a failing `.zb` file is worth more than a long description.

## Reporting a problem

Open an issue and include the smallest `.zb` file that shows it, the output of `zubra compile` for it, the version (`zubra --version`), and the browser if it is a runtime problem. Security issues go through a private advisory instead: see `docs/security.md`.

## Changing the code

`AGENTS.md` lists what is where and how to run each test suite (`cargo test`, and `npm test` in `runtime/`, `plugin/`, `compiler/` and `create/`; `npm run test:browser` in `runtime/` needs Playwright's Chromium). CI runs every suite on each pull request.

- Every behaviour is mutation-checked: break the change on purpose once and confirm a test fails.
- Keep a pull request to one change, and mention it in `CHANGELOG.md` if users would notice it.
- Versions are bumped by the maintainer with `scripts/bump-version.sh`.

By contributing you agree your work is released under the repository's licence (`LICENSE`).

## Standards feedback

The reports in `docs/standards/` are written for the people working on Signals, DOM Parts and declarative custom elements. If a number or claim in one is wrong, an issue is the most useful thing you can send: each report says how to reproduce its measurements.
