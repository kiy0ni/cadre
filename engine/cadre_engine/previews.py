"""Aperçus pour l'éditeur : vignette d'un instant, planche de vignettes (filmstrip de la timeline), forme d'onde.
Tout est calculé à la demande en tâche de fond et mis en cache (data/cache/previews) ; l'éditeur réessaie tant que
ce n'est pas prêt. Fonctionne sur n'importe quel fichier autorisé (sources, banque de sons, VFX)."""
import os, json, math, hashlib, subprocess, threading
import numpy as np
from .config import CACHE
from .media import file_url, probe
from . import ff

D = f'{CACHE}/previews'
os.makedirs(D, exist_ok=True)
_busy = set()
_lock = threading.Lock()
PEAKS_PER_S = 20
TW, TH, COLS = 160, 90, 20


def _key(path, *extra):
    st = os.stat(path)
    return hashlib.md5(f'{path}|{st.st_size}|{int(st.st_mtime)}|{extra}'.encode()).hexdigest()[:16]


def _background(key, fn):
    with _lock:
        if key in _busy: return
        _busy.add(key)
    def run():
        try: fn()
        except Exception as e: print('aperçu impossible :', e, flush=True)
        finally:
            with _lock: _busy.discard(key)
    threading.Thread(target=run, daemon=True).start()


def thumb(path, t=0.0, w=320):
    """vignette jpg -> chemin (synchrone : une seule image, rapide)"""
    k = _key(path, round(t, 1), w)
    out = f'{D}/{k}.jpg'
    if not os.path.exists(out):
        ext = os.path.splitext(path)[1].lower()
        if ext in ('.png', '.jpg', '.jpeg', '.webp', '.gif'):
            ff.run(['-loglevel', 'error', '-y', '-i', path, '-vf', f'scale={w}:-2', '-frames:v', '1', out])
        else:
            ff.run(['-loglevel', 'error', '-y', '-ss', f'{max(0, t):.2f}', '-i', path, '-vf', f'scale={w}:-2',
                            '-frames:v', '1', '-q:v', '4', out])
    return out if os.path.exists(out) else None


def sprite(path):
    """planche de vignettes 160x90 (20 colonnes), une toutes les `interval` s (max 900 vignettes)."""
    k = _key(path, 'sprite')
    meta = f'{D}/{k}.sprite.json'
    if os.path.exists(meta): return json.load(open(meta))
    def build():
        dur = probe(path)['duration'] or 1
        interval = max(1.0, dur / 900)
        n = max(1, math.ceil(dur / interval))
        rows = math.ceil(n / COLS)
        img = f'{D}/{k}.sprite.jpg'
        vf = (f'fps=1/{interval:.3f},scale={TW}:{TH}:force_original_aspect_ratio=decrease,'
              f'pad={TW}:{TH}:(ow-iw)/2:(oh-ih)/2,tile={COLS}x{rows}')
        ff.run(['-loglevel', 'error', '-y', '-skip_frame', 'nokey', '-i', path, '-vf', vf, '-an',
                        '-frames:v', '1', '-q:v', '5', img], check=True)
        json.dump({'url': file_url(img), 'interval': interval, 'cols': COLS, 'n': n, 'w': TW, 'h': TH}, open(meta, 'w'))
    _background(meta, build)
    return {'pending': True}


def peaks(path):
    """forme d'onde : 20 valeurs par seconde (0-255)"""
    k = _key(path, 'peaks')
    out = f'{D}/{k}.peaks.json'
    if os.path.exists(out): return json.load(open(out))
    def build():
        raw = ff.run(['-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'],
                     capture_output=True, check=True).stdout
        x = np.abs(np.frombuffer(raw, np.float32))
        hop = 8000 // PEAKS_PER_S
        n = len(x) // hop
        pk = x[:n * hop].reshape(n, hop).max(1) if n else np.zeros(0)
        ref = float(np.percentile(pk, 99.5)) if n else 1.0
        v = np.clip(np.sqrt(pk / (ref or 1.0)) * 255, 0, 255).astype(int).tolist()
        json.dump({'rate': PEAKS_PER_S, 'peaks': v}, open(out, 'w'))
    _background(out, build)
    return {'pending': True}
