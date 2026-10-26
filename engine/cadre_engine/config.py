"""Cadre paths and constants. Works on macOS, Windows and Linux."""
import os
import sys

APP_NAME = 'Cadre'
APP_ID = 'cadre'
VERSION = '1.0.0'


def _data_root():
    if os.environ.get('CADRE_DATA'):
        return os.environ['CADRE_DATA']
    if sys.platform == 'darwin':
        return os.path.expanduser(f'~/Library/Application Support/{APP_NAME}')
    if sys.platform == 'win32':
        return os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), APP_NAME)
    return os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'), APP_ID)


ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # engine/
ROOT = os.path.dirname(ENGINE)                                            # repo (or the app's resources)
DATA = _data_root()
PROJECTS = os.path.join(DATA, 'projects')
STYLES = os.path.join(DATA, 'styles')
PEOPLE = os.path.join(DATA, 'people')
CACHE = os.path.join(DATA, 'cache')
MODELS = os.path.join(DATA, 'models')
for _d in (DATA, PROJECTS, STYLES, PEOPLE, CACHE, MODELS):
    os.makedirs(_d, exist_ok=True)

WEB_DIST = os.environ.get('CADRE_WEB') or os.path.join(ROOT, 'web', 'dist')
RENDERER = os.environ.get('CADRE_RENDERER') or os.path.join(ROOT, 'web', 'scripts', 'render.mjs')
BUILTIN_STYLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'styles')

PORT = int(os.environ.get('CADRE_PORT', '8765'))
BASE_URL = f'http://127.0.0.1:{PORT}'

# folders protected by macOS (Documents / Desktop synced with iCloud): read only once access is granted
PROTECTED = ['/Library/Mobile Documents/'] if sys.platform == 'darwin' else []
