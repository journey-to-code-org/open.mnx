"""`{% load zubra %}`: `{% zubra "name" prop=value %}`, `{% zubra_head %}`, `{% zubra_scripts %}`."""
from __future__ import annotations

from django import template
from django.conf import settings
from django.utils.safestring import mark_safe

from .. import HEAD, SCRIPTS, page_for

register = template.Library()


def _page(context):
    request = context.get("request")
    if request is None:
        raise template.TemplateSyntaxError(
            "zubra: the template has no `request` (add django.template.context_processors.request, or render with a RequestContext)"
        )
    return page_for(request)


@register.simple_tag(takes_context=True, name="zubra")
def zubra(context, name, **props):
    """Render component `name` with `props` (values from the context keep their types)."""
    return mark_safe(_page(context).render(name, **props))


def _deferred(context):
    return getattr(context.get("request"), "zubra_deferred", False)


@register.simple_tag(takes_context=True)
def zubra_head(context):
    """The CSS of the components the page renders (filled in by the middleware once it has)."""
    return mark_safe(HEAD if _deferred(context) else _page(context).head())


@register.simple_tag(takes_context=True)
def zubra_scripts(context, base=None):
    """The modules of the components the page renders, from `base` (`ZUBRA_SCRIPTS_BASE`, `/components/`)."""
    base = base or getattr(settings, "ZUBRA_SCRIPTS_BASE", "/components/")
    if _deferred(context):
        return mark_safe(SCRIPTS.format(base=base.replace("--", "")))
    return mark_safe(_page(context).scripts(base))
