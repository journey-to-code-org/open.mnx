"""mnx in a Python app, with no Node.js anywhere on the server.

Components are rendered to HTML by the mnx compiler's CLI (the Rust binary), and served to the
browser as ES modules it compiles too. The browser hydrates the server's markup in place.

    mnx = Mnx(components_dir)
    page = mnx.page()                      # one per request: records what the page used
    html = page.render("plot-map", plots=plots, selected="A3")
    page.styles(), page.modules            # for the layout's <head> and its closing <script>

Each render is one `mnx request` call, a JSON request on standard input with every component's
source, so `./other.mnx` imports resolve without touching the disk.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
EXE = ".exe" if sys.platform == "win32" else ""
HOW_TO = (
    "mnx: no compiler found. Build it from the repository root with `cargo build`, "
    "or set MNX_COMPILER to the path of an `mnx` binary."
)


def find_compiler() -> str | None:
    """MNX_COMPILER, then this repository's cargo builds, then `mnx` on the PATH."""
    if os.environ.get("MNX_COMPILER"):
        return os.environ["MNX_COMPILER"]
    for build in ("release", "debug"):
        candidate = REPO / "target" / build / f"mnx{EXE}"
        if candidate.is_file():
            return str(candidate)
    return shutil.which("mnx")


class MnxError(RuntimeError):
    pass


class Mnx:
    def __init__(self, components: Path, *, compiler: str | None = None, cache: bool = True):
        self.dir = Path(components)
        self.compiler = compiler or find_compiler()
        if not self.compiler:
            raise MnxError(HOW_TO)
        self.cache = cache
        self._sources: dict[str, str] | None = None
        self._css: dict[str, str] = {}
        self._js: dict[str, str] = {}

    @property
    def names(self) -> list[str]:
        return sorted(path.stem for path in self.dir.glob("*.mnx"))

    def _files(self) -> dict[str, str]:
        # Virtual paths, so the request is the same on every OS.
        if self._sources is None or not self.cache:
            self._sources = {
                f"/components/{path.name}": path.read_text(encoding="utf-8")
                for path in self.dir.glob("*.mnx")
            }
        return self._sources

    def request(self, name: str, **request) -> str:
        if name not in self.names:
            raise MnxError(f"no component {name!r} in {self.dir}")
        body = {"path": f"/components/{name}.mnx", "files": self._files(), **request}
        result = subprocess.run(
            [self.compiler, "request"],
            input=json.dumps(body),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        if result.returncode != 0:
            raise MnxError(result.stderr.strip() or f"mnx exited with {result.returncode}")
        response = json.loads(result.stdout)
        if not response["ok"]:
            raise MnxError(response["error"])
        return response["output"]

    def html(self, name: str, props: dict, slots: dict[str, str] | None = None) -> str:
        return self.request(
            name, emit="html", props=props, slots=slots or {}, slotSource="html", partial=True
        )

    def css(self, name: str) -> str:
        # A component's CSS includes the CSS of the components it imports.
        if name not in self._css or not self.cache:
            self._css[name] = self.request(name, emit="css")
        return self._css[name]

    def js(self, name: str) -> str:
        if name not in self._js or not self.cache:
            self._js[name] = self.request(name, emit="js", runtime="@mnx/runtime")
        return self._js[name]

    def page(self) -> "Page":
        return Page(self)


class Page:
    """What one page rendered, so its layout can add those components' CSS and modules."""

    def __init__(self, mnx: Mnx):
        self.mnx = mnx
        self.modules: list[str] = []

    def render(self, name: str, /, _slots: dict[str, str] | None = None, **props) -> str:
        html = self.mnx.html(name, props, _slots)
        if name not in self.modules:
            self.modules.append(name)
        return html

    def styles(self) -> str:
        return "\n".join(self.mnx.css(name) for name in self.modules)
