"""Media: info (ffprobe), import (local file, upload, link), lightweight preview video, allowed files."""
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
        raise ValueError(f'unreadable file: {os.path.basename(path)}')
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


# ------------------------------------------------------------------ protected folders (macOS: iCloud Documents / Desktop)
# Without macOS's consent, reading these folders blocks forever: access is tested in a separate thread and, until it
# is granted, these files are refused right away instead of blocking the server.
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
    """the server only serves files from the app, the libraries and the projects."""
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
    """adds a file (left where it is) as a project source."""
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
    """hardware encoder on Mac (VideoToolbox), otherwise x264 tuned for fast decoding."""
    if sys.platform == 'darwin':
        return ['-c:v', 'h264_videotoolbox', '-b:v', '1800k']
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-tune', 'fastdecode']


def make_proxy(p, sid, job=None):
    """540p video, a keyframe every 0.5 s, AAC audio: the preview jumps instantly from one shot to the next."""
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
        raise RuntimeError('ffmpeg failed on the preview proxy')
    os.replace(out + '.tmp.mp4', out)
    return file_url(out)


def download(url, dest_dir, job=None):
    """link (Twitch, YouTube…) -> mp4 file (yt-dlp)."""
    os.makedirs(dest_dir, exist_ok=True)
    # --no-playlist: a "watch?v=…&list=…" link downloads only THIS video, not the whole playlist;
    # --progress: --print makes yt-dlp quiet, without it progress is never reported
    cmd = [sys.executable, '-m', 'yt_dlp', '--no-playlist', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4',
           '--ffmpeg-location', os.path.dirname(ff.ffmpeg()), '--newline', '--progress', '--retries', '20', '--fragment-retries', '20',
           '-o', f'{dest_dir}/%(title).80s [%(id)s].%(ext)s', '--print', 'before_dl:TITLE %(title)s', '--print', 'after_move:filepath', url]
    if job: job.step(0.0, 'fetching video info…')
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if job: job.proc = proc
    path, title, part, last_pct, tail = None, '', 0, 0.0, []
    unit = lambda v: (v or '').replace('~', '').strip().replace('GiB', ' GB').replace('MiB', ' MB').replace('KiB', ' KB')
    for line in proc.stdout:
        line = line.strip()
        tail = (tail + [line])[-8:]
        if line.startswith('TITLE '):
            title = line[6:].strip()
            if job: job.step(None, f'downloading "{title[:70]}"…')
            continue
        m = re.search(r'\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*(\S+))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?', line)
        if m and job:
            pct = float(m.group(1))
            if pct + 30 < last_pct: part += 1                 # video then audio: two files downloaded one after the other
            last_pct = pct
            what = 'video' if part == 0 else 'audio'
            total = 0.9 * pct / 100 if part == 0 else 0.9 + 0.08 * pct / 100
            bits = [f'{what} {pct:.0f}%' + (f' of {unit(m.group(2))}' if m.group(2) else '')]
            if m.group(3) and 'Unknown' not in m.group(3): bits.append(unit(m.group(3)))
            if m.group(4) and m.group(4) != 'Unknown': bits.append(f'{m.group(4)} left')
            job.step(total, 'downloading' + (f' "{title[:50]}"' if title else '') + ': ' + ' · '.join(bits))
        elif job and ('[Merger]' in line or 'Merging' in line):
            job.step(0.98, 'merging video and audio…')
        elif os.path.isabs(line) and os.path.exists(line): path = line
    if proc.wait() != 0 or not path:
        err = next((l for l in reversed(tail) if 'ERROR' in l), '')
        raise RuntimeError('download failed' + (f': {err.split("ERROR:", 1)[-1].strip()[:200]}' if err else ''))
    return path


def save_upload(p, filename, fileobj):
    dest = f'{store.pdir(p["id"])}/media'
    os.makedirs(dest, exist_ok=True)
    safe = re.sub(r'[/\\:]', '_', filename)
    out = f'{dest}/{safe}'
    with open(out, 'wb') as fh:
        shutil.copyfileobj(fileobj, fh)
    return out
