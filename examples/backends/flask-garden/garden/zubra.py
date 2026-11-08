"""zubra in a Python app, with no Node.js anywhere on the server.

Components are rendered to HTML by the zubra compiler's CLI (the Rust binary), and served to the
browser as ES modules it compiles too. The browser hydrates the server's markup in place.

    zubra = Zubra(components_dir)
    page = zubra.page()                      # one per request: records what the page used
    html = page.render("plot-map", plots=plots, selected="A3")
    page.styles(), page.modules            # for the layout's <head> and its closing <script>

Renders go to one long-lived `zubra serve` process: a JSON request per line on its standard input,
with every component's source (so `./other.zb` imports resolve without touching the disk), and
a JSON response per line back.
"""
from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
EXE = ".exe" if sys.platform == "win32" else ""
HOW_TO = (
    "zubra: no compiler found. Build it from the repository root with `cargo build`, "
    "or set ZUBRA_COMPILER to the path of an `zubra` binary."
)


def find_compiler() -> str | None:
    """ZUBRA_COMPILER, then this repository's cargo builds, then `zubra` on the PATH."""
    if os.environ.get("ZUBRA_COMPILER"):
        return os.environ["ZUBRA_COMPILER"]
    for build in ("release", "debug"):
        candidate = REPO / "target" / build / f"zubra{EXE}"
        if candidate.is_file():
            return str(candidate)
    return shutil.which("zubra")


class ZubraError(RuntimeError):
    pass


class Zubra:
    def __init__(self, components: Path, *, compiler: str | None = None, cache: bool = True):
        self.dir = Path(components)
        self.compiler = compiler or find_compiler()
        if not self.compiler:
            raise ZubraError(HOW_TO)
        self.cache = cache
        self._process: subprocess.Popen | None = None
        self._lock = threading.Lock()  # Flask serves requests on threads; one line at a time
        atexit.register(self.close)
        self._sources: dict[str, str] | None = None
        self._css: dict[str, str] = {}
        self._js: dict[str, str] = {}

    @property
    def names(self) -> list[str]:
        return sorted(path.stem for path in self.dir.glob("*.zb"))

    def _files(self) -> dict[str, str]:
        # Virtual paths, so the request is the same on every OS.
        if self._sources is None or not self.cache:
            self._sources = {
                f"/components/{path.name}": path.read_text(encoding="utf-8")
                for path in self.dir.glob("*.zb")
            }
        return self._sources

    def request(self, name: str, **request) -> str:
        if name not in self.names:
            raise ZubraError(f"no component {name!r} in {self.dir}")
        body = {"path": f"/components/{name}.zb", "files": self._files(), **request}
        with self._lock:
            if self._process is None or self._process.poll() is not None:
                self._process = subprocess.Popen(
                    [self.compiler, "serve"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                )
            self._process.stdin.write(json.dumps(body) + "\n")
            self._process.stdin.flush()
            line = self._process.stdout.readline()
        if not line:
            raise ZubraError(f"{self.compiler} serve stopped (is it zubra 2.7 or later?)")
        response = json.loads(line)
        if not response["ok"]:
            raise ZubraError(response["error"])
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
            self._js[name] = self.request(name, emit="js", runtime="@zubra/runtime")
        return self._js[name]

    def close(self) -> None:
        """Stop the compiler process (it also stops when this process exits)."""
        if self._process is not None:
            self._process.stdin.close()
            self._process.wait()
            self._process = None

    def page(self) -> "Page":
        return Page(self)


class Page:
    """What one page rendered, so its layout can add those components' CSS and modules."""

    def __init__(self, zubra: Zubra):
        self.zubra = zubra
        self.modules: list[str] = []

    def render(self, name: str, /, _slots: dict[str, str] | None = None, **props) -> str:
        html = self.zubra.html(name, props, _slots)
        if name not in self.modules:
            self.modules.append(name)
        return html

    def styles(self) -> str:
        return "\n".join(self.zubra.css(name) for name in self.modules)
