"""Django helpers: template tags and a middleware that gives each request its own Page.

    # settings.py
    INSTALLED_APPS = [..., "zubra.django"]
    MIDDLEWARE = [..., "zubra.django.ZubraMiddleware"]
    ZUBRA_COMPONENTS = BASE_DIR / "components"      # a folder of .zb files
    # optional: ZUBRA_COMPILER = "/path/to/zubra", ZUBRA_SCRIPTS_BASE = "/components/"

Then, in templates:

    {% load zubra %}
    {% zubra "plot-map" plots=plots columns=4 %}       renders a component
    {% zubra_head %}                                   in <head>: the components' CSS
    {% zubra_scripts %}                                before </body>: their modules

`zubra_module(request, name)` is a view that serves `/components/<name>.js`:

    path("components/<str:name>.js", zubra_module)

With the middleware, `{% zubra_head %}` and `{% zubra_scripts %}` can come before the components
they're for (a layout's `<head>` is rendered before the view's blocks): they leave a marker, and the
middleware puts the page's CSS and modules there once the response is rendered. Without it, they
render what the page has used so far. With Jinja, use `zubra.jinja` instead.
"""
from __future__ import annotations

from functools import lru_cache

from .. import Page, Zubra, ZubraError

__all__ = ["ZubraMiddleware", "get_zubra", "page_for", "zubra_module", "HEAD", "SCRIPTS"]

# What the tags leave when the middleware will fill them in after rendering.
HEAD = "<!--zubra:head-->"
SCRIPTS = "<!--zubra:scripts:{base}-->"


@lru_cache(maxsize=None)
def _zubra(components: str, compiler: str | None) -> Zubra:
    return Zubra(components, compiler=compiler)


def get_zubra() -> Zubra:
    """The project's Zubra, from `settings.ZUBRA_COMPONENTS` (and `ZUBRA_COMPILER`): one process for the server."""
    from django.conf import settings

    components = getattr(settings, "ZUBRA_COMPONENTS", None)
    if components is None:
        raise ZubraError("zubra: set ZUBRA_COMPONENTS in settings.py to the folder of .zb files")
    return _zubra(str(components), getattr(settings, "ZUBRA_COMPILER", None))


def page_for(request) -> Page:
    """The request's Page (the middleware makes one; without it, one is made on first use)."""
    page = getattr(request, "zubra_page", None)
    if page is None:
        page = request.zubra_page = get_zubra().page()
    return page


class ZubraMiddleware:
    """Gives each request a fresh Page (`request.zubra_page`), so pages don't share what they used,
    and fills in the head and scripts markers once the page is rendered."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        page = request.zubra_page = get_zubra().page()
        request.zubra_deferred = True
        response = self.get_response(request)
        if getattr(response, "streaming", False) or "html" not in response.get("Content-Type", ""):
            return response
        if hasattr(response, "render") and not getattr(response, "is_rendered", True):
            response.render()
        body = response.content.decode(response.charset or "utf-8")
        if HEAD not in body and "<!--zubra:scripts:" not in body:
            return response
        body = body.replace(HEAD, page.head())
        while (start := body.find("<!--zubra:scripts:")) != -1:
            end = body.index("-->", start)
            base = body[start + len("<!--zubra:scripts:"):end]
            body = body[:start] + page.scripts(base) + body[end + 3:]
        response.content = body.encode(response.charset or "utf-8")
        if response.has_header("Content-Length"):
            response["Content-Length"] = str(len(response.content))
        return response


def zubra_module(request, name: str):
    """A view: the module that defines component `name`, for `/components/<name>.js`."""
    from django.http import Http404, HttpResponse

    zubra = get_zubra()
    if name not in zubra.names:
        raise Http404(f"no component {name!r}")
    return HttpResponse(zubra.js(name), content_type="text/javascript; charset=utf-8")
