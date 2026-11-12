# zubra for Python

Render [Zubra](https://github.com/journey-to-code-org/zubra) web components from Flask, Django (template tags), or any Python server, with no Node.js anywhere. The components are compiled by the Zubra compiler (a Rust binary) running as one long-lived process; the browser hydrates the HTML your server wrote.

It isn't on PyPI yet (the name `zubra` isn't registered there). Until it is, install it from the repository, and give it a compiler (see "Finding the compiler"):

```sh
pip install "git+https://github.com/journey-to-code-org/zubra#subdirectory=clients/python"
pip install "zubra[jinja] @ git+https://github.com/journey-to-code-org/zubra#subdirectory=clients/python"   # with the Jinja helpers (Django needs nothing extra)
```

Once published, `pip install zubra` will fetch a platform wheel with the compiler inside it.

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

## Django

```python
# settings.py
INSTALLED_APPS = [..., "zubra.django"]
MIDDLEWARE = [..., "zubra.django.ZubraMiddleware"]
ZUBRA_COMPONENTS = BASE_DIR / "components"
# urls.py: the modules that make the components interactive
from zubra.django import zubra_module
urlpatterns = [..., path("components/<str:name>.js", zubra_module)]
```

```django
{% load zubra %}
{% zubra "plot-map" plots=plots columns=4 %}   {# render a component; values keep their types #}
{% zubra_head %}                                {# in the layout's <head> #}
{% zubra_scripts %}                             {# before </body> #}
```

The middleware gives each request its own page, and fills in `{% zubra_head %}` and `{% zubra_scripts %}` after the response is rendered, so a layout's `<head>` gets the CSS of components its child templates render further down. Templates need `request` in their context (`django.template.context_processors.request`, on by default). Django's Jinja backend can use `zubra.jinja` instead.

## Finding the compiler

In order: the `compiler=` argument, `$ZUBRA_COMPILER`, the binary bundled in the wheel, then `zubra` on the `PATH`. Without a platform wheel, download a binary from the project's [releases](https://github.com/journey-to-code-org/zubra/releases) (with `SHA256SUMS`).

## When the compiler misbehaves

Every failure is a `ZubraError`: a component that doesn't compile (with the compiler's message), a compiler that isn't where you said or can't run, one that exits or answers with something that isn't JSON, and a request that takes longer than `timeout` (30 seconds by default; `Zubra("components", timeout=None)` waits). After any of the last three the compiler process is replaced, so the next request starts clean. The same happens if the thread making a request is interrupted, so a later request can never be handed an earlier one's HTML.

## What it asks of the compiler

The package speaks `zubra serve`'s JSON-lines protocol (the request API, as of Zubra 5.4): one request per line on standard input with every component's source, one response per line. It versions on its own; the protocol is the contract, so an older package keeps working with a newer compiler.

## Building a wheel

`scripts/build_wheel.py` assembles a platform wheel from a release archive or a built binary (standard library only):

```sh
python scripts/build_wheel.py zubra-5.5.0-x86_64-unknown-linux-musl.tar.gz
```
