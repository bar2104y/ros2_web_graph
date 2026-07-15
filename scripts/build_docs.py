#!/usr/bin/env python3
"""Renders docs/usage.md into a static docs/site/index.html page for Pages.

Requires: pip install markdown
Run from the repo root: python scripts/build_docs.py
"""
import pathlib

import markdown

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_MD = ROOT / "docs" / "usage.md"
OUT_DIR = ROOT / "docs" / "site"

TEMPLATE = """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ROS2 Analyzer — инструкция по использованию</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 900px;
         margin: 2rem auto; padding: 0 1.5rem; line-height: 1.55; color: #1c1c1c; }}
  img {{ max-width: 100%; border: 1px solid #ddd; border-radius: 6px; }}
  pre {{ background: #f5f5f5; padding: 0.75rem 1rem; overflow-x: auto; border-radius: 6px; }}
  code {{ background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 4px; }}
  pre code {{ background: none; padding: 0; }}
  h1, h2 {{ border-bottom: 1px solid #eee; padding-bottom: 0.3rem; }}
  table {{ border-collapse: collapse; }}
  th, td {{ border: 1px solid #ddd; padding: 0.4rem 0.7rem; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #1e1e1e; color: #ddd; }}
    pre, code {{ background: #2a2a2a; color: #eee; }}
    img {{ border-color: #444; }}
    th, td {{ border-color: #444; }}
  }}
</style>
</head>
<body>
{content}
</body>
</html>
"""


def main():
    text = SRC_MD.read_text(encoding="utf-8")
    html = markdown.markdown(text, extensions=["tables", "fenced_code"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "index.html").write_text(TEMPLATE.format(content=html), encoding="utf-8")

    screenshots_src = ROOT / "docs" / "screenshots"
    screenshots_dst = OUT_DIR / "screenshots"
    if screenshots_src.exists():
        import shutil
        shutil.copytree(screenshots_src, screenshots_dst, dirs_exist_ok=True)

    print(f"built {OUT_DIR / 'index.html'}")


if __name__ == "__main__":
    main()
