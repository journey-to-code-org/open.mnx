# zubra for Python

Render [Zubra](https://github.com/journey-to-code-org/zubra) web components from Flask, Django, or any Python server, with no Node.js anywhere. The components are compiled by the Zubra compiler (a Rust binary) running as one long-lived process; the browser hydrates the HTML your server wrote.

```sh
pip install zubra            # a platform wheel carries the compiler
pip install "zubra[jinja]"   # with the Jinja helpers (Flask has Jinja already)
```

```python
from zubra import Zubra

zubra = Zubra("components")                 # a folder of .zb files
page = zubra.page()                         # one per request
html = page.render("price-tag", amount=12)  # server-rendered HTML
page.head()                                 # <style data-zb-components>…</style>, for <head>
page.scripts()                              # <script type="module">…</script>, before </body>
```

Serve `zubra.js(name)` at `/components/<name>.js` and `@zubra/runtime`'s ES modules (from the npm package) wherever your import map points; the page works without them, and they make it interactive.

## Jinja

```python
from zubra.jinja import install
install(app.jinja_env, zubra, page=lambda: g.zubra_page)   # Flask: a Page per request (set it in before_request)
```

```jinja
{{ zubra('plot-map', plots=plots, columns=4) }}   {# render a component #}
{{ zubra_head() }}                               {# in the layout's <head> #}
{{ zubra_scripts() }}                            {# before </body> #}
```

Render the view before the layout, so the layout knows which components the view used. See [`examples/backends/flask-garden`](../../examples/backends/flask-garden) for a whole app.

## Finding the compiler

In order: the `compiler=` argument, `$ZUBRA_COMPILER`, the binary bundled in the wheel, then `zubra` on the `PATH`. Without a platform wheel, download a binary from the project's [releases](https://github.com/journey-to-code-org/zubra/releases) (with `SHA256SUMS`).

## What it asks of the compiler

The package speaks `zubra serve`'s JSON-lines protocol (the request API, as of Zubra 5.4): one request per line on standard input with every component's source, one response per line. It versions on its own; the protocol is the contract, so an older package keeps working with a newer compiler.

## Building a wheel

`scripts/build_wheel.py` assembles a platform wheel from a release archive or a built binary (standard library only):

```sh
python scripts/build_wheel.py zubra-5.4.0-x86_64-unknown-linux-gnu.tar.gz
```
