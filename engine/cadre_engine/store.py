"""On-disk storage (JSON): projects, editing styles, people (voices), settings.

  data/projects/<id>/project.json     the project (sources, timeline, music, preferences, chat)
  data/projects/<id>/words/<src>.json word-level transcript [[start, end, word, prob, person], ...]
  data/projects/<id>/proxy/<src>.mp4  lightweight video for the preview
  data/projects/<id>/renders/         final videos
  data/styles/<id>.json               editing style (rules for the AI + render settings)
  data/people/<id>.json (+ .npz)      person: name, color, preferences, voice embeddings
  data/settings.json                  settings (AI…)"""
import os, json, time, uuid, shutil, threading
from .config import DATA, PROJECTS, STYLES as PACKS, PEOPLE as SPEAKERS

_lock = threading.RLock()


def new_id(prefix=''):
    return prefix + uuid.uuid4().hex[:10]


def read_json(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp{threading.get_ident()}'
    with open(tmp, 'w') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ------------------------------------------------------------------ settings
DEFAULT_SETTINGS = {
    'ai': {'provider': 'auto', 'model': 'claude-opus-5-5', 'effort': 'medium', 'cliModel': 'opus'},
    'libraries': [],             # sound / music / VFX folders: [{id, name, path}]
    'transcription': {'model': 'turbo'},
    'remoteUrl': '',
    'onboarded': False,
}


def settings():
    s = read_json(f'{DATA}/settings.json', {})
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    for k, v in s.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict): out[k].update(v)
        else: out[k] = v
    return out


def save_settings(s):
    write_json(f'{DATA}/settings.json', s)
    return settings()


# ------------------------------------------------------------------ projects
def pdir(pid):
    if not pid or '/' in pid or pid.startswith('.'):
        raise ValueError('invalid project id')
    return f'{PROJECTS}/{pid}'


def list_projects():
    out = []
    for pid in os.listdir(PROJECTS):
        p = read_json(f'{PROJECTS}/{pid}/project.json')
        if not p: continue
        out.append({k: p.get(k) for k in ('id', 'name', 'packId', 'updatedAt', 'createdAt', 'title')}
                   | {'sources': len(p.get('sources', [])), 'items': len(p.get('timeline', [])), 'thumb': _thumb(p)})
    return sorted(out, key=lambda p: p.get('updatedAt') or 0, reverse=True)


def _thumb(p):
    import urllib.parse
    for s in p.get('sources', []):
        if s.get('kind') != 'video': continue
        path = s['path']
        if s.get('proxy') and 'p=' in s['proxy']: path = urllib.parse.unquote(s['proxy'].split('p=', 1)[1])
        return f"/api/thumb?p={urllib.parse.quote(path)}&t={min(30.0, (s.get('duration') or 0) / 3):.1f}&w=480"
    return None


def get_project(pid):
    p = read_json(f'{pdir(pid)}/project.json')
    if p is None: raise KeyError(pid)
    return p


def save_project(p, bump=True):
    with _lock:
        if bump:
            p['rev'] = int(p.get('rev', 0)) + 1
            p['updatedAt'] = time.time()
        write_json(f'{pdir(p["id"])}/project.json', p)
    return p


def create_project(name, pack_id, preferences='', speakers=None):
    pack = get_pack(pack_id) or get_pack('youtube') or (list_packs() or [{}])[0]
    pid = new_id('p')
    now = time.time()
    p = {
        'version': 1, 'id': pid, 'rev': 0, 'name': name or 'New project', 'title': '',
        'createdAt': now, 'updatedAt': now,
        'packId': pack['id'], 'preferences': preferences or '',
        'format': dict(pack.get('format') or {'width': 1920, 'height': 1080, 'fps': 30}),
        'speakers': speakers if speakers is not None else list(pack.get('speakers') or []),
        'defaultSpeaker': (pack.get('defaultSpeaker') or (speakers or [None])[0]),
        'glossary': {}, 'sources': [], 'timeline': [], 'music': [], 'chat': [],
    }
    os.makedirs(f'{pdir(pid)}/words', exist_ok=True)
    return save_project(p, bump=False)


def delete_project(pid):
    shutil.rmtree(pdir(pid), ignore_errors=True)


def words_path(pid, src):
    return f'{pdir(pid)}/words/{src}.json'


def get_words(pid, src):
    return read_json(words_path(pid, src), [])


def all_words(p):
    return {s['id']: get_words(p['id'], s['id']) for s in p.get('sources', [])}


def source(p, sid):
    for s in p.get('sources', []):
        if s['id'] == sid or s.get('name') == sid: return s
    raise KeyError(f'unknown source: {sid}')


# ------------------------------------------------------------------ packs
def list_packs():
    out = []
    for f in sorted(os.listdir(PACKS)):
        if f.endswith('.json'):
            pk = read_json(f'{PACKS}/{f}')
            if pk: out.append(pk)
    return out


def get_pack(pid):
    if not pid or '/' in pid: return None
    return read_json(f'{PACKS}/{pid}.json')


def save_pack(pk):
    if not pk.get('id'): pk['id'] = new_id('pack-')
    pk['updatedAt'] = time.time()
    write_json(f'{PACKS}/{pk["id"]}.json', pk)
    return pk


def delete_pack(pid):
    try: os.remove(f'{PACKS}/{pid}.json')
    except FileNotFoundError: pass


# ------------------------------------------------------------------ people (voices)
def list_speakers():
    out = []
    for f in sorted(os.listdir(SPEAKERS)):
        if f.endswith('.json'):
            sp = read_json(f'{SPEAKERS}/{f}')
            if sp:
                sp['hasVoice'] = os.path.exists(f'{SPEAKERS}/{sp["id"]}.npy')
                out.append(sp)
    return out


def get_speaker(sid):
    if not sid or '/' in sid: return None
    sp = read_json(f'{SPEAKERS}/{sid}.json')
    if sp: sp['hasVoice'] = os.path.exists(f'{SPEAKERS}/{sid}.npy')
    return sp


def save_speaker(sp):
    if not sp.get('id'): sp['id'] = new_id('spk-')
    sp.pop('hasVoice', None)
    sp['updatedAt'] = time.time()
    write_json(f'{SPEAKERS}/{sp["id"]}.json', sp)
    return get_speaker(sp['id'])


def delete_speaker(sid):
    for ext in ('json', 'npy', 'npz'):
        try: os.remove(f'{SPEAKERS}/{sid}.{ext}')
        except FileNotFoundError: pass
