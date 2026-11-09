"""Carbonara's local server for editing hierarchies stored in workbooks."""
import argparse
import json
import os
import re
import tempfile
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent
FOLDER = ROOT / 'hierarchy'
PREFERENCE = ROOT / '.recent.json'
SAMPLE = FOLDER / 'sample_hierarchy.xlsx'
COLORS = ['#4F79B8', '#31977D', '#8B6AB4', '#D49B38', '#D16970']
FOLDER.mkdir(exist_ok=True)


def empty_state():
    return {'layers': [{'name': f'Layer{i+1}', 'color': COLORS[i]} for i in range(3)], 'nodes': []}


def validate(data):
    layers, nodes = data.get('layers'), data.get('nodes')
    if not isinstance(layers, list) or not 1 <= len(layers) <= 5 or not isinstance(nodes, list):
        raise ValueError('A hierarchy must have 1–5 layers and a list of items.')
    names = []
    for layer in layers:
        name = str(layer.get('name', '')).strip()
        if not name or len(name) > 31 or re.search(r'[\[\]:*?/\\]', name) or name.lower() in ('summary', '_hierarchy'):
            raise ValueError('Layer names must be 1–31 characters and valid Excel sheet names.')
        if name.casefold() in names:
            raise ValueError('Layer names must be unique.')
        names.append(name.casefold())
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', str(layer.get('color', ''))):
            raise ValueError('Choose a valid color for each layer.')
    uids, ids = {}, set()
    for node in nodes:
        level = node.get('level')
        uid = str(node.get('uid', ''))
        identifier = str(node.get('id', '')).strip()
        if not uid or uid in uids or not isinstance(level, int) or not 0 <= level < len(layers):
            raise ValueError('An item has an invalid layer or duplicate internal ID.')
        if not identifier or (level, identifier.casefold()) in ids:
            raise ValueError('Every item needs an ID unique within its layer.')
        if not str(node.get('name_en', '')).strip():
            raise ValueError('Every item needs an English name.')
        uids[uid] = node
        ids.add((level, identifier.casefold()))
    for node in nodes:
        parent = node.get('parent', '')
        if node['level'] == 0 and parent:
            raise ValueError('Items in the first layer cannot have a parent.')
        if node['level'] > 0 and not parent and node.get('active', True):
            raise ValueError('Connect every active item to a parent in the preceding layer before saving.')
        if node['level'] > 0 and parent and (parent not in uids or uids[parent]['level'] != node['level'] - 1):
            raise ValueError('Each item must have a parent in the preceding layer.')
    return data


def write_workbook(data, path):
    validate(data)
    wb = Workbook()
    summary = wb.active
    summary.title = 'summary'
    layers, nodes = data['layers'], data['nodes']
    summary.append(['item_id'] + [f"{x['name']}_th" for x in layers] + [f"{x['name']}_en" for x in layers])
    children = {}
    for node in nodes:
        children.setdefault(node.get('parent', ''), []).append(node)
    def visit(node, chain):
        chain = chain + [node]
        descendants = children.get(node['uid'], [])
        if not descendants:
            summary.append([str(node['id'])] + [str(chain[i].get('name_th', '')) if i < len(chain) else '' for i in range(len(layers))] + [str(chain[i].get('name_en', '')) if i < len(chain) else '' for i in range(len(layers))])
        for child in descendants:
            visit(child, chain)
    for root in children.get('', []):
        if root['level'] == 0: visit(root, [])
    lookup = {n['uid']: n for n in nodes}
    for index, layer in enumerate(layers):
        ws = wb.create_sheet(layer['name'])
        ws.append(['id', 'parent_id', 'name_th', 'name_en', 'definition', 'remark', 'is_active'])
        for n in nodes:
            if n['level'] == index:
                parent = lookup.get(n.get('parent', ''))
                ws.append([str(n['id']), str(parent['id']) if parent else '', str(n.get('name_th', '')), str(n.get('name_en', '')), str(n.get('definition', '')), str(n.get('remark', '')), int(bool(n.get('active', True)))])
        ws.sheet_properties.tabColor = layer['color'][1:]
    meta = wb.create_sheet('_hierarchy')
    meta.append(['version', 1])
    meta.append(['layer', 'color'])
    for layer in layers:
        meta.append([layer['name'], layer['color']])
    meta.sheet_state = 'hidden'
    for ws in [summary] + [wb[x['name']] for x in layers]:
        # User-entered names and IDs are data, even when they begin with '='.
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                if cell.data_type == 'f': cell.data_type = 's'
        ws.freeze_panes = 'A2'
        ws.auto_filter.ref = ws.dimensions
        for cell in ws[1]:
            cell.font = Font(bold=True, color='FFFFFF')
            cell.fill = PatternFill('solid', fgColor='345577')
        for col in range(1, ws.max_column + 1):
            ws.column_dimensions[get_column_letter(col)].width = min(36, max(16, len(str(ws.cell(1, col).value or '')) + 3))
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix='.xlsx', dir=path.parent)
    os.close(fd)
    try:
        wb.save(tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def read_workbook(path):
    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        if '_hierarchy' not in wb or 'summary' not in wb:
            raise ValueError('Choose a Carbonara workbook or start with the downloadable template.')
        rows = list(wb['_hierarchy'].values)
        layers = [{'name': str(r[0]), 'color': str(r[1])} for r in rows[2:] if r[0]]
        nodes, index = [], {}
        for level, layer in enumerate(layers):
            if layer['name'] not in wb: raise ValueError('A layer sheet is missing.')
            sheet = iter(wb[layer['name']].values)
            header = next(sheet, ())
            expected = ('id', 'parent_id', 'name_th', 'name_en', 'definition', 'remark', 'is_active')
            if tuple(header[:7]) != expected: raise ValueError(f"Invalid columns in {layer['name']}.")
            for row in sheet:
                row = list(row) + [None] * 7
                if row[0] is None: continue
                ident = str(row[0]).strip()
                uid = f'{level}:{ident}'
                parent_id = str(row[1]).strip() if row[1] is not None else ''
                parent = index.get((level-1, parent_id), '') if level else ''
                if level and parent_id and not parent: raise ValueError(f'Parent {parent_id!r} for {ident!r} was not found.')
                node = {'uid': uid, 'level': level, 'id': ident, 'parent': parent, 'name_th': str(row[2] or ''), 'name_en': str(row[3] or ''), 'definition': str(row[4] or ''), 'remark': str(row[5] or ''), 'active': str(row[6]).strip().lower() not in ('0', 'false', 'no')}
                nodes.append(node)
                index[(level, ident)] = uid
        return validate({'layers': layers, 'nodes': nodes})
    finally:
        wb.close()


def remember(path):
    PREFERENCE.write_text(json.dumps({'path': str(path)}, ensure_ascii=False), encoding='utf-8')


def recent():
    try: return Path(json.loads(PREFERENCE.read_text(encoding='utf-8'))['path'])
    except (OSError, ValueError, KeyError, TypeError): return None


def absolute_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError('Enter a full path.')
    return path.resolve()


def browse_folder(path):
    entries = []
    for entry in path.iterdir():
        if entry.is_dir():
            entries.append({'name': entry.name, 'path': str(entry), 'directory': True})
        elif entry.suffix.lower() == '.xlsx' and not entry.name.startswith('~$') and entry.is_file():
            entries.append({'name': entry.name, 'path': str(entry), 'directory': False})
    entries.sort(key=lambda entry: (not entry['directory'], entry['name'].casefold()))
    return {'path': str(path), 'parent': str(path.parent) if path.parent != path else '', 'entries': entries}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT), **kwargs)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def reply(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/start':
            selected = recent()
            first_start = selected is None and SAMPLE.is_file()
            if first_start: selected = SAMPLE.resolve()
            files = sorted(p.name for p in FOLDER.glob('*.xlsx') if not p.name.startswith('~$'))
            result = {'files': files, 'path': str(selected) if selected else '', 'state': empty_state(), 'message': ''}
            if selected:
                if selected.is_file():
                    try:
                        result['state'] = read_workbook(selected)
                        result['saved_at'] = selected.stat().st_mtime
                        if first_start: remember(selected)
                    except Exception as e: result['message'] = f'Could not open recent workbook: {e}'
                else: result['message'] = 'The recent workbook was moved or is unavailable. Start a new hierarchy or open another file.'
            self.reply(result)
        elif path == '/api/template':
            with tempfile.TemporaryDirectory(dir=FOLDER) as temp:
                target = Path(temp) / 'hierarchy_template.xlsx'
                write_workbook(empty_state(), target)
                content = target.read_bytes()
            self.send_response(200); self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); self.send_header('Content-Disposition', 'attachment; filename="hierarchy_template.xlsx"'); self.send_header('Content-Length', str(len(content))); self.end_headers(); self.wfile.write(content)
        elif path.startswith('/api/'): self.reply({'error': 'Not found'}, 404)
        else: super().do_GET()
    def do_POST(self):
        try:
            if self.path in ('/api/browse', '/api/open'):
                port = self.server.server_port
                if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
                    return self.reply({'error': 'Open Carbonara from its local address.'}, 403)
                if self.headers.get_content_type() != 'application/json':
                    return self.reply({'error': 'Expected a JSON request.'}, 415)
            size = int(self.headers.get('Content-Length', '0'))
            if size > 10_000_000: raise ValueError('Request is too large.')
            data = json.loads(self.rfile.read(size) or b'{}')
            if self.path == '/api/browse':
                path = absolute_path(data['path']) if data.get('path') else FOLDER
                self.reply(browse_folder(path))
            elif self.path == '/api/open':
                if data.get('path'):
                    target = absolute_path(data['path'])
                else:
                    target = (FOLDER / str(data.get('name', ''))).resolve()
                    if target.parent != FOLDER.resolve(): raise ValueError('Invalid file name.')
                if target.suffix.lower() != '.xlsx' or not target.is_file():
                    raise ValueError('Choose an existing .xlsx workbook.')
                state = read_workbook(target)
                remember(target)
                self.reply({'path': str(target), 'state': state, 'saved_at': target.stat().st_mtime})
            elif self.path == '/api/generate':
                if data.get('new'):
                    name = str(data.get('name', '')).strip()
                    if name.lower().endswith('.xlsx'): name = name[:-5]
                    if not name or name in ('.', '..') or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith(('.', ' ')):
                        raise ValueError('Enter a valid file name.')
                    target = FOLDER / (name + '.xlsx')
                    if target.exists(): raise ValueError('A file with that name already exists. Open it to overwrite it.')
                else:
                    target = recent()
                    if not target or not target.is_file() or str(target) != data.get('path'):
                        raise ValueError('The opened file is unavailable. Create a new hierarchy or open another file.')
                write_workbook(data['state'], target)
                remember(target.resolve())
                self.reply({'path': str(target.resolve()), 'saved_at': target.stat().st_mtime})
            else: self.reply({'error': 'Not found'}, 404)
        except Exception as e: self.reply({'error': str(e)}, 400)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-browser', action='store_true', help='Start without opening a browser window.')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', 8766), Handler)
    url = 'http://127.0.0.1:8766/'
    print(f'Carbonara is running at {url}', flush=True)
    if not args.no_browser:
        browser = threading.Timer(0.8, webbrowser.open, args=(url,))
        browser.daemon = True
        browser.start()
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
