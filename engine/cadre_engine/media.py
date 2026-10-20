"""Médias : infos (ffprobe), import (fichier local, envoi, lien), vidéo légère pour l'aperçu, fichiers autorisés."""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from . import ff, store
from .config import BASE_URL, DATA, PROJECTS, PROTECTED

VIDEO_EXT = {'.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.ts', '.flv', '.mts', '.mxf'}
AUDIO_EXT = {'.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aif', '.aiff'}
IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'}


def probe(path):
    r = ff.probe_run(['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,duration',
                      '-of', 'json', path], capture_output=True, text=True)
    if r.returncode != 0:
        raise ValueError(f'fichier illisible : {os.path.basename(path)}')
    d = json.loads(r.stdout or '{}')
    streams = d.get('streams', [])
    v = next((s for s in streams if s.get('codec_type') == 'video'), None)
    a = next((s for s in streams if s.get('codec_type') == 'audio'), None)
    ext = os.path.splitext(path)[1].lower()
    fps = 30.0
    if v and v.get('r_frame_rate', '0/0') != '0/0':
        n, dd = v['r_frame_rate'].split('/'); fps = round(float(n) / max(1.0, float(dd)), 3)
    dur = float(d.get('format', {}).get('duration') or (v or a or {}).get('duration') or 0)
    kind = 'image' if ext in IMAGE_EXT else ('video' if v and ext not in AUDIO_EXT else 'audio')
    return {'kind': kind, 'duration': round(dur, 3), 'width': (v or {}).get('width', 0), 'height': (v or {}).get('height', 0),
            'fps': fps, 'hasAudio': a is not None}


# ------------------------------------------------------------------ dossiers protégés (macOS : Documents / Bureau iCloud)
# Sans l'accord de macOS, lire ces dossiers bloque indéfiniment : on teste l'accès dans un fil à part et, tant qu'il
# n'est pas accordé, on refuse ces fichiers tout de suite au lieu de bloquer le serveur.
_access = {'ok': None, 'probing': False, 'at': 0.0}


def is_protected(path):
    rp = os.path.realpath(path)
    return any(p in rp for p in PROTECTED)


def protected_ok(sample=None):
    if not PROTECTED or _access['ok']: return True
    if not _access['probing'] and time.time() - _access['at'] > 15:
        _access.update(probing=True, at=time.time())
        target = sample or next((l['path'] for l in store.settings().get('libraries', []) if is_protected(l['path'])), None)
        def probe_():
            try:
                if target: os.listdir(target)
                _access['ok'] = True
            except OSError:
                _access['ok'] = False
            finally:
                _access['probing'] = False
        threading.Thread(target=probe_, daemon=True).start()
        time.sleep(0.3)
    return bool(_access['ok'])


def readable(path):
    return not is_protected(path) or protected_ok(os.path.dirname(path))


def file_url(path):
    return f'/api/file?p={urllib.parse.quote(path)}'


def abs_url(path):
    return BASE_URL + file_url(path)


def path_of(url):
    if not url or 'p=' not in url: return None
    return urllib.parse.unquote(url.split('p=', 1)[1].split('&', 1)[0])


def allowed(path):
    """le serveur ne sert que les fichiers de l'appli, des bibliothèques et des projets."""
    rp = os.path.realpath(path)
    roots = [DATA] + [l['path'] for l in store.settings().get('libraries', [])]
    if sys.platform == 'darwin': roots.append(os.path.expanduser('~/Library/Fonts'))
    if any(rp.startswith(os.path.realpath(r) + os.sep) for r in roots if r):
        return True
    for p in os.listdir(PROJECTS):
        pj = store.read_json(f'{PROJECTS}/{p}/project.json') or {}
        for s in pj.get('sources', []):
            if os.path.realpath(s.get('path', '')) == rp: return True
        for it in pj.get('timeline', []):
            if it.get('type') == 'media' and os.path.realpath(it.get('path', '')) == rp: return True
        for tr in pj.get('tracks', []):
            for c in tr.get('clips', []):
                if c.get('path') and os.path.realpath(c['path']) == rp: return True
    return False


def add_source(p, path, name=None, origin=None):
    """ajoute un fichier (laissé à sa place) comme source du projet."""
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    info = probe(path)
    base = re.sub(r'[^a-z0-9]+', '_', os.path.splitext(os.path.basename(name or path))[0].lower()).strip('_')[:24] or 'source'
    ids = {s['id'] for s in p['sources']}
    sid, n = base, 2
    while sid in ids:
        sid = f'{base}_{n}'; n += 1
    src = {'id': sid, 'name': name or os.path.basename(path), 'path': path, 'url': file_url(path), 'origin': origin,
           **info, 'proxy': None, 'stems': None,
           'status': {'transcript': 'none', 'speakers': 'none', 'stems': 'none', 'proxy': 'none'}}
    p['sources'].append(src)
    return src


def _encoder():
    """encodeur matériel sur Mac (VideoToolbox), sinon x264 rapide à décoder."""
    if sys.platform == 'darwin':
        return ['-c:v', 'h264_videotoolbox', '-b:v', '1800k']
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-tune', 'fastdecode']


def make_proxy(p, sid, job=None):
    """vidéo 540p, image-clé toutes les 0,5 s, son AAC : l'aperçu saute instantanément d'un plan à l'autre."""
    src = store.source(p, sid)
    if src['kind'] != 'video':
        return None
    out = f'{store.pdir(p["id"])}/proxy/{sid}.mp4'
    os.makedirs(os.path.dirname(out), exist_ok=True)
    fps = min(30, round(src.get('fps') or 30))
    args = ['-y', '-loglevel', 'error', '-progress', 'pipe:1', '-i', src['path'], '-vf', f'scale=-2:540,fps={fps}',
            *_encoder(), '-g', str(max(1, fps // 2)), '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', out + '.tmp.mp4']
    proc = ff.popen(args, stdout=subprocess.PIPE, text=True)
    if job: job.proc = proc
    dur = max(0.1, src['duration'])
    for line in proc.stdout:
        if line.startswith('out_time_us=') and job:
            try: job.step(int(line.split('=')[1]) / 1e6 / dur)
            except ValueError: pass
    if proc.wait() != 0:
        raise RuntimeError('ffmpeg a échoué sur la vidéo légère')
    os.replace(out + '.tmp.mp4', out)
    return file_url(out)


def download(url, dest_dir, job=None):
    """lien (Twitch, YouTube…) -> fichier mp4 (yt-dlp)."""
    os.makedirs(dest_dir, exist_ok=True)
    cmd = [sys.executable, '-m', 'yt_dlp', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4',
           '--ffmpeg-location', os.path.dirname(ff.ffmpeg()), '--newline', '--retries', '20', '--fragment-retries', '20',
           '-o', f'{dest_dir}/%(title).80s [%(id)s].%(ext)s', '--print', 'after_move:filepath', url]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if job: job.proc = proc
    path = None
    for line in proc.stdout:
        line = line.strip()
        m = re.search(r'\[download\]\s+([\d.]+)%', line)
        if m and job: job.step(float(m.group(1)) / 100, line[:120])
        elif os.path.isabs(line) and os.path.exists(line): path = line
    if proc.wait() != 0 or not path:
        raise RuntimeError('téléchargement impossible')
    return path


def save_upload(p, filename, fileobj):
    dest = f'{store.pdir(p["id"])}/media'
    os.makedirs(dest, exist_ok=True)
    safe = re.sub(r'[/\\:]', '_', filename)
    out = f'{dest}/{safe}'
    with open(out, 'wb') as fh:
        shutil.copyfileobj(fileobj, fh)
    return out
