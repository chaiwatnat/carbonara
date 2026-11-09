"""Build the static Carbonara demo for GitHub Pages."""
import argparse
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ASSETS = (
    'app.js',
    'carbonara.png',
    'styles.css',
    'workbook.mjs',
    'vendor/xlsx.mini.min.js',
    'vendor/SHEETJS-LICENSE.txt',
)


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    for asset in ASSETS:
        target = output / asset
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / asset, target)

    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    html = html.replace('data-storage="local"', 'data-storage="browser"', 1)
    app_script = '<script type="module" src="app.js">'
    html = html.replace(app_script, '<script src="vendor/xlsx.mini.min.js"></script>\n' + app_script, 1)
    (output / 'index.html').write_text(html, encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    build(parser.parse_args().output)
