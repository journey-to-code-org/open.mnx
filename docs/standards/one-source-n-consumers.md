# One source, N consumers: the claim with numbers

*3.4.0, 2026-11-07. `plan/roadmap-4.0.md` challenge 3. Written for the two people in the survey who said that agents make rewriting a component for another framework cheap, and the instructor who said that with ported tests, drift is a non-problem. They were largely right, and this page says what is left of the argument for one source once that is granted.*

## The claim, stated as the weaker claim

Not "rewriting is expensive". Agents have made a port cheap, and this page's own experiment confirms it: nine ports of three components took three minutes, and a fix was propagated to six of them in under a minute with no mistakes.

The claim is: **N copies are N things to review, keep matching and keep correct, and the things that go wrong in a port are the things the compiler generates.** It is a claim about scale and about a class of behaviour, not about effort.

## 1. What the compiler generates, counted

The registry is 20 components, 847 lines of `.zb`. The matrix is eight consumers: React 18, React 19, Vue 3, Angular, Svelte 5, Solid, Lit and Preact (plus plain HTML, Astro and five server-rendering frameworks).

| | Hand-written ports | Generated |
|---|---|---|
| Component files | 20 × 7 = **140** (one per framework that isn't plain HTML), each a rewrite | **20**, plus per component a React wrapper and a Vue wrapper of 4 lines each (`zubra build --lib`), typings, and one manifest |
| Code that knows the frameworks | 140 files' worth, by the port's author | **367 lines**, once: `runtime/src/react.js` (124), `runtime/src/vue.js` (125), the Angular `ZubraModel` directive (118) |
| Reviews | 140 | 20, plus the three adapters |
| Test suites | one per port, or one that covers one port | the registry's keyboard and accessibility tests, once; the matrix proves the adapters |

A design system is where this matters: at 20 components the hand-written side is 140 files; at three it is 21 and duplication is the cheaper option, which `docs/who-this-is-for.md` says.

## 2. The framework bugs the adapters absorbed, each fixed once

Every one of these would have been a per-port bug, found or not found per port. Each was found once, fixed in the adapter or the element, and every component got the fix. From `CHANGELOG.md`:

| Fixed once | Where | Release |
|---|---|---|
| React 19 sets props after the element is inserted, so a script seeding state from a prop saw `undefined` | React wrapper sets props as it creates the element | 2.6.1 |
| React 18 writes unknown props as attributes (`[object Object]`), so objects arrived late | the element reads the wrapper's `zb-props` JSON when it starts, before React's effect | 2.8 (this page corrects `progress.md`, which still listed it as open) |
| Vue removes an element's own nodes as a hydration mismatch | the Vue wrapper renders a vnode with no children, so Vue never looks inside | 3.3 |
| React re-renders the page (#418) around a light-DOM element | the React wrapper keeps React out of the host with `dangerouslySetInnerHTML` | 2.11 (shadow), 3.3 (light) |
| Svelte's server rendering writes object props as `"[object Object]"` | treated as "not given yet" | 2.6.3 |
| An empty URL prop (`href=""` before the app set it) logged an unsafe-URL error | left off quietly | 2.6.3 |
| Vue's `v-model` needs `modelValue`/`update:modelValue`; Angular listens for `valueChange`, not `valuechange` | the Vue wrapper maps the model pair; `ZubraModel` bridges Angular forms | 1.3 |
| React's `className`/`htmlFor` become `classname`/`htmlfor` attributes under React 18 | the React wrapper maps them | 1.0 |
| htmx and html-minifier strip the hydration markers | the element restores them by structure | 2.10 |
| Solid's `prop:` values never reach the server HTML | the plugin writes `zb-props` in server builds | 2.10 |

Ten framework-specific behaviours; zero per-component work. The instructor's point that "the bug may still be Angular-specific" is right, and this is where such bugs live: in one file per framework.

## 3. The experiment: three components, three frameworks, one agent

`ports-experiment/run.mjs` ran it; `ports-experiment/log.txt` is the full output. The agent was Claude (`claude -p`), given each registry component's source and asked for a faithful port keeping props, events, accessibility, form behaviour and styles.

**Porting.** `star-rating`, `toggle-switch` and `quantity-stepper` to React 19, Vue 3 and Svelte 5: nine ports, 57 to 114 lines each, 9 to 22 seconds each.

**Review, before any change.** A second agent compared each port with its source and listed behavioural differences (ignoring syntax, idiom and styling):

| Component | React | Vue | Svelte |
|---|---|---|---|
| star-rating | 4 | 0 | 3 |
| toggle-switch | 6 | 5 | 9 |
| quantity-stepper | 11 | 1 | 8 |
| **total** | **21** | **6** | **20** |

Forty-seven differences in nine fresh ports, before anyone edited anything. Almost all of them are in three groups:

- **Form participation** (every port): no form reset to the default; a `name` prop added because the port can't be a form-associated element; nothing submitted without it; a disabled `<fieldset>` not honoured; validation attached to a hidden input that can't be focused.
- **Event semantics** (React and Svelte ports): a callback instead of a bubbling DOM `CustomEvent`; the event fired only from the click handler rather than on every change of the two-way prop; fired from an inner `<div>` rather than the host.
- **Host semantics**: a wrapper `<div>` or `<span>` standing in for the element, so `:host` styles, attributes and refs land on the wrong node; a controlled/uncontrolled split (`defaultValue`, `defaultChecked`) the original doesn't have.

These are not the agent being careless. They are the parts of a web component that the framework doesn't give you and that a Zubra file doesn't ask you to write: `form-associated`, `name:model`, `emit()`, the host tag. The compiler generates them; a port has to reconstruct them, and did so differently nine times.

**The fix.** Two changes to the sources, written as a maintainer would hand them to an agent: a `step` prop for the stepper, a `disabled` prop for the switch that also stops the form value. The agent applied each to its three ports in 6 to 8 seconds.

**Review after the fix.** Every one of the six ports had the fix, correctly (the reviewer found no difference about `step` or `disabled`; grep confirms both in all six). The pre-existing differences remained: toggle-switch 5 / 2 / 2, quantity-stepper 8 / 1 / 7 (the reviewer is itself an agent and doesn't count identically twice, so the totals move; the classes don't).

**What it shows.** The instructor was right about propagation: with a clear description, an agent applies a fix to every port without error. He was wrong, on this evidence, that drift is therefore a non-problem: the ports had diverged from the source *at the moment they were made*, in the behaviours a user feels most (what the form submits, whether reset works, which events fire and from where), and propagating fixes faithfully preserves those divergences. A test suite would catch some of them only if someone wrote a form-reset test per port.

**Caveats, so this isn't overclaimed.** One agent, one run, one-shot ports with no tests. Vue ports were markedly closer (6 differences) than React (21) and Svelte (20), largely because Vue's `defineModel` and emits map onto the two-way prop and DOM events naturally. Some reviewer findings are framework necessities rather than mistakes (a `name` prop on a non-custom-element), though the behaviour difference is real. The fixes were additive; a change that touched the event semantics might have been applied less consistently, or more. Rerun it: `node docs/standards/ports-experiment/run.mjs port`, then `review`, `fix`, `review after`.

## 4. The scale argument, restated with these numbers

| Components × frameworks | Ports to review | Differences, at the experiment's rate (5.2 per port) | Generated |
|---|---|---|---|
| 3 × 2 | 6 | about 31 | 3 files, 367 lines of adapter you didn't write |
| 20 × 7 | 140 | about 730 | 20 files, the same 367 lines |
| 50 × 7 | 350 | about 1,800 | 50 files, the same 367 lines |

At three components, port. At a design system, don't.

## What the adapters cost, honestly

The critique's other point: the generic adapter is harder to test than ported tests, and trades easy edge cases for hard ones. The ten bugs in §2 are those hard cases, and each took real work to find. The answer is the matrix (`docs/framework-matrix.md`): every row runs every push in three engines, and a framework is supported only when its row is green. That is the test suite that ported tests would have to be, per port.
