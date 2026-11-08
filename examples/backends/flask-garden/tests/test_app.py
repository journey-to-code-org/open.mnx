"""The garden in Chromium, with JavaScript off (the server's HTML alone) and on (hydrated).

    python -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import threading
import unittest

from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

from garden import create_app
from garden.store import Store


class Garden(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        cls.server = make_server("127.0.0.1", 0, create_app(store=cls.store), threaded=True)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()

    def setUp(self):
        self.store.reset()
        self.errors: list[str] = []

    def open(self, path: str, *, javascript: bool = True):
        context = self.browser.new_context(java_script_enabled=javascript)
        self.addCleanup(context.close)
        page = context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        # (A 422 for a form with errors is the app's answer, not a page error.)
        page.on("console", lambda message: message.type in ("error", "warning") and "status of 422" not in message.text and self.errors.append(message.text))
        page.goto(self.url + path)
        if javascript:
            page.wait_for_function(
                "[...document.querySelectorAll(':not(:defined)')].filter((e) => e.localName.includes('-')).length === 0"
            )
        return page

    def shot(self, page, name: str):
        """The demo gallery's screenshot (demos/shots/), when ZUBRA_SHOTS names the folder."""
        folder = os.environ.get("ZUBRA_SHOTS")
        if not folder:
            return
        page.set_viewport_size({"width": 1280, "height": 800})
        page.emulate_media(color_scheme="light")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(folder, f"{name}.jpg"), type="jpeg", quality=80)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def test_without_javascript_signing_up_works_and_errors_keep_what_was_typed(self):
        page = self.open("/plots/B1", javascript=False)
        self.assertEqual(page.locator("crop-picker legend small").text_content(), "0 of 3")
        # Too many crops and no name: the server says so, and the form keeps the choices.
        page.fill("input[name=email]", "mo@example.org")
        for crop in ("Kale", "Beans", "Herbs", "Garlic"):
            page.get_by_label(crop).check()
        page.get_by_role("button", name="Reserve plot B1").click()
        self.assertEqual(page.locator(".error").all_text_contents(), ["Your name, please.", "Pick between 1 and 3 crops."])
        self.assertEqual(page.locator("crop-picker input:checked").count(), 4)
        self.assertEqual(page.locator("crop-picker legend small").text_content(), "4 of 3")
        self.assertEqual(page.input_value("input[name=email]"), "mo@example.org")
        page.fill("input[name=name]", "Mo Ali")
        page.get_by_label("Garlic").uncheck()
        page.fill("input[name=household]", "3")
        page.get_by_role("button", name="Reserve plot B1").click()
        self.assertIn("It's yours", page.locator(".notice").text_content())
        reservation = self.store.db.execute("select * from reservations where plot = 'B1'").fetchone()
        self.assertEqual((reservation["name"], reservation["crops"], reservation["household"]), ("Mo Ali", '["beans", "kale", "herbs"]', 3))
        # The plot map on the same page now shows it taken, and the stepper buttons never appeared.
        self.assertEqual(page.locator("plot-map a[href='/plots/B1'] status-pill").text_content().strip(), "taken")

    def test_without_javascript_a_taken_plot_offers_its_waitlist(self):
        page = self.open("/plots/A1", javascript=False)
        self.assertEqual(page.locator("h1 status-pill").text_content().strip(), "taken · 1 waiting")
        page.fill("input[name=name]", "Kim")
        page.fill("input[name=email]", "kim@example.org")
        page.get_by_label("Herbs").check()
        page.get_by_role("button", name="Join waitlist").click()
        self.assertEqual(page.locator(".notice").text_content(), "You're number 2 on the waitlist.")

    def test_with_javascript_the_crop_limit_disables_the_rest_and_the_stepper_appears(self):
        page = self.open("/plots/B1")
        for crop in ("Kale", "Beans", "Herbs"):
            page.get_by_label(crop).check()
        self.assertEqual(page.locator("crop-picker legend small").text_content(), "3 of 3")
        self.assertTrue(page.get_by_label("Garlic").is_disabled())
        self.assertFalse(page.get_by_label("Kale").is_disabled())
        page.get_by_label("Kale").uncheck()
        self.assertFalse(page.get_by_label("Garlic").is_disabled())
        # The number field's buttons exist only once it's live, and clamp to its range.
        page.get_by_role("button", name="More Household").click()
        page.get_by_role("button", name="More Household").click()
        self.assertEqual(page.input_value("input[name=household]"), "3")
        page.fill("input[name=household]", "8")
        self.assertTrue(page.get_by_role("button", name="More Household").is_disabled())
        page.fill("input[name=name]", "Mo")
        page.fill("input[name=email]", "mo@example.org")
        page.get_by_role("button", name="Reserve plot B1").click()
        page.wait_for_selector(".notice")
        self.assertEqual(self.store.db.execute("select household from reservations where plot = 'B1'").fetchone()[0], 8)

    def test_with_javascript_arrow_keys_move_around_the_plot_map(self):
        page = self.open("/")
        self.shot(page, "flask-garden")
        page.focus("plot-map a[href='/plots/A1']")
        page.keyboard.press("ArrowRight")
        page.keyboard.press("ArrowDown")
        self.assertEqual(page.evaluate("document.activeElement.getAttribute('href')"), "/plots/B2")
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("ArrowUp")
        self.assertEqual(page.evaluate("document.activeElement.getAttribute('href')"), "/plots/A1")
        page.keyboard.press("Enter")
        page.wait_for_url("**/plots/A1")
        self.assertEqual(page.get_attribute("plot-map a.selected", "aria-current"), "page")

    def test_the_chart_is_in_the_servers_html_and_logging_a_harvest_updates_it(self):
        page = self.open("/harvest", javascript=False)
        bars = page.locator("harvest-chart li")
        self.assertEqual(bars.count(), 6)
        self.assertEqual(page.get_attribute("harvest-chart li[data-crop=squash] .bar", "style"), "width: 100%")
        self.assertEqual(page.get_attribute("harvest-chart li[data-crop=kale] .bar", "aria-label"), "Kale: 3.5 kg")
        page.select_option("select[name=plot]", "B2")
        page.select_option("select[name=crop]", "kale")
        page.fill("input[name=kg]", "8")
        page.get_by_role("button", name="Log harvest").click()
        self.assertEqual(page.locator("harvest-chart li").first.get_attribute("data-crop"), "kale")
        self.assertEqual(page.locator("harvest-chart figcaption small").text_content(), "(34.5 kg)")
        # The plot just logged stays chosen (the app marks the <option selected> itself).
        self.assertEqual(page.input_value("select[name=plot]"), "B2")

    def test_hydration_keeps_the_servers_markup(self):
        # The page as the server sent it, and the same elements once hydrated: the same nodes.
        page = self.open("/plots/B1")
        same = page.evaluate(
            """async () => {
                const html = await (await fetch(location.href)).text();
                const server = new DOMParser().parseFromString(html, 'text/html');
                const text = (root) => [...root.querySelectorAll('crop-picker, number-field, plot-map')]
                    .map((element) => element.querySelector('fieldset, input, ul').textContent.replace(/\\s+/g, ' ').trim());
                return JSON.stringify(text(server)) === JSON.stringify(text(document));
            }"""
        )
        self.assertTrue(same)


if __name__ == "__main__":
    unittest.main()
