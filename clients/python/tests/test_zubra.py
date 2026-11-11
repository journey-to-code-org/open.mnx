"""The package against the real compiler: ZUBRA_COMPILER, or the repository's `cargo build`.

    python -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE.parent / "scripts"))

import zubra  # noqa: E402
from zubra import Zubra, ZubraError  # noqa: E402

REPO = HERE.parents[2]


def compiler() -> str:
    if os.environ.get("ZUBRA_COMPILER"):
        return os.environ["ZUBRA_COMPILER"]
    for build in ("debug", "release"):
        candidate = REPO / "target" / build / "zubra"
        if candidate.is_file():
            return str(candidate)
    raise unittest.SkipTest("no compiler: `cargo build` in the repository, or set ZUBRA_COMPILER")


BADGE = '<style>span { color: red; }</style>\n<x-badge label="none"><span>{label}</span></x-badge>\n'
CARD = (
    "<script>\n  import './badge.zb'\n</script>\n"
    "<style>section { padding: 1rem; }</style>\n"
    '<x-card title="Untitled"><section><h2>{title}</h2><x-badge label={title}></x-badge></section></x-card>\n'
)


class Components(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / "badge.zb").write_text(BADGE)
        (self.dir / "card.zb").write_text(CARD)
        self.zubra = Zubra(self.dir, compiler=compiler())
        self.addCleanup(self.zubra.close)

    def test_renders_with_props_and_resolves_imports_without_the_disk_being_read_by_the_compiler(self):
        html = self.zubra.page().render("card", title="Hello")
        self.assertIn("<h2>Hello</h2>", html)
        self.assertIn("<span>Hello</span>", html)  # the imported component, with the prop passed down

    def test_escapes_props(self):
        self.assertIn("<h2>&lt;b&gt;&amp;</h2>", self.zubra.page().render("card", title="<b>&"))

    def test_slots_take_html_the_server_rendered(self):
        (self.dir / "box.zb").write_text("<x-box><div><zb-slot></zb-slot></div></x-box>\n")
        html = self.zubra.page().render("box", _slots={"default": "<p>{kept}</p>"})
        self.assertIn("<p>{kept}</p>", html)

    def test_css_includes_what_the_component_imports(self):
        css = self.zubra.css("card")
        self.assertIn("padding: 1rem", css)
        self.assertIn("color: red", css)

    def test_js_names_the_runtime_and_children(self):
        js = self.zubra.js("card")
        self.assertIn('"@zubra/runtime"', js)
        self.assertIn("badge", js)
        self.assertIn("/vendor/zubra/index.js", self.zubra.js("card", runtime="/vendor/zubra/index.js"))
        self.assertNotIn('"@zubra/runtime"', self.zubra.js("card", runtime="/vendor/zubra/index.js"))

    def test_names(self):
        self.assertEqual(self.zubra.names, ["badge", "card"])

    def test_a_component_that_does_not_compile_raises_with_the_compilers_message(self):
        (self.dir / "bad.zb").write_text("<x-bad><p>{missing}</p></x-bad>\n")
        zubra_fresh = Zubra(self.dir, compiler=compiler(), cache=False)
        self.addCleanup(zubra_fresh.close)
        with self.assertRaises(ZubraError) as raised:
            zubra_fresh.page().render("bad")
        self.assertIn("missing", str(raised.exception))
        # The process survives an error: the next render works.
        self.assertIn("<h2>ok</h2>", zubra_fresh.page().render("card", title="ok"))

    def test_an_unknown_component_is_a_zubra_error(self):
        with self.assertRaisesRegex(ZubraError, "no component 'nope'"):
            self.zubra.page().render("nope")

    def test_cache_off_sees_edits(self):
        fresh = Zubra(self.dir, compiler=compiler(), cache=False)
        self.addCleanup(fresh.close)
        self.assertIn("<h2>a</h2>", fresh.page().render("card", title="a"))
        (self.dir / "card.zb").write_text(CARD.replace("<h2>", "<h3>").replace("</h2>", "</h3>"))
        self.assertIn("<h3>a</h3>", fresh.page().render("card", title="a"))

    def test_cache_on_keeps_what_it_read(self):
        self.zubra.page().render("card", title="a")
        (self.dir / "card.zb").write_text(CARD.replace("<h2>", "<h3>"))
        self.assertIn("<h2>a</h2>", self.zubra.page().render("card", title="a"))

    def test_restarts_the_compiler_if_it_died(self):
        self.zubra.page().render("card", title="a")
        self.zubra._process.kill()
        self.zubra._process.wait()
        self.assertIn("<h2>b</h2>", self.zubra.page().render("card", title="b"))

    def test_what_only_the_browser_computes_is_left_for_it(self):
        (self.dir / "now.zb").write_text('<script>const now = Date.now()</script>\n<x-now a="x"><p>{a}</p><p>{now}</p></x-now>\n')
        html = self.zubra.page().render("now")
        self.assertIn("<p>x</p>", html)
        self.assertIn("<p></p>", html)

    def test_css_with_the_cache_off_sees_edits(self):
        fresh = Zubra(self.dir, compiler=compiler(), cache=False)
        self.addCleanup(fresh.close)
        self.assertIn("color: red", fresh.css("badge"))
        (self.dir / "badge.zb").write_text(BADGE.replace("red", "blue"))
        self.assertIn("color: blue", fresh.css("badge"))

    def test_threads_share_one_process(self):
        results: list[str] = []
        errors: list[BaseException] = []

        def work(n: int):
            try:
                results.append(self.zubra.page().render("card", title=f"t{n}"))
            except BaseException as error:  # noqa: BLE001
                errors.append(error)

        threads = [threading.Thread(target=work, args=(n,)) for n in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(sorted(f"t{n}" for n in range(12)), sorted(
            next(f"t{n}" for n in range(12) if f"<h2>t{n}</h2>" in html) for html in results
        ))


# A stand-in for `zubra serve`, to make the compiler misbehave on cue. It answers each request
# line with its `props.title` as the output; a title of "slow" takes a second, "garbage" answers
# with a line that isn't JSON, and "die" exits without answering.
FAKE_SERVE = """#!{python}
import json, sys, time
for line in sys.stdin:
    title = json.loads(line).get("props", {{}}).get("title", "")
    if title == "slow":
        time.sleep(1)
    if title == "die":
        sys.exit(3)
    print("not json at all" if title == "garbage" else json.dumps({{"ok": True, "output": title}}), flush=True)
"""


class WhenTheCompilerMisbehaves(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / "card.zb").write_text(CARD)
        (self.dir / "badge.zb").write_text(BADGE)
        self.fake = self.dir / "fake-zubra"
        self.fake.write_text(FAKE_SERVE.format(python=sys.executable))
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)

    def zubra(self, **options) -> Zubra:
        made = Zubra(self.dir, compiler=str(self.fake), **options)
        self.addCleanup(made.close)
        return made

    def ask(self, zubra: Zubra, title: str) -> str:
        return zubra.html("card", {"title": title})

    def test_a_request_that_times_out_does_not_leave_its_answer_for_the_next_one(self):
        zubra = self.zubra(timeout=0.2)
        self.assertEqual(self.ask(zubra, "first"), "first")
        with self.assertRaisesRegex(ZubraError, r"didn't answer 'card' within 0\.2s"):
            self.ask(zubra, "slow")
        # The slow answer was still on its way. The next caller must get its own.
        for title in ("second", "third"):
            self.assertEqual(self.ask(zubra, title), title)

    def test_an_interrupted_request_does_not_leave_its_answer_for_the_next_one(self):
        # A thread interrupted between sending the request and reading the answer (Ctrl-C in a
        # dev server, a worker timeout that raises into the thread).
        zubra = self.zubra()
        self.assertEqual(self.ask(zubra, "first"), "first")
        lines = zubra._lines
        original = lines.get

        def interrupted(*args, **kwargs):
            lines.get = original
            raise KeyboardInterrupt

        lines.get = interrupted
        with self.assertRaises(KeyboardInterrupt):
            self.ask(zubra, "lost")
        self.assertFalse(zubra._lock.locked())
        for title in ("second", "third"):
            self.assertEqual(self.ask(zubra, title), title)

    def test_no_timeout_waits(self):
        zubra = self.zubra(timeout=None)
        self.assertEqual(self.ask(zubra, "slow"), "slow")

    def test_an_answer_that_is_not_json_is_a_zubra_error_and_the_next_request_works(self):
        zubra = self.zubra()
        with self.assertRaisesRegex(ZubraError, "isn't JSON: 'not json at all"):
            self.ask(zubra, "garbage")
        self.assertEqual(self.ask(zubra, "after"), "after")

    def test_a_compiler_that_exits_mid_request_is_a_zubra_error_and_the_next_request_works(self):
        zubra = self.zubra()
        with self.assertRaisesRegex(ZubraError, "serve stopped"):
            self.ask(zubra, "die")
        self.assertEqual(self.ask(zubra, "after"), "after")

    def test_a_compiler_that_is_not_there_or_cannot_run_says_how_to_get_one(self):
        missing = Zubra(self.dir, compiler=str(self.dir / "nope" / "zubra"))
        with self.assertRaisesRegex(ZubraError, r"can't run the compiler at .*nope.*releases"):
            self.ask(missing, "x")
        not_executable = self.dir / "plain-file"
        not_executable.write_text("not a program")
        with self.assertRaisesRegex(ZubraError, "can't run the compiler at .*plain-file"):
            self.ask(Zubra(self.dir, compiler=str(not_executable)), "x")
        # And it's still a ZubraError the second time: nothing was left half started.
        with self.assertRaises(ZubraError):
            self.ask(missing, "x")

    def test_many_threads_through_failures_each_get_their_own_answer(self):
        zubra = self.zubra(timeout=5)
        results: dict[str, str] = {}
        errors: list[BaseException] = []

        def work(title: str):
            try:
                results[title] = self.ask(zubra, title)
            except ZubraError:
                results[title] = "error"
            except BaseException as error:  # noqa: BLE001
                errors.append(error)

        titles = [f"t{n}" for n in range(10)] + ["die", "garbage"] + [f"u{n}" for n in range(10)]
        threads = [threading.Thread(target=work, args=(title,)) for title in titles]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        for title in titles:
            self.assertEqual(results[title], "error" if title in ("die", "garbage") else title)

    def test_close_can_be_called_twice_and_a_closed_zubra_starts_again(self):
        zubra = self.zubra()
        self.assertEqual(self.ask(zubra, "a"), "a")
        zubra.close()
        zubra.close()
        self.assertIsNone(zubra._process)
        self.assertEqual(self.ask(zubra, "b"), "b")


class Pages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        (Path(self.tmp.name) / "badge.zb").write_text(BADGE)
        (Path(self.tmp.name) / "card.zb").write_text(CARD)
        self.zubra = Zubra(self.tmp.name, compiler=compiler())
        self.addCleanup(self.zubra.close)

    def test_a_page_records_what_it_rendered_once_in_order(self):
        page = self.zubra.page()
        page.render("card", title="a")
        page.render("badge", label="b")
        page.render("card", title="c")
        self.assertEqual(page.modules, ["card", "badge"])
        self.assertEqual(self.zubra.page().modules, [])

    def test_head_and_scripts(self):
        page = self.zubra.page()
        self.assertEqual((page.head(), page.scripts()), ("", ""))
        page.render("card", title="a")
        self.assertTrue(page.head().startswith("<style data-zb-components>"))
        self.assertIn("padding: 1rem", page.head())
        self.assertIn("import '/components/card.js';", page.scripts())
        self.assertIn("import '/static/c/card.js';", page.scripts("/static/c/"))
        self.assertTrue(page.scripts().startswith('<script type="module">'))
        self.assertIn("&#x27;", page.scripts("/a'b/"))
        self.assertNotIn("a'b", page.scripts("/a'b/"))


class FindingTheCompiler(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {k: os.environ.get(k) for k in ("ZUBRA_COMPILER", "PATH")}
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v) for k, v in self.env.items()])

    def fake(self, directory: Path, name="zubra") -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        path.write_text("#!/bin/sh\n")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def test_the_environment_wins_then_the_bundle_then_the_path(self):
        tmp = Path(self.tmp.name)
        on_path = self.fake(tmp / "path")
        os.environ["PATH"] = str(tmp / "path")
        os.environ.pop("ZUBRA_COMPILER", None)
        original = zubra.bundled_compiler
        self.addCleanup(lambda: setattr(zubra, "bundled_compiler", original))
        zubra.bundled_compiler = lambda: None
        self.assertEqual(zubra.find_compiler(), str(on_path))
        bundled = self.fake(tmp / "bundle")
        zubra.bundled_compiler = lambda: str(bundled)
        self.assertEqual(zubra.find_compiler(), str(bundled))
        os.environ["ZUBRA_COMPILER"] = "/somewhere/zubra"
        self.assertEqual(zubra.find_compiler(), "/somewhere/zubra")

    def test_no_compiler_says_how_to_get_one(self):
        os.environ.pop("ZUBRA_COMPILER", None)
        os.environ["PATH"] = self.tmp.name
        original = zubra.bundled_compiler
        self.addCleanup(lambda: setattr(zubra, "bundled_compiler", original))
        zubra.bundled_compiler = lambda: None
        with self.assertRaisesRegex(zubra.ZubraError, "releases"):
            Zubra(self.tmp.name)


class Jinja(unittest.TestCase):
    def setUp(self):
        try:
            import jinja2
        except ImportError:
            self.skipTest("jinja2 is not installed")
        self.jinja2 = jinja2
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        (Path(self.tmp.name) / "badge.zb").write_text(BADGE)
        (Path(self.tmp.name) / "card.zb").write_text(CARD)
        self.zubra = Zubra(self.tmp.name, compiler=compiler())
        self.addCleanup(self.zubra.close)

    def test_templates_render_components_and_the_layout_gets_their_assets(self):
        from zubra.jinja import install

        environment = self.jinja2.Environment(autoescape=True)
        pages: list = []
        install(environment, self.zubra, page=lambda: pages[-1])
        pages.append(self.zubra.page())
        body = environment.from_string("{{ zubra('card', title='<hi>') }}").render()
        layout = environment.from_string("<head>{{ zubra_head() }}</head>{{ body }}{{ zubra_scripts() }}").render(body=self.jinja2.utils.markupsafe.Markup(body))
        # Autoescape didn't escape the component's markup, and the user's value is escaped once.
        self.assertIn("<h2>&lt;hi&gt;</h2>", layout)
        self.assertNotIn("&lt;h2&gt;", layout)
        self.assertIn("<style data-zb-components>", layout)
        self.assertIn("import '/components/card.js';", layout)

    def test_each_request_gets_its_own_page(self):
        from zubra.jinja import install

        environment = self.jinja2.Environment(autoescape=True)
        current: list = []
        install(environment, self.zubra, page=lambda: current[0])
        for _ in range(2):
            current[:] = [self.zubra.page()]
            environment.from_string("{{ zubra('badge', label='x') }}").render()
            self.assertEqual(current[0].modules, ["badge"])


class Wheels(unittest.TestCase):
    def test_a_platform_wheel_carries_the_binary_and_is_found_by_the_package(self):
        import build_wheel

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            binary = tmp / "zubra"
            binary.write_bytes(Path(compiler()).read_bytes())
            machine = "aarch64" if os.uname().machine in ("aarch64", "arm64") else "x86_64"
            wheel = build_wheel.build(binary.read_bytes(), f"{machine}-unknown-linux-musl", tmp / "dist")
            self.assertEqual(wheel.name, f"zubra-0.1.0-py3-none-manylinux_2_17_{machine}.manylinux2014_{machine}.musllinux_1_1_{machine}.whl")
            with zipfile.ZipFile(wheel) as bundle:
                names = bundle.namelist()
                self.assertIn("zubra/__init__.py", names)
                self.assertIn("zubra/jinja.py", names)
                self.assertIn("zubra/bin/zubra", names)
                self.assertIn("zubra-0.1.0.dist-info/RECORD", names)
                self.assertEqual(bundle.getinfo("zubra/bin/zubra").external_attr >> 16 & 0o777, 0o755)
                # One Tag line per platform in the name: an old glibc, and musl.
                tags = [line for line in bundle.read("zubra-0.1.0.dist-info/WHEEL").decode().splitlines() if line.startswith("Tag: ")]
                self.assertEqual(tags, [f"Tag: py3-none-manylinux_2_17_{machine}", f"Tag: py3-none-manylinux2014_{machine}", f"Tag: py3-none-musllinux_1_1_{machine}"])
                # RECORD lists every file with a hash.
                record = bundle.read("zubra-0.1.0.dist-info/RECORD").decode().splitlines()
                self.assertEqual(len(record), len(names))
                self.assertTrue(all("sha256=" in line for line in record if not line.endswith("RECORD,,")))
            # Installed the way pip installs it (which keeps the executable bit).
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "--no-deps", "--no-index",
                 "--disable-pip-version-check", "--target", str(tmp / "site"), str(wheel)],
                check=True,
            )
            # Imported from where it was installed, the package finds the compiler inside it.
            code = "import zubra; print(zubra.bundled_compiler()); print(zubra.find_compiler())"
            env = {k: v for k, v in os.environ.items() if k != "ZUBRA_COMPILER"}
            env["PATH"] = "/nonexistent"
            out = subprocess.run([sys.executable, "-c", code], cwd=tmp / "site", env=env, capture_output=True, text=True, check=True)
            lines = out.stdout.split()
            self.assertEqual(lines[0], lines[1])
            self.assertTrue(lines[0].endswith("zubra/bin/zubra"))
            self.assertTrue(os.access(lines[0], os.X_OK))

    def test_the_target_comes_from_the_archive_name(self):
        import build_wheel

        self.assertEqual(build_wheel.target_of("zubra-5.4.0-aarch64-apple-darwin.tar.gz"), "aarch64-apple-darwin")
        self.assertEqual(build_wheel.target_of("zubra-5.4.0-x86_64-pc-windows-msvc.zip"), "x86_64-pc-windows-msvc")
        with self.assertRaises(SystemExit):
            build_wheel.target_of("zubra-5.4.0-riscv64.tar.gz")

    def test_every_release_target_has_a_platform_tag(self):
        import build_wheel

        # The targets the release workflow builds: each has a wheel, or is covered by one.
        workflow = (REPO / ".github" / "workflows" / "release.yml").read_text()
        import re
        targets = set(re.findall(r"\{ target: ([\w-]+),", workflow))
        self.assertEqual(len(targets), 7)
        self.assertEqual(targets, set(build_wheel.TAGS) | set(build_wheel.COVERED_BY))
        for covered, by in build_wheel.COVERED_BY.items():
            self.assertIn(by, build_wheel.TAGS, covered)
        # No Linux wheel asks for a glibc newer than manylinux2014's: the static builds need none.
        for target, tag in build_wheel.TAGS.items():
            if "linux" in target:
                self.assertIn("manylinux_2_17_", tag)
                self.assertIn("musllinux_1_1_", tag)
                self.assertNotIn("manylinux_2_35", tag)

    def test_a_glibc_archive_is_refused_with_the_archive_to_use(self):
        import build_wheel

        with self.assertRaisesRegex(SystemExit, "x86_64-unknown-linux-musl archive"):
            build_wheel.target_of("zubra-5.4.0-x86_64-unknown-linux-gnu.tar.gz")

    def test_a_windows_wheel_names_the_exe(self):
        import build_wheel

        with tempfile.TemporaryDirectory() as tmp:
            wheel = build_wheel.build(b"MZ", "x86_64-pc-windows-msvc", Path(tmp))
            self.assertTrue(wheel.name.endswith("-win_amd64.whl"))
            with zipfile.ZipFile(wheel) as bundle:
                self.assertIn("zubra/bin/zubra.exe", bundle.namelist())

    def test_a_wheel_built_from_a_release_archive(self):
        import build_wheel

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            archive = subprocess.run(
                [str(REPO / "scripts" / "package-binary.sh"), "host", "5.4.0"],
                env={**os.environ, "ZUBRA_PROFILE": "debug"}, capture_output=True, text=True,
            )
            if archive.returncode != 0:
                self.skipTest("no built binary to archive")
            path = Path(archive.stdout.strip())
            self.addCleanup(path.unlink)
            # The host's archive is a glibc build, which gets no wheel of its own (see TAGS); the
            # binary is read out of it the same way, so build the wheel for the static target.
            machine = "aarch64" if os.uname().machine in ("aarch64", "arm64") else "x86_64"
            wheel = build_wheel.build(build_wheel.binary_from(path), f"{machine}-unknown-linux-musl", tmp)
            with zipfile.ZipFile(wheel) as bundle:
                # The binary in the archive, which is the debug build the archive was made from.
                self.assertEqual(bundle.read("zubra/bin/zubra"), (REPO / "target" / "debug" / "zubra").read_bytes())


if __name__ == "__main__":
    unittest.main()
