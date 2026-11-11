"""Jinja helpers: `{{ zubra('plot-map', plots=plots) }}` in a template, with the page's CSS and
modules in the layout.

    from zubra import Zubra
    from zubra.jinja import install

    zubra = Zubra("components")
    install(app.jinja_env, zubra, page=lambda: g.zubra_page)   # Flask: one Page per request

Then, in templates:

    {{ zubra('plot-map', plots=plots, columns=4) }}      {# renders a component #}
    {{ zubra_head() }}                                    {# in <head>: the components' CSS #}
    {{ zubra_scripts() }}                                 {# before </body>: their modules #}

Render the view before the layout (the layout asks which components the view used). Needs
`jinja2` (`pip install zubra[jinja]`); Flask and Django's Jinja backend have it.
"""
from __future__ import annotations

from typing import Callable

from markupsafe import Markup

from . import Page, Zubra

__all__ = ["install", "helpers"]


def helpers(page: Callable[[], Page]) -> dict[str, Callable]:
    """The template globals, for the Page that `page()` returns while a request is rendering."""

    def zubra(name: str, /, **props) -> Markup:
        return Markup(page().render(name, **props))

    def zubra_head() -> Markup:
        return Markup(page().head())

    def zubra_scripts(base: str = "/components/") -> Markup:
        return Markup(page().scripts(base))

    return {"zubra": zubra, "zubra_head": zubra_head, "zubra_scripts": zubra_scripts}


def install(environment, zubra: Zubra, *, page: Callable[[], Page] | None = None) -> None:
    """Add `zubra`, `zubra_head` and `zubra_scripts` to a Jinja environment (`app.jinja_env`).

    `page` returns the Page of the request being rendered; it defaults to a single Page for the
    environment, which suits a script that renders one page. A web app gives each request its own.
    """
    shared = zubra.page()
    environment.globals.update(helpers(page or (lambda: shared)))
