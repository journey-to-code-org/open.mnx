# Garden plots: Flask, Jinja and SQLite

A community garden's plot sign-up, in Python: Flask routes, Jinja templates and SQLite (the
standard library's `sqlite3`). Its mnx components are rendered to HTML by the **Rust compiler**,
so there is **no Node.js on the server**, and no bundler. The browser hydrates that markup in
place.

```sh
cargo build                                  # from the repository root: the mnx CLI
cd examples/backends/flask-garden
pip install -r requirements.txt
python app.py                                # http://localhost:5000
```

Set `FLASK_DEBUG=1` to recompile components on every request while you edit them, and
`GARDEN_DB=garden.db` to keep the data between runs (it's in memory by default).

## What's where

| | |
|---|---|
| `garden/mnx.py` | mnx for Python: `Mnx(components).page().render(name, **props)`, CSS and browser modules. About 100 lines, standard library only. |
| `garden/__init__.py` | The Flask app: routes, validation, and `mnx(…)` for templates. |
| `garden/store.py` | Plots, reservations, the waitlist and harvests, in SQLite. |
| `templates/` | Jinja pages. `{{ mnx('crop-picker', name='crops', options=crops) }}` renders a component. |
| `components/` | Five `.mnx` components. |
| `tests/test_app.py` | Every page in Chromium, with JavaScript off and on (Playwright for Python). |

## How it works

`mnx.py` runs `mnx request`, the CLI's JSON interface. The request is sent on standard input and
carries every component's source, so imports between components resolve without the CLI
reading the disk:

```json
{ "emit": "html", "path": "/components/plot-map.mnx", "files": { "/components/plot-map.mnx": "…" },
  "props": { "plots": […], "selected": "B1" }, "slotSource": "html", "partial": true }
```

Each page records the components it rendered. The layout then puts their CSS in the `<head>`
and imports their modules (`/components/<name>.js`, which the CLI compiles too) at the end of
the body. `@mnx/runtime` is served as the plain ES modules it is, through an import map.

## Without JavaScript

Every page works without JavaScript. The components put native form controls in light DOM:
- crop checkboxes;
- a `<input type="number">`;
- links for the plot map.

Signing up, joining a waitlist and logging a harvest are ordinary form posts. A form with errors
comes back with what was typed and chosen.

With JavaScript, the same markup becomes interactive:
- the crop picker counts as you pick, and disables what you can't add;
- the number fields get − and + buttons;
- the arrow keys move around the plot map.

## What it found

The server renders with the compiler's build-time expression subset: literals, member access,
arithmetic, comparisons, logic and ternaries. That subset is the whole story on a non-JS server,
so its gaps show up here first. `plan/roadmap-server.md` has the details and the plan.

- **`value.includes(x)` and template literals aren't evaluated on the server.** The region is
  left for the browser: an attribute is omitted, and text is left empty. For a checkbox, that
  means *unchecked* in the server's HTML, so a form re-rendered after an error would lose its
  choices without JavaScript. The app passes each option's `chosen` flag instead, and the chart
  gets each bar's `pct` from Python rather than computing `Math.max(…)` in the component.
- **It's silent.** Nothing says that `checked={value.includes(o.value)}` won't render on the
  server. In a form, that's a bug you only find with JavaScript off.
- **A prop's default sets its type.** `max="3"` is a string, so `value.length >= max` is an
  error ("comparison requires two numbers or two strings"). It has to be `max={3}`. The error is
  right, but it's met on the server first, as a 500.
- **One process per render.** Each `render()` starts the CLI: about 5 ms with a debug build, and
  a page with three components takes about 15 ms. That's fine for a garden, but a long-lived mode
  (`mnx serve`, JSON lines on stdin and stdout) would make it a fraction of that.
- **`name` is a common prop and a common Python argument.** `mnx('crop-picker', name='crops')`
  works because `render`'s own argument is positional-only.
