#!/usr/bin/env python3
"""Generates screenshots of the src/ web UI for docs/usage.md.

Requires: pip install playwright && playwright install --with-deps chromium
Run from the repo root: python scripts/generate_screenshots.py
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX_HTML = ROOT / "src" / "index.html"
EXAMPLE_JSON = ROOT / "ros2_env_example.json"
OUT_DIR = ROOT / "docs" / "screenshots"

VIEWPORT = {"width": 1440, "height": 900}


def shot(page, name):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{name}.png"
    page.screenshot(path=str(path))
    print(f"saved {path.relative_to(ROOT)}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport=VIEWPORT)
        page.goto(INDEX_HTML.as_uri())

        # 1. Empty state / file picker overlay.
        page.wait_for_selector("#file-picker")
        shot(page, "01-open-file")

        # 2. Load the example snapshot.
        page.set_input_files("#data-file-input", str(EXAMPLE_JSON))
        page.wait_for_selector("#entity-list li")
        shot(page, "02-entity-list")

        # 3. Select an entity to show details + graph.
        page.click("#entity-list li")
        page.wait_for_selector("#cy canvas")
        page.wait_for_timeout(500)  # let the dagre layout settle
        shot(page, "03-details-and-graph")

        # 4. Increase graph depth.
        page.fill("#depth-slider", "3")
        page.dispatch_event("#depth-slider", "input")
        page.dispatch_event("#depth-slider", "change")
        page.wait_for_timeout(500)
        shot(page, "04-graph-depth")

        # 5. Switch to namespace coloring.
        page.click("#color-mode-toggle")
        page.wait_for_timeout(300)
        shot(page, "05-ns-colors")
        page.click("#color-mode-toggle")  # back to default for the next shot

        # 6. Dark theme.
        page.click("#theme-toggle")
        page.wait_for_timeout(300)
        shot(page, "06-dark-theme")

        browser.close()


if __name__ == "__main__":
    if not EXAMPLE_JSON.exists():
        sys.exit(f"missing {EXAMPLE_JSON}")
    main()
