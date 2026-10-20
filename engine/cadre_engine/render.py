"""Export : la même composition que l'aperçu (web/src/remotion), rendue par Node avec les fichiers d'origine,
puis son normalisé (LUFS du style) et chapitres YouTube. Préréglages : web, 4K, vertical, brouillon, ProRes, audio seul."""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from . import ff, library, store
from .config import BASE_URL, RENDERER
from .media import file_url, is_protected
from .ai.tools import Ctx, item_duration

PRESETS = {
    'web':    {'label': 'Web — H.264', 'codec': 'h264', 'crf': 18, 'scale': 1, 'ext': 'mp4'},
    '4k':     {'label': '4K — H.264', 'codec': 'h264', 'crf': 18, 'scale': 2, 'ext': 'mp4'},
    'hevc':   {'label': 'HEVC — H.265', 'codec': 'h265', 'crf': 22, 'scale': 1, 'ext': 'mp4'},
    'prores': {'label': 'ProRes 422 HQ', 'codec': 'prores', 'proresProfile': 'hq', 'scale': 1, 'ext': 'mov'},
    'draft':  {'label': 'Brouillon (½)', 'codec': 'h264', 'crf': 28, 'scale': 0.5, 'ext': 'mp4'},
    'audio':  {'label': 'Audio seul — WAV', 'codec': 'wav', 'scale': 1, 'ext': 'wav'},
}


def node_cmd():
    """Node pour lancer le moteur de rendu : CADRE_NODE (le Node intégré de l'appli de bureau) ou celui du système."""
    env = dict(os.environ)
    if os.environ.get('CADRE_NODE'):
        env['ELECTRON_RUN_AS_NODE'] = '1'
        return [os.environ['CADRE_NODE']], env
    node = shutil.which('node')
    if not node: raise RuntimeError('Node introuvable pour le rendu')
    return [node], env


def props_for(p, quality='final'):
    """tout ce que la composition doit savoir, avec des URL absolues (le moteur de rendu tourne hors du navigateur)."""
    pack = store.get_pack(p['packId']) or {}
    lib = library.ready() or {'sfx': {}}
    absu = lambda u: BASE_URL + u if u and u.startswith('/') else u
    locked = lambda u: bool(u) and is_protected(_path(u)) and library.ready() is None
    proj = json.loads(json.dumps(p))
    proj.pop('chat', None); proj.pop('conversations', None)
    for s in proj['sources']:
        s['url'] = absu(s['url'])
        s['proxy'] = absu(s.get('proxy')) if quality == 'draft' else None
        if s.get('stems'):
            s['stems'] = {k: absu(v) if isinstance(v, str) else v for k, v in s['stems'].items()}
    if library.ready() is None:                   # bibliothèque pas lisible (accès en attente) : sans musique ni VFX protégés
        proj['music'] = [m for m in proj.get('music', []) if not locked(m.get('url'))]
        for tr in proj.get('tracks', []): tr['clips'] = [c for c in tr['clips'] if not locked(c.get('url'))]
        for it in proj['timeline']:
            if it.get('type') == 'media' and locked(it.get('url')): it['url'] = ''
    for it in proj['timeline']:
        if it.get('url'): it['url'] = absu(it['url'])
        if it.get('image'): it['image'] = absu(it['image'])
    for m in proj.get('music', []): m['url'] = absu(m['url'])
    for tr in proj.get('tracks', []):
        for c in tr.get('clips', []):
            if c.get('url'): c['url'] = absu(c['url'])
    sfx = {k: {**v, 'variants': [{**x, 'url': absu(x['url'])} for x in v['variants']]} for k, v in lib['sfx'].items()}
    return {
        'project': proj, 'words': store.all_words(p), 'pack': {'id': pack.get('id'), 'style': pack.get('style', {})},
        'speakers': {s['id']: {'name': s['name'], 'color': s['color']} for s in store.list_speakers()},
        'sfx': sfx, 'logo': absu(proj.get('logoUrl')), 'mode': 'render',
    }


def _path(url):
    from .media import path_of
    return path_of(url) or ''


def chapters(p):
    ctx = Ctx(p)
    t, out = 0.0, []
    for it in p['timeline']:
        if it.get('label'):
            out.append(f'{int(t // 60)}:{int(t % 60):02d} {it["label"]}')
        t += item_duration(ctx, it)
    if out and not out[0].startswith('0:00'):
        out.insert(0, '0:00 Intro')
    return '\n'.join(out)


def render(p, job, preset='web'):
    if preset == 'final': preset = 'web'
    opts = PRESETS.get(preset, PRESETS['web'])
    d = f'{store.pdir(p["id"])}/renders'
    os.makedirs(d, exist_ok=True)
    name = re.sub(r'[^\w-]+', '_', (p.get('title') or p['name']))[:60].strip('_') or 'video'
    stamp = time.strftime('%Y%m%d-%H%M')
    props_path = f'{d}/.props.json'
    json.dump(props_for(p, 'draft' if preset == 'draft' else 'final'), open(props_path, 'w'), ensure_ascii=False)
    raw = f'{d}/.{name}_{stamp}_raw.{opts["ext"]}'
    out = f'{d}/{name}_{stamp}{"_" + preset if preset != "web" else ""}.{opts["ext"]}'
    job.step(0.01, 'préparation…')
    if library.ready() is None and store.settings().get('libraries'):
        job.step(None, 'bibliothèque pas encore accessible : export sans ses sons')
    node, env = node_cmd()
    proc = subprocess.Popen([*node, RENDERER, props_path, raw, json.dumps(opts)], cwd=os.path.dirname(os.path.dirname(RENDERER)),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    job.proc = proc
    tail = []
    for line in proc.stdout:
        line = line.strip()
        if line.startswith('{'):
            try:
                ev = json.loads(line)
                if 'progress' in ev: job.step(0.02 + 0.88 * ev['progress'], ev.get('message'))
                continue
            except json.JSONDecodeError: pass
        if line: tail = (tail + [line])[-12:]
    if proc.wait() != 0:
        raise RuntimeError("l'export a échoué :\n" + '\n'.join(tail))
    pack = store.get_pack(p['packId']) or {}
    lufs = (pack.get('style') or {}).get('loudness', -14)
    job.step(0.93, f'son normalisé à {lufs} LUFS')
    if opts['codec'] == 'wav':
        r = ff.run(['-y', '-loglevel', 'error', '-i', raw, '-af', f'loudnorm=I={lufs}:TP=-1.0:LRA=11', '-ar', '48000', out])
    else:
        acodec = ['-c:a', 'pcm_s16le'] if opts['ext'] == 'mov' else ['-c:a', 'aac', '-b:a', '256k']
        r = ff.run(['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'copy', '-af', f'loudnorm=I={lufs}:TP=-1.0:LRA=11',
                    *acodec, '-ar', '48000', *(['-movflags', '+faststart'] if opts['ext'] == 'mp4' else []), out])
    if r.returncode != 0: os.replace(raw, out)
    else: os.remove(raw)
    ch = chapters(p)
    if ch: open(re.sub(r'\.\w+$', '_chapitres.txt', out), 'w').write(ch + '\n')
    os.remove(props_path)
    copy_to = ((store.settings().get('export') or {}).get('copyTo') or '').strip()
    if copy_to:
        dst = os.path.expanduser(copy_to)
        try:
            os.makedirs(dst, exist_ok=True)
            shutil.copy2(out, os.path.join(dst, os.path.basename(out)))
            job.step(None, f'copié dans {dst}')
        except OSError as e:
            job.step(None, f'copie impossible dans {dst} : {e}')
    return {'path': out, 'url': file_url(out), 'chapters': ch}


def list_renders(p):
    d = f'{store.pdir(p["id"])}/renders'
    if not os.path.isdir(d): return []
    out = []
    for f in sorted(os.listdir(d), key=lambda f: -os.path.getmtime(f'{d}/{f}')):
        if f.rsplit('.', 1)[-1] in ('mp4', 'mov', 'wav') and not f.startswith('.'):
            path = f'{d}/{f}'
            out.append({'name': f, 'path': path, 'url': file_url(path), 'size': os.path.getsize(path), 'created': os.path.getmtime(path)})
    return out
