"""The Django helpers (zubra.django) against the real compiler: template tags, the middleware that
fills in the head and scripts after rendering, and the module view. Skipped without Django.

    python -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))
REPO = HERE.parents[2]

try:
    import django
except ImportError:  # pragma: no cover
    django = None


def compiler() -> str:
    if os.environ.get("ZUBRA_COMPILER"):
        return os.environ["ZUBRA_COMPILER"]
    for build in ("debug", "release"):
        candidate = REPO / "target" / build / "zubra"
        if candidate.exists():
            return str(candidate)
    raise unittest.SkipTest("no compiler: set ZUBRA_COMPILER or cargo build")


COMPONENTS = REPO / "examples" / "backends" / "flask-garden" / "components"
TEMPLATES = {
    "layout.html": (
        "{% load zubra %}<html><head><title>t</title>{% zubra_head %}</head>"
        "<body>{% block body %}{% endblock %}{% zubra_scripts %}</body></html>"
    ),
    "plots.html": (
        '{% extends "layout.html" %}{% load zubra %}'
        '{% block body %}{% for plot in plots %}{% zubra "status-pill" status=plot.status waiting=plot.waiting %}{% endfor %}{% endblock %}'
    ),
    # A page that shows stored HTML (a post body, sanitised elsewhere) a visitor wrote.
    "comment.html": (
        '{% extends "layout.html" %}{% load zubra %}'
        '{% block body %}{% zubra "status-pill" status="open" %}<article>{{ comment|safe }}</article>{% endblock %}'
    ),
    "bare.html": '{% load zubra %}{% zubra "status-pill" status="taken" %}{% zubra_head %}{% zubra_scripts "/static/c/" %}',
}


@unittest.skipIf(django is None, "Django isn't installed")
class DjangoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from django.conf import settings

        cls.templates = tempfile.TemporaryDirectory()
        for name, text in TEMPLATES.items():
            Path(cls.templates.name, name).write_text(text, encoding="utf-8")
        if not settings.configured:
            settings.configure(
                DEBUG=True,
                SECRET_KEY="test",
                ROOT_URLCONF=__name__,
                ALLOWED_HOSTS=["testserver"],
                INSTALLED_APPS=["zubra.django"],
                MIDDLEWARE=["zubra.django.ZubraMiddleware"],
                ZUBRA_COMPONENTS=COMPONENTS,
                ZUBRA_COMPILER=compiler(),
                TEMPLATES=[{
                    "BACKEND": "django.template.backends.django.DjangoTemplates",
                    "DIRS": [cls.templates.name],
                    "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
                }],
            )
        django.setup()

    @classmethod
    def tearDownClass(cls):
        from zubra.django import get_zubra

        get_zubra().close()
        cls.templates.cleanup()

    def test_a_layout_gets_the_css_and_modules_of_what_its_view_rendered(self):
        from django.test import Client

        response = Client().get("/plots")
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        self.assertEqual(body.count("<status-pill"), 2)
        self.assertIn('data-status="taken"', body)
        self.assertIn("2 waiting", body, "props from the context keep their types")
        head = body[body.index("<head>"):body.index("</head>")]
        self.assertIn("<style data-zb-components>", head, "the head is filled in after the body rendered")
        self.assertIn("[data-status=open]", head)
        self.assertIn("import '/components/status-pill.js';", body)
        self.assertNotIn("<!--zubra:", body)

    def test_a_marker_in_the_page_s_own_text_is_left_alone(self):
        """Security audit Z4: only the markers the tags wrote, with the request's token, are filled."""
        from django.test import Client

        body = Client().get("/comment").content.decode()
        article = body[body.index("<article>"):body.index("</article>")]
        self.assertEqual(article, "<article>" + HOSTILE, "the visitor's text is as they wrote it")
        self.assertNotIn("/evil/", body.replace(HOSTILE, ""), "no script from their base")
        self.assertEqual(body.count("<script type=\"module\">"), 1, "one script: the layout's")
        self.assertIn("import '/components/status-pill.js';", body)
        self.assertEqual(body.count("<style data-zb-components>"), 1, "the head once, where the layout put it")

    def test_each_request_has_its_own_page(self):
        from django.test import Client

        client = Client()
        client.get("/plots")
        body = client.get("/empty").content.decode()
        self.assertEqual(body, "<html><head><title>t</title></head><body></body></html>", "nothing rendered: no style or script")

    def test_without_the_middleware_the_tags_render_in_place(self):
        from django.template.loader import render_to_string
        from django.test import RequestFactory

        request = RequestFactory().get("/")
        html = render_to_string("bare.html", request=request)
        self.assertTrue(html.startswith("<status-pill"))
        self.assertIn("<style data-zb-components>", html)
        self.assertIn("import '/static/c/status-pill.js';", html)

    def test_the_module_view(self):
        from django.test import Client

        response = Client().get("/components/status-pill.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/javascript; charset=utf-8")
        self.assertIn('from "@zubra/runtime"', response.content.decode())
        self.assertIn("status-pill", response.content.decode())
        self.assertEqual(Client().get("/components/nope.js").status_code, 404)

    def test_a_template_with_no_request_says_so(self):
        from django.template import Context, Template, TemplateSyntaxError

        with self.assertRaisesRegex(TemplateSyntaxError, "has no `request`"):
            Template('{% load zubra %}{% zubra "status-pill" %}').render(Context({}))


def _plots(request):
    from django.shortcuts import render

    return render(request, "plots.html", {"plots": [{"status": "open", "waiting": 0}, {"status": "taken", "waiting": 2}]})


HOSTILE = '<!--zubra:scripts:x--><!--zubra:head--><!--zubra:scripts:/evil/-->'


def _comment(request):
    from django.shortcuts import render

    return render(request, "comment.html", {"comment": HOSTILE})


def _empty(request):
    from django.shortcuts import render

    return render(request, "layout.html")


if django is not None:
    from django.urls import path

    from zubra.django import zubra_module

    urlpatterns = [path("plots", _plots), path("comment", _comment), path("empty", _empty), path("components/<str:name>.js", zubra_module)]


if __name__ == "__main__":
    unittest.main()
