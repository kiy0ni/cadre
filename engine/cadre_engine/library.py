"""Bibliothèques de médias de l'utilisateur (dossiers choisis dans Réglages) : bruitages, musiques, VFX / images.

- Chaque fichier est classé : musique (dossier « music / musique / bgm… » ou plus de 45 s), bruitage (son court),
  visuel (vidéo / image). Les bruitages sont découpés au premier son et calibrés au niveau de la voix.
- Des « sons nommés » (alias) regroupent plusieurs variantes sous un nom stable (ex. « whoosh », « impact ») : ils sont
  dans data/library-aliases.json ; l'IA et les styles les utilisent en priorité.
- Les ambiances / BPM des musiques viennent de data/music-meta.json s'il existe (clé = chemin du fichier)."""
import hashlib
import os
import re
import threading
import numpy as np
from . import ff, store
from .config import CACHE, DATA
from .media import AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, file_url, is_protected, protected_ok

_LIB = None
_lock = threading.Lock()
CACHE_F = os.path.join(CACHE, 'library-analysis.json')
ALIASES_F = os.path.join(DATA, 'library-aliases.json')
META_F = os.path.join(DATA, 'music-meta.json')
MUSIC_DIRS = re.compile(r'/(music|musique|musiques|bgm|jingles?|soundtracks?|ost|songs?)[^/]*/', re.I)


def _id(path):
    return hashlib.sha1(path.encode()).hexdigest()[:12]


def _clean(name):
    n = os.path.splitext(os.path.basename(name))[0]
    n = re.sub(r'^ES_', '', n)
    n = re.sub(r'\s*-\s*Epidemic Sound$', '', n)
    return n.strip()


def _analyse(path, music):
    """-> {dur, start, peak, end, gainDb} (son court) ou {dur, gainDb} (musique)"""
    raw = ff.run(['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', *(['-t', '240'] if music else []), '-f', 'f32le', '-'],
                 capture_output=True).stdout
    x = np.frombuffer(raw, np.float32)
    if not len(x): return {'dur': 0, 'gainDb': 0}
    dur = len(x) / 16000
    if music:
        rms = float(np.sqrt(np.mean(x ** 2))) or 1e-6
        return {'dur': round(dur, 2), 'gainDb': round(-20 - 20 * np.log10(rms), 2)}
    hop = 160
    n = len(x) // hop
    env = np.abs(x[:n * hop]).reshape(n, hop).max(1)
    top = float(env.max()) or 1e-6
    on = np.nonzero(env > top * 0.12)[0]
    start = max(0.0, (on[0] * hop / 16000) - 0.01) if len(on) else 0.0
    peak = float(np.argmax(env) * hop / 16000)
    after = np.nonzero(env[int(peak * 100):] < top * 0.05)[0]
    end = min(dur, peak + (after[0] / 100 if len(after) else 1.5))
    seg = x[int(start * 16000):int(min(dur, start + 2.0) * 16000)]
    win = 3200
    if len(seg) <= win: rms = float(np.sqrt(np.mean(seg ** 2))) or 1e-6
    else:
        c = np.cumsum(np.concatenate([[0], seg ** 2]))
        rms = float(np.sqrt(((c[win:] - c[:-win]) / win).max())) or 1e-6
    g = min(-18 - 20 * np.log10(rms), 20 * np.log10(0.95 / (float(np.abs(seg).max()) or 1e-6)))
    return {'dur': round(dur, 3), 'start': round(start, 3), 'peak': round(peak, 3), 'end': round(end, 3), 'gainDb': round(float(g), 2)}


def build():
    libs = store.settings().get('libraries', [])
    cache = store.read_json(CACHE_F, {})
    meta = store.read_json(META_F, {})
    sfx, music, vfx = {}, [], []
    for lib in libs:
        root = lib['path']
        if not os.path.isdir(root) or (is_protected(root) and not protected_ok(root)): continue
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            rel_dir = os.path.relpath(dirpath, root)
            folder = '' if rel_dir == '.' else rel_dir
            for f in sorted(files):
                if f.startswith('.'): continue
                path = os.path.join(dirpath, f)
                ext = os.path.splitext(f)[1].lower()
                if ext in VIDEO_EXT or ext in IMAGE_EXT:
                    vfx.append({'name': _clean(f), 'path': path, 'url': file_url(path), 'folder': os.path.basename(folder) or lib['name'],
                                'kind': 'image' if ext in IMAGE_EXT else 'video'})
                    continue
                if ext not in AUDIO_EXT: continue
                st = os.stat(path)
                ck = f'{path}|{st.st_size}|{int(st.st_mtime)}'
                is_music = bool(MUSIC_DIRS.search('/' + folder.replace(os.sep, '/') + '/'))
                if ck not in cache:
                    info = _analyse(path, is_music)
                    if not is_music and info.get('dur', 0) > 45:
                        info, is_music = _analyse(path, True), True
                    cache[ck] = {**info, 'music': is_music}
                info = cache[ck]
                if info.get('music'):
                    m = meta.get(path, {})
                    music.append({'name': m.get('title') or _clean(f), 'file': f, 'url': file_url(path), 'path': path,
                                  'moods': m.get('moods', []), 'energy': m.get('energy'), 'bpm': m.get('bpm'),
                                  'genres': (m.get('genres') or [])[:3], 'gainDb': info['gainDb'], 'folder': os.path.basename(folder)})
                else:
                    key = 'f:' + _id(path)
                    sfx[key] = {'name': key, 'label': _clean(f), 'help': os.path.basename(folder) or lib['name'], 'file': True,
                                'variants': [{'file': f, 'url': file_url(path), 'start': info.get('start', 0),
                                              'anchor': max(0.0, info.get('peak', 0) - info.get('start', 0)),
                                              'dur': round(max(0.1, min(2.5, info.get('end', 1) - info.get('start', 0) + 0.15)), 3),
                                              'gainDb': info['gainDb']}]}
    store.write_json(CACHE_F, cache)
    named = {}
    for name, a in (store.read_json(ALIASES_F, {}) or {}).items():
        vs = [v for v in a.get('variants', []) if os.path.exists(v['path'])]
        if not vs: continue
        named[name] = {'name': name, 'label': name, 'help': a.get('help', ''), 'file': False,
                       'variants': [{'file': os.path.basename(v['path']), 'url': file_url(v['path']), 'start': v.get('start', 0),
                                     'dur': v.get('dur', 1.0), 'anchor': v.get('anchor', 0), 'gainDb': v.get('gainDb', 0)} for v in vs]}
    seen, uniq = set(), []
    for t in sorted(music, key=lambda t: t['name'].lower()):
        if t['name'] in seen: continue
        seen.add(t['name']); uniq.append(t)
    return {'sfx': {**named, **sfx}, 'music': uniq, 'vfx': vfx, 'sections': SECTIONS}


SECTIONS = {
    'intro / blague': ['Quirky', 'Funny', 'Happy', 'Eccentric'],
    'discussion posée': ['Laid Back', 'Smooth', 'Dreamy', 'Happy'],
    'action': ['Restless', 'Epic', 'Energetic', 'Running'],
    'colère': ['Angry', 'Epic', 'Dark', 'Restless'],
    'tension': ['Suspense', 'Mysterious', 'Dark'],
    'victoire': ['Euphoric', 'Epic', 'Happy', 'Hopeful'],
    'tristesse': ['Sad', 'Melancholic', 'Sentimental'],
    'fin': ['Hopeful', 'Laid Back', 'Happy'],
}


def get():
    """bloquant : construit la bibliothèque si besoin"""
    global _LIB
    with _lock:
        if _LIB is None:
            _LIB = build()
        return _LIB


def ready():
    return _LIB


def warm():
    if _LIB is None and not _lock.locked():
        threading.Thread(target=get, daemon=True, name='library').start()


def reset():
    global _LIB
    _LIB = None
    warm()


def music_by_name(name):
    lib = _LIB or get()
    low = (name or '').lower()
    for t in lib['music']:
        if t['name'].lower() == low: return t
    for t in lib['music']:
        if low and low in t['name'].lower(): return t
    return None


def suggest_music(mood, n=8):
    lib = _LIB or get()
    want = SECTIONS.get(mood, [m.strip().title() for m in mood.split(',')]) if mood else []
    scored = []
    for t in lib['music']:
        s = sum(3 - i * 0.5 for i, m in enumerate(want) if m in t['moods'])
        if s or not want: scored.append((s, t))
    return [t for s, t in sorted(scored, key=lambda x: -x[0])[:n]]
