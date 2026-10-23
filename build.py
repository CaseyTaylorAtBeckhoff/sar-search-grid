"""Build the page: inline grid-core.js and util.js.

dist/sar-grid.html  -> body fragment for the claude.ai artifact (host adds the skeleton)
dist/index.html     -> standalone page for GitHub Pages or opening locally
"""
from pathlib import Path

here = Path(__file__).parent
src = (here / "index.src.html").read_text()
page = src.replace("/*__GRID_CORE__*/", (here / "grid-core.js").read_text()) \
          .replace("/*__UTIL__*/", (here / "util.js").read_text())

dist = here / "dist"
dist.mkdir(exist_ok=True)
(dist / "sar-grid.html").write_text(page)

skeleton_head = (
    '<!doctype html>\n<html lang="en">\n<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);'
    'padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}'
    'img{max-width:100%}[hidden]{display:none!important}</style>\n'
    '</head>\n<body>\n'
)
(dist / "index.html").write_text(skeleton_head + page + "\n</body>\n</html>\n")
print("built", [p.name for p in dist.iterdir()], len(page), "chars")
