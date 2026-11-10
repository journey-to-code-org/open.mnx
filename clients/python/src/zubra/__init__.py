"""zubra in a Python app, with no Node.js anywhere on the server.

Components are rendered to HTML by the zubra compiler (a Rust binary), and served to the browser
as ES modules it compiles too. The browser hydrates the server's markup in place.

    from zubra import Zubra

    zubra = Zubra("components")              # a folder of .zb files
    page = zubra.page()                      # one per request: records what the page used
    html = page.render("plot-map", plots=plots, selected="A3")
    page.head(), page.scripts()              # for the layout: the components' CSS, then their modules

Renders go to one long-lived `zubra serve` process: a JSON request per line on its standard input,
with every component's source (so `./other.zb` imports resolve without touching the disk), and a
JSON response per line back. See `zubra.jinja` for Flask, Jinja and Django-style templates.

The compiler is found, in order: the `compiler=` argument, `$ZUBRA_COMPILER`, the binary bundled
in a platform wheel, then `zubra` on the PATH.
"""
from __future__ import annotations

import atexit
import html as _html
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

__all__ = ["Zubra", "Page", "ZubraError", "find_compiler", "__version__"]
__version__ = "0.1.0"

EXE = ".exe" if sys.platform == "win32" else ""
HOW_TO = (
    "zubra: no compiler found. `pip install zubra` on a platform with a prebuilt wheel includes one; "
    "otherwise download a binary from https://github.com/journey-to-code-org/zubra/releases and put "
    "it on the PATH, or set ZUBRA_COMPILER to its path."
)


def bundled_compiler() -> str | None:
    """The compiler inside this package (platform wheels), if there is one."""
    candidate = Path(__file__).resolve().parent / "bin" / f"zubra{EXE}"
    return str(candidate) if candidate.is_file() else None


def find_compiler() -> str | None:
    """`$ZUBRA_COMPILER`, then the bundled binary, then `zubra` on the PATH."""
    return os.environ.get("ZUBRA_COMPILER") or bundled_compiler() or shutil.which("zubra")


class ZubraError(RuntimeError):
    """The compiler's message: a component that doesn't compile, or one that doesn't exist."""


class Zubra:
    """A folder of components and the compiler process that renders them."""

    def __init__(self, components: str | os.PathLike, *, compiler: str | None = None, cache: bool = True):
        self.dir = Path(components)
        self.compiler = compiler or find_compiler()
        if not self.compiler:
            raise ZubraError(HOW_TO)
        self.cache = cache
        self._process: subprocess.Popen | None = None
        self._lock = threading.Lock()  # web servers use threads; one request line at a time
        atexit.register(self.close)
        self._sources: dict[str, str] | None = None
        self._css: dict[str, str] = {}
        self._js: dict[str, str] = {}

    @property
    def names(self) -> list[str]:
        """The components in the folder, by tag-like file name (`plot-map`)."""
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
        """One request to the compiler for component `name`; the output, or a ZubraError."""
        if name not in self.names:
            raise ZubraError(f"no component {name!r} in {self.dir}")
        body = {"path": f"/components/{name}.zb", "files": self._files(), **request}
        with self._lock:
            if self._process is None or self._process.poll() is not None:
                self._release()
                self._process = subprocess.Popen(
                    [self.compiler, "serve"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                )
            try:
                self._process.stdin.write(json.dumps(body) + "\n")
                self._process.stdin.flush()
                line = self._process.stdout.readline()
            except (BrokenPipeError, OSError):
                line = ""
        if not line:
            self._release()  # the next request starts a fresh one
            raise ZubraError(f"{self.compiler} serve stopped")
        response = json.loads(line)
        if not response["ok"]:
            raise ZubraError(response["error"])
        return response["output"]

    def html(self, name: str, props: dict, slots: dict[str, str] | None = None) -> str:
        """Component `name` as HTML for `props`; `slots` is markup your server already rendered.
        What only the browser can compute is left for the element to fill in."""
        return self.request(
            name, emit="html", props=props, slots=slots or {}, slotSource="html", partial=True
        )

    def css(self, name: str) -> str:
        """The component's scoped CSS, including that of the components it imports."""
        if name not in self._css or not self.cache:
            self._css[name] = self.request(name, emit="css")
        return self._css[name]

    def js(self, name: str, runtime: str = "@zubra/runtime") -> str:
        """The module that defines the component's custom element (serve it as `/components/<name>.js`)."""
        key = f"{name}\0{runtime}"
        if key not in self._js or not self.cache:
            self._js[key] = self.request(name, emit="js", runtime=runtime)
        return self._js[key]

    def _release(self) -> None:
        process, self._process = self._process, None
        if process is not None:
            for pipe in (process.stdin, process.stdout):
                try:
                    pipe.close()
                except OSError:
                    pass
            process.wait()

    def close(self) -> None:
        """Stop the compiler process (it also stops when this process exits)."""
        process = self._process
        if process is not None:
            try:
                process.stdin.close()  # end of input: `zubra serve` exits
                process.wait(timeout=5)
            except Exception:
                process.kill()
            self._release()

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
        """The CSS of every component the page rendered (and what they import)."""
        return "\n".join(self.zubra.css(name) for name in self.modules)

    def head(self) -> str:
        """`<style data-zb-components>…</style>`, for the layout's `<head>`; empty if nothing rendered."""
        return f"<style data-zb-components>{self.styles()}</style>" if self.modules else ""

    def scripts(self, base: str = "/components/") -> str:
        """The `<script type="module">` that loads each rendered component from `{base}<name>.js`,
        for the end of `<body>`. Empty if nothing rendered. (The page works without it.)"""
        if not self.modules:
            return ""
        imports = "".join(f"    import '{_html.escape(base, quote=True)}{name}.js';\n" for name in self.modules)
        return f'<script type="module">\n{imports}  </script>'
