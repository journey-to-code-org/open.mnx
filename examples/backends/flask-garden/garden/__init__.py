"""Community garden plots: Flask, Jinja and SQLite, with zubra components rendered by the Rust
compiler and hydrated in the browser. No Node.js on the server, and no bundler."""
from __future__ import annotations

import os
import re
from pathlib import Path

from flask import Flask, Response, abort, g, redirect, render_template, request, send_from_directory, url_for
from markupsafe import Markup

from .zubra import REPO, Zubra
from .store import CROP_NAMES, CROPS, MAX_CROPS, Store

HERE = Path(__file__).resolve().parent.parent
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def create_app(*, store: Store | None = None, cache: bool = True) -> Flask:
    app = Flask(__name__, template_folder=str(HERE / "templates"), static_folder=str(HERE / "static"))
    store = store or Store(os.environ.get("GARDEN_DB", ":memory:"))
    zubra = Zubra(HERE / "components", cache=cache)
    # @zubra/runtime's ES modules, served as they are. In a deploy you'd copy runtime/src (or the
    # npm package's files) next to your static files; there's nothing to build.
    runtime = Path(os.environ.get("ZUBRA_RUNTIME", REPO / "runtime" / "src"))

    @app.before_request
    def start_page():
        g.zubra = zubra.page()

    @app.context_processor
    def components():
        return {"zubra": lambda component, /, **props: Markup(g.zubra.render(component, **props))}

    def page(view: str, status: int = 200, **context):
        # The view first, so the layout knows which components it used: their CSS goes in the
        # head, and their modules load at the end of the body.
        body = render_template(view, **context)
        html = render_template(
            "layout.html", body=Markup(body), styles=Markup(g.zubra.styles()), modules=g.zubra.modules, **context
        )
        return html, status

    @app.get("/components/<name>.js")
    def component_module(name: str):
        if name not in zubra.names:
            abort(404)
        return Response(zubra.js(name), mimetype="text/javascript")

    @app.get("/vendor/zubra/<path:path>")
    def runtime_module(path: str):
        return send_from_directory(runtime, path, mimetype="text/javascript")

    def crop_options() -> list[dict]:
        return [{"value": value, "label": label} for value, label in CROPS]

    @app.get("/")
    def home():
        plots = store.plots()
        open_count = sum(plot["status"] == "open" for plot in plots)
        return page("index.html", title="Plots", plots=plots, open_count=open_count)

    def signup_form(plot: dict, signup: dict | None = None, errors: dict | None = None, status: int = 200):
        signup = signup or {"name": "", "email": "", "crops": [], "household": 1}
        return page(
            "plot.html", status, title=f"Plot {plot['id']}", plot=plot, plots=store.plots(),
            signup=signup, crops=crop_options(), max_crops=MAX_CROPS,
            errors=errors or {}, done=request.args.get("done"),
        )

    @app.get("/plots/<id>")
    def plot_page(id: str):
        plot = store.plot(id) or abort(404)
        return signup_form(plot)

    @app.post("/plots/<id>")
    def sign_up(id: str):
        plot = store.plot(id) or abort(404)
        form = request.form
        signup = {
            "name": form.get("name", "").strip(),
            "email": form.get("email", "").strip(),
            "crops": [crop for crop in form.getlist("crops") if crop in CROP_NAMES],
            "household": form.get("household", ""),
        }
        errors = {}
        if not signup["name"]:
            errors["name"] = "Your name, please."
        if not EMAIL.match(signup["email"]):
            errors["email"] = "An email address we can reach you at."
        if not 1 <= len(signup["crops"]) <= MAX_CROPS:
            errors["crops"] = f"Pick between 1 and {MAX_CROPS} crops."
        try:
            signup["household"] = int(signup["household"])
            if not 1 <= signup["household"] <= 8:
                raise ValueError
        except ValueError:
            errors["household"] = "Between 1 and 8 people."
            signup["household"] = 1
        if errors:
            return signup_form(plot, signup, errors, 422)
        if plot["status"] == "open":
            store.reserve(id, signup)
            done = "reserved"
        else:
            done = f"waitlist-{store.join_waitlist(id, signup)}"
        return redirect(url_for("plot_page", id=id, done=done), 303)

    @app.get("/harvest")
    def harvest():
        rows = store.harvest_by_crop()
        bars = [{**row, "label": CROP_NAMES[row["crop"]]} for row in rows]
        taken = [plot["id"] for plot in store.plots() if plot["status"] == "taken"]
        return page(
            "harvest.html", title="Harvest", bars=bars,
            plots=taken, crops=CROPS, chosen_plot=request.args.get("plot", taken[0] if taken else ""),
            logged=request.args.get("logged"),
        )

    @app.post("/harvest")
    def log_harvest():
        plot, crop = request.form.get("plot", ""), request.form.get("crop", "")
        try:
            kg = float(request.form.get("kg", ""))
        except ValueError:
            kg = 0
        if not store.plot(plot) or crop not in CROP_NAMES or not 0 < kg <= 100:
            abort(422)
        store.log_harvest(plot, crop, kg)
        return redirect(url_for("harvest", plot=plot, logged=crop), 303)

    @app.post("/reset")
    def reset():
        store.reset()
        return "", 204

    return app
