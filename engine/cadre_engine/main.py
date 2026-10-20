"""API de Cadre (moteur local). Lancé par l'appli de bureau, ou : uv run python -m cadre_engine.run"""
import os, json, time, tempfile, threading
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config, store, jobs, media, analyse, library, seeds, previews, render as R, transcribe as ASR, voices as VX
from .ai import agent

app = FastAPI(title=config.APP_NAME)


# ------------------------------------------------------------------ accès à distance : mot de passe (voir auth.py)
@app.middleware('http')
async def guard(request: Request, call_next):
    from . import auth
    path = request.url.path
    needs = path.startswith('/api/') or path.startswith('/mcp/')
    if not needs or path.startswith('/api/auth/') or path == '/api/health' or auth.is_local(request):
        return await call_next(request)
    if auth.valid(request.cookies.get(auth.COOKIE)):
        return await call_next(request)
    return JSONResponse({'detail': 'auth', 'configured': auth.configured()}, status_code=401)


@app.get('/api/auth/status')
def auth_status(request: Request):
    from . import auth
    local = auth.is_local(request)
    return {'local': local, 'configured': auth.configured(), 'authenticated': local or auth.valid(request.cookies.get(auth.COOKIE))}


@app.post('/api/auth/login')
async def auth_login(request: Request):
    from . import auth
    ip = auth.client_ip(request)
    if auth.throttled(ip): raise HTTPException(429, 'trop d’essais : réessaie dans 10 minutes')
    b = await request.json()
    if not auth.configured(): raise HTTPException(403, 'aucun mot de passe défini sur le Mac (Réglages › Accès à distance)')
    if not auth.check_password(b.get('password', '')):
        auth.failed(ip)
        raise HTTPException(401, 'mot de passe incorrect')
    tok = auth.new_session(request.headers.get('user-agent', ''))
    secure = request.headers.get('x-forwarded-proto', request.url.scheme) == 'https'
    resp = JSONResponse({'ok': True})
    resp.set_cookie(auth.COOKIE, tok, max_age=auth.TTL, httponly=True, secure=secure, samesite='lax', path='/')
    return resp


@app.post('/api/auth/logout')
def auth_logout(request: Request):
    from . import auth
    auth.end_session(request.cookies.get(auth.COOKIE))
    resp = JSONResponse({'ok': True})
    resp.delete_cookie(auth.COOKIE, path='/')
    return resp


@app.post('/api/auth/password')
async def auth_password(request: Request):
    """définir / changer le mot de passe : depuis le Mac, ou depuis une session à distance avec l'ancien mot de passe"""
    from . import auth
    b = await request.json()
    if not auth.is_local(request):
        if not auth.valid(request.cookies.get(auth.COOKIE)) or not auth.check_password(b.get('current', '')):
            raise HTTPException(403, 'mot de passe actuel incorrect')
    try: auth.set_password(b.get('password', ''))
    except ValueError as e: raise HTTPException(400, str(e))
    return {'ok': True}
seeds.seed()
library.warm()
_plock = threading.RLock()          # modifications du projet faites par le serveur (statuts des sources…)

SERVER_OWNED = ('status', 'proxy', 'stems', 'duration', 'width', 'height', 'fps', 'hasAudio', 'kind', 'path', 'url')


def _project(pid):
    try: return store.get_project(pid)
    except (KeyError, ValueError): raise HTTPException(404, 'projet introuvable')


def patch_source(pid, sid, **fields):
    with _plock:
        p = store.get_project(pid)
        s = store.source(p, sid)
        st = fields.pop('status', None)
        if st: s.setdefault('status', {}).update(st)
        s.update(fields)
        store.save_project(p)
        return p


# ------------------------------------------------------------------ général
@app.get('/api/health')
def health():
    return {'ok': True}


@app.get('/api/bootstrap')
def bootstrap():
    s = store.settings()
    return {'packs': store.list_packs(), 'speakers': store.list_speakers(), 'settings': s, 'ai': agent.status(s)}


@app.get('/api/library')
def get_library():
    """la banque se construit en tâche de fond (lecture de la banque iCloud) : tant qu'elle n'est pas prête,
    on répond « loading » au lieu de bloquer l'interface."""
    if library.ready() is None:
        library.warm()
        return {'loading': True, 'sfx': {}, 'music': [], 'vfx': [], 'sections': {}}
    lib = library.ready()
    return {'sfx': lib['sfx'], 'music': [{k: v for k, v in t.items() if k != 'path'} for t in lib['music']],
            'vfx': lib['vfx'], 'sections': lib['sections']}


def _checked(p):
    if not media.readable(p):
        raise HTTPException(503, 'dossier iCloud pas encore autorisé')
    if not os.path.isfile(p) or not media.allowed(p):
        raise HTTPException(404, 'fichier introuvable')
    return p


@app.get('/api/thumb')
def get_thumb(p: str, t: float = 0.0, w: int = 320):
    out = previews.thumb(_checked(p), t, min(960, max(80, w)))
    if not out: raise HTTPException(404, 'vignette impossible')
    return FileResponse(out, headers={'Cache-Control': 'public, max-age=86400'})


@app.get('/api/sprite')
def get_sprite(p: str):
    return previews.sprite(_checked(p))


@app.get('/api/peaks')
def get_peaks(p: str):
    return previews.peaks(_checked(p))


@app.get('/api/system')
def system():
    """état de l'installation : ce qui marche sur cette machine"""
    import platform, shutil, sys
    s = store.settings()
    return {'app': config.APP_NAME, 'version': config.VERSION, 'platform': sys.platform, 'arch': platform.machine(),
            'transcription': ASR.backend(), 'voices': VX.available(), 'ffmpeg': _ffmpeg_ok(), 'ai': agent.status(s),
            'libraries': [{**l, 'exists': os.path.isdir(l['path']) if not media.is_protected(l['path']) or media.protected_ok(l['path']) else None}
                          for l in s.get('libraries', [])],
            'libraryReady': library.ready() is not None, 'dataDir': config.DATA, 'presets': {k: v['label'] for k, v in R.PRESETS.items()}}


def _ffmpeg_ok():
    try:
        from . import ff
        return bool(ff.ffmpeg())
    except Exception:
        return False


@app.post('/api/libraries')
async def add_library(req: Request):
    b = await req.json()
    path = os.path.abspath(os.path.expanduser(b.get('path', '')))
    if not os.path.isdir(path): raise HTTPException(400, 'dossier introuvable')
    s = store.settings()
    libs = [l for l in s.get('libraries', []) if l['path'] != path]
    libs.append({'id': store.new_id('lib'), 'name': b.get('name') or os.path.basename(path), 'path': path})
    s['libraries'] = libs
    store.save_settings(s)
    library.reset()
    return {'libraries': libs}


@app.delete('/api/libraries/{lid}')
def del_library(lid: str):
    s = store.settings()
    s['libraries'] = [l for l in s.get('libraries', []) if l['id'] != lid]
    store.save_settings(s)
    library.reset()
    return {'libraries': s['libraries']}


@app.post('/api/libraries/rescan')
def rescan_library():
    library.reset()
    return {'ok': True}


@app.post('/api/system/voices')
def install_voices():
    """installe les modules voix (torch, speechbrain, demucs) dans l'environnement du moteur"""
    import subprocess, shutil, sys
    uv = os.environ.get('CADRE_UV') or shutil.which('uv')
    def fn(job):
        job.step(0.05, 'téléchargement des modules voix (~2 Go)…')
        if uv:
            cmd = [uv, 'sync', '--frozen', '--extra', 'voix', '--project', config.ENGINE]
        else:
            cmd = [sys.executable, '-m', 'pip', 'install', 'torch', 'torchaudio', 'speechbrain', 'demucs', 'soundfile']
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=dict(os.environ))
        job.proc = proc
        for line in proc.stdout: job.step(None, line.strip()[:100])
        if proc.wait() != 0: raise RuntimeError('installation impossible')
        return {'ok': True}
    return {'job': jobs.submit('setup', fn, None, 'modules voix', heavy=False).id}


@app.get('/api/settings')
def get_settings():
    s = store.settings()
    return {'settings': s, 'ai': agent.status(s)}


@app.put('/api/settings')
async def put_settings(req: Request):
    body = await req.json()
    s = store.settings()
    for k, v in body.items():
        if isinstance(v, dict) and isinstance(s.get(k), dict): s[k].update(v)
        else: s[k] = v
    s = store.save_settings(s)
    return {'settings': s, 'ai': agent.status(s)}


@app.get('/api/file')
def get_file(p: str):
    if not media.readable(p):
        raise HTTPException(503, 'dossier iCloud pas encore autorisé')
    if not os.path.isfile(p) or not media.allowed(p):
        raise HTTPException(404, 'fichier introuvable')
    return FileResponse(p, headers={'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*'})


# ------------------------------------------------------------------ projets
@app.get('/api/projects')
def projects():
    return store.list_projects()


@app.post('/api/projects')
async def create_project(req: Request):
    b = await req.json()
    p = store.create_project(b.get('name'), b.get('packId'), b.get('preferences', ''), b.get('speakers'))
    return p


@app.get('/api/projects/{pid}')
def get_project(pid: str):
    p = _project(pid)
    if agent.migrate(p): store.save_project(p, bump=False)
    return {'project': p, 'words': store.all_words(p), 'renders': R.list_renders(p)}


@app.put('/api/projects/{pid}')
async def put_project(pid: str, req: Request):
    """l'éditeur envoie tout le projet ; les infos tenues par le serveur (statuts d'analyse, proxy, chat) sont gardées."""
    body = await req.json()
    with _plock:
        cur = _project(pid)
        srv = {s['id']: s for s in cur['sources']}
        sources = []
        for s in body.get('sources', []):
            if s['id'] in srv:
                sources.append({**s, **{k: srv[s['id']][k] for k in SERVER_OWNED if k in srv[s['id']]}})
        body['sources'] = sources
        body['chat'] = cur.get('chat', [])
        body['conversations'] = cur.get('conversations', [])
        body['id'] = pid
        body['rev'] = cur.get('rev', 0)
        store.save_project(body)
    return {'rev': body['rev'], 'updatedAt': body['updatedAt']}


@app.delete('/api/projects/{pid}')
def delete_project(pid: str):
    store.delete_project(pid)
    return {'ok': True}


@app.get('/api/projects/{pid}/sources')
def get_sources(pid: str):
    return _project(pid)['sources']


@app.get('/api/projects/{pid}/words/{sid}')
def get_words(pid: str, sid: str):
    return store.get_words(pid, sid)


@app.put('/api/projects/{pid}/words/{sid}')
async def put_words(pid: str, sid: str, req: Request):
    """corrections faites à la main dans la transcription (mot, qui parle)."""
    words = await req.json()
    store.write_json(store.words_path(pid, sid), words)
    return {'ok': True}


def _after_add(pid, sid):
    """à l'import : vidéo légère pour l'aperçu, puis transcription (l'IA et les sous-titres en ont besoin)."""
    p = store.get_project(pid)
    s = store.source(p, sid)
    imp = store.settings().get('import') or {}
    if s['kind'] == 'video' and imp.get('proxy', True):
        start_job(pid, sid, 'proxy')
    if s['kind'] in ('video', 'audio') and imp.get('transcribe', True) and s.get('status', {}).get('transcript') in (None, 'none'):
        start_job(pid, sid, 'transcribe')


@app.post('/api/projects/{pid}/sources')
async def add_source(pid: str, req: Request):
    b = await req.json()
    if b.get('url'):
        def fn(job):
            job.step(0, 'téléchargement…')
            path = media.download(b['url'], f'{store.pdir(pid)}/media', job)
            with _plock:
                p = store.get_project(pid)
                s = media.add_source(p, path, origin=b['url'])
                store.save_project(p)
            _after_add(pid, s['id'])
            return {'source': s['id']}
        job = jobs.submit('download', fn, pid, f"téléchargement {b['url'][:60]}", heavy=False)
        return {'job': job.id}
    paths_in = b.get('paths') or [b['path']]
    added, errors = [], []
    with _plock:
        p = _project(pid)
        for path in paths_in:
            try: added.append(media.add_source(p, path, b.get('name') if len(paths_in) == 1 else None))
            except (FileNotFoundError, ValueError) as e: errors.append(f'{os.path.basename(path)} : {e}')
        store.save_project(p)
    for s in added: _after_add(pid, s['id'])
    if not added: raise HTTPException(400, ' ; '.join(errors) or 'rien à ajouter')
    return {'source': added[0], 'sources': added, 'errors': errors}


@app.post('/api/projects/{pid}/upload')
def upload_source(pid: str, file: UploadFile = File(...)):
    with _plock:
        p = _project(pid)
        path = media.save_upload(p, file.filename, file.file)
        try: s = media.add_source(p, path, file.filename)
        except ValueError as e: raise HTTPException(400, str(e))
        store.save_project(p)
    _after_add(pid, s['id'])
    return {'source': s}


@app.post('/api/projects/{pid}/logo')
def upload_logo(pid: str, file: UploadFile = File(...)):
    with _plock:
        p = _project(pid)
        path = media.save_upload(p, 'logo_' + file.filename, file.file)
        p['logo'] = path; p['logoUrl'] = media.file_url(path)
        store.save_project(p)
    return {'logo': path, 'logoUrl': p['logoUrl']}


@app.delete('/api/projects/{pid}/sources/{sid}')
def delete_source(pid: str, sid: str):
    with _plock:
        p = _project(pid)
        p['sources'] = [s for s in p['sources'] if s['id'] != sid]
        p['timeline'] = [it for it in p['timeline'] if it.get('src') != sid]
        store.save_project(p)
    return {'ok': True}


ACTIONS = {
    'proxy': ('aperçu léger', 'proxy'),
    'transcribe': ('transcription', 'transcript'),
    'speakers': ('qui parle', 'speakers'),
    'stems': ('voix / jeu séparés', 'stems'),
}


def start_job(pid, sid, action):
    label, key = ACTIONS[action]
    p = store.get_project(pid)
    s = store.source(p, sid)

    def fn(job):
        patch_source(pid, sid, status={key: 'running'})
        try:
            p = store.get_project(pid)
            if action == 'proxy':
                url = media.make_proxy(p, sid, job)
                patch_source(pid, sid, proxy=url, status={key: 'done'})
            elif action == 'transcribe':
                n = analyse.transcribe(p, sid, job)
                patch_source(pid, sid, status={key: 'done'})
                return {'words': n}
            elif action == 'speakers':
                counts = analyse.identify(p, sid, job)
                patch_source(pid, sid, status={key: 'done'})
                return {'counts': counts}
            elif action == 'stems':
                st = analyse.stems(p, sid, job)
                patch_source(pid, sid, stems=st, status={key: 'done'})
        except Exception:
            patch_source(pid, sid, status={key: 'error'})
            raise

    return jobs.submit(action, fn, pid, f"{label} — {s['name']}", meta={'source': sid})


@app.post('/api/projects/{pid}/sources/{sid}/{action}')
def source_action(pid: str, sid: str, action: str):
    if action not in ACTIONS: raise HTTPException(404)
    _project(pid)
    return {'job': start_job(pid, sid, action).id}


@app.get('/api/projects/{pid}/moments/{sid}')
def get_moments(pid: str, sid: str):
    return analyse.moments(_project(pid), sid)


@app.post('/api/projects/{pid}/captions')
async def auto_captions(pid: str, req: Request):
    """sous-titres auto pour un plan (bouton « regénérer » de l'inspecteur)."""
    b = await req.json()
    p = _project(pid)
    pack = store.get_pack(p['packId']) or {}
    words = store.get_words(pid, b['src'])
    return analyse.make_captions(words, float(b['in']), float(b['out']), pack.get('style') or {}, p.get('glossary'),
                                 p.get('defaultSpeaker'))


# ------------------------------------------------------------------ IA
@app.post('/api/projects/{pid}/ai')
async def ai(pid: str, req: Request):
    b = await req.json()
    _project(pid)
    if not (b.get('prompt') or '').strip(): raise HTTPException(400, 'demande vide')
    running = [j for j in jobs.JOBS.values() if j.project == pid and j.kind == 'ai' and j.status in ('queued', 'running')]
    if running: raise HTTPException(409, "l'IA travaille déjà sur ce projet")
    mode = b.get('mode') if b.get('mode') in ('auto', 'ask', 'plan') else 'auto'
    job = jobs.submit('ai', lambda job: agent.run(job, pid, b['prompt'].strip(), b.get('context'), b.get('conversation'), mode), pid,
                      'IA : ' + b['prompt'][:60], heavy=False, meta={'conversation': b.get('conversation'), 'mode': mode})
    return {'job': job.id}


@app.post('/api/jobs/{jid}/approve')
async def approve(jid: str, req: Request):
    b = await req.json()
    j = jobs.JOBS.get(jid)
    if not j or not hasattr(j, 'approve'): raise HTTPException(404, 'tâche introuvable')
    if b.get('decision') not in ('allow', 'deny', 'always'): raise HTTPException(400, 'décision : allow, deny ou always')
    if not j.approve(b.get('id'), b['decision']): raise HTTPException(404, 'autorisation introuvable')
    return {'ok': True}


@app.post('/api/projects/{pid}/conversations/{cid}/rewind')
async def rewind(pid: str, cid: str, req: Request):
    b = await req.json()
    try: p = agent.rewind(pid, b['messageId'])
    except KeyError as e: raise HTTPException(404, str(e))
    return {'project': p}


@app.patch('/api/projects/{pid}/conversations/{cid}')
async def rename_conv(pid: str, cid: str, req: Request):
    b = await req.json()
    with _plock:
        p = _project(pid); agent.migrate(p)
        c = agent.get_conv(p, cid)
        if not c: raise HTTPException(404)
        c['title'] = (b.get('title') or c['title'])[:80]
        store.save_project(p)
    return {'ok': True}


@app.delete('/api/projects/{pid}/conversations/{cid}')
def delete_conv(pid: str, cid: str):
    with _plock:
        p = _project(pid); agent.migrate(p)
        p['conversations'] = [c for c in p['conversations'] if c['id'] != cid]
        store.save_project(p)
    try: os.remove(f'{agent.conv_dir(pid)}/{cid}.api.json')
    except FileNotFoundError: pass
    return {'ok': True}


@app.post('/mcp/{jid}/{secret}')
async def mcp(jid: str, secret: str, req: Request):
    msg = await req.json()
    if isinstance(msg, list):
        out = [r for r in (agent.mcp_handle(jid, secret, m) for m in msg) if r]
        return JSONResponse(out) if out else Response(status_code=202)
    import asyncio
    res = await asyncio.to_thread(agent.mcp_handle, jid, secret, msg)
    if res is None: return Response(status_code=202)
    return JSONResponse(res)


@app.get('/mcp/{jid}/{secret}')
def mcp_get(jid: str, secret: str):
    return Response(status_code=405)


# ------------------------------------------------------------------ rendu
@app.post('/api/projects/{pid}/render')
async def render(pid: str, req: Request):
    b = await req.json() if (await req.body()) else {}
    p = _project(pid)
    if not p['timeline']: raise HTTPException(400, 'timeline vide')
    preset = b.get('preset') or ('draft' if b.get('quality') == 'draft' else 'web')
    job = jobs.submit('render', lambda job: R.render(store.get_project(pid), job, preset), pid,
                      f"rendu — {p.get('title') or p['name']}")
    return {'job': job.id}


@app.get('/api/projects/{pid}/renders')
def renders(pid: str):
    return R.list_renders(_project(pid))


@app.get('/api/projects/{pid}/render-props')
def render_props(pid: str):
    return R.props_for(_project(pid))


# ------------------------------------------------------------------ tâches
@app.get('/api/jobs')
def list_jobs(project: str | None = None):
    return jobs.active(project)


@app.get('/api/jobs/{jid}')
def get_job(jid: str, since: int = 0):
    j = jobs.JOBS.get(jid)
    if not j: raise HTTPException(404)
    return j.public(since)


@app.post('/api/jobs/{jid}/cancel')
def cancel_job(jid: str):
    j = jobs.cancel(jid)
    if not j: raise HTTPException(404)
    return j.public()


# ------------------------------------------------------------------ packs
@app.get('/api/packs')
def packs():
    return store.list_packs()


@app.post('/api/packs')
async def create_pack(req: Request):
    b = await req.json()
    base = store.get_pack(b.pop('from', None) or '') or {}
    pk = json.loads(json.dumps(base)); pk.pop('id', None)
    pk.update(b)
    return store.save_pack(pk)


# ------------------------------------------------------------------ stockage (caches recalculables)
CACHE_KINDS = {'previews': 'previews', 'features': 'features', 'stems': 'stems', 'refs': 'refs', 'ai': 'claude-cli'}


def _dir_size(d):
    tot = 0
    for root, _, files in os.walk(d):
        for f in files:
            try: tot += os.path.getsize(os.path.join(root, f))
            except OSError: pass
    return tot


@app.get('/api/storage')
def storage():
    out = {k: _dir_size(os.path.join(config.CACHE, v)) for k, v in CACHE_KINDS.items()}
    out['projects'] = _dir_size(config.PROJECTS)
    out['engine'] = _dir_size(os.path.join(config.DATA, 'engine-env')) if os.path.isdir(os.path.join(config.DATA, 'engine-env')) else 0
    return out


@app.post('/api/storage/clear')
async def storage_clear(req: Request):
    import shutil
    b = await req.json()
    done = []
    for k in b.get('what') or []:
        if k in CACHE_KINDS:
            shutil.rmtree(os.path.join(config.CACHE, CACHE_KINDS[k]), ignore_errors=True)
            done.append(k)
    return {'cleared': done, **storage()}


# ------------------------------------------------------------------ mes effets (préréglages d'image enregistrés)
PRESETS_F = os.path.join(config.DATA, 'effect-presets.json')


@app.get('/api/presets')
def list_presets():
    return store.read_json(PRESETS_F, [])


@app.post('/api/presets')
async def add_preset(req: Request):
    b = await req.json()
    if not (b.get('name') or '').strip(): raise HTTPException(400, 'donne un nom à l’effet')
    pr = {'id': store.new_id('fx'), 'name': b['name'].strip()[:60], 'look': b.get('look') or {}, 'createdAt': time.time()}
    items = [x for x in store.read_json(PRESETS_F, []) if x['name'] != pr['name']] + [pr]
    store.write_json(PRESETS_F, items)
    return pr


@app.delete('/api/presets/{fid}')
def del_preset(fid: str):
    store.write_json(PRESETS_F, [x for x in store.read_json(PRESETS_F, []) if x['id'] != fid])
    return {'ok': True}


@app.post('/api/packs/generate')
async def generate_pack(req: Request):
    b = await req.json()
    if not (b.get('description') or '').strip(): raise HTTPException(400, 'décris le style voulu')
    from .ai import stylegen
    job = jobs.submit('style', lambda job: stylegen.generate(job, b['description'].strip(), (b.get('reference') or '').strip() or None,
                                                          (b.get('name') or '').strip() or None), None, 'création du style', heavy=False)
    return {'job': job.id}


@app.put('/api/packs/{pk_id}')
async def put_pack(pk_id: str, req: Request):
    b = await req.json(); b['id'] = pk_id
    return store.save_pack(b)


@app.delete('/api/packs/{pk_id}')
def del_pack(pk_id: str):
    store.delete_pack(pk_id)
    return {'ok': True}


# ------------------------------------------------------------------ personnes
@app.get('/api/speakers')
def speakers():
    return store.list_speakers()


@app.post('/api/speakers')
async def create_speaker(req: Request):
    b = await req.json()
    import re as _re
    sid = _re.sub(r'[^a-z0-9_]+', '_', (b.get('name') or 'personne').lower()).strip('_')[:20] or None
    if sid and store.get_speaker(sid): sid = None
    return store.save_speaker({'id': sid, 'name': b.get('name', 'Personne'), 'color': b.get('color', '#D5C2FF'),
                               'aliases': b.get('aliases', []), 'description': b.get('description', ''),
                               'preferences': b.get('preferences', ''), 'samples': []})


@app.put('/api/speakers/{sid}')
async def put_speaker(sid: str, req: Request):
    b = await req.json()
    cur = store.get_speaker(sid) or {}
    cur.update({k: v for k, v in b.items() if k not in ('id', 'samples', 'hasVoice')}); cur['id'] = sid
    return store.save_speaker(cur)


@app.delete('/api/speakers/{sid}')
def del_speaker(sid: str):
    store.delete_speaker(sid)
    return {'ok': True}


@app.post('/api/speakers/{sid}/enroll')
async def enroll(sid: str, req: Request):
    b = await req.json()
    p = _project(b['project'])
    def fn(job):
        job.step(0.1, 'empreinte vocale…')
        return analyse.enroll_from_source(sid, p, b['source'], float(b['t0']), float(b['t1']))
    return {'job': jobs.submit('enroll', fn, p['id'], f'voix de {sid}').id}


@app.post('/api/speakers/{sid}/record')
def record(sid: str, file: UploadFile = File(...)):
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename or '.webm')[1] or '.webm')
    tmp.write(file.file.read()); tmp.close()
    def fn(job):
        job.step(0.1, 'empreinte vocale…')
        try: return analyse.enroll_from_file(sid, tmp.name)
        finally: os.remove(tmp.name)
    return {'job': jobs.submit('enroll', fn, None, f'voix de {sid}').id}


@app.post('/api/speakers/{sid}/reset-voice')
def reset_voice(sid: str):
    for ext in ('npy', 'npz'):
        try: os.remove(f'{config.PEOPLE}/{sid}.{ext}')
        except FileNotFoundError: pass
    sp = store.get_speaker(sid); sp['samples'] = []
    return store.save_speaker(sp)


# ------------------------------------------------------------------ interface (build Vite)
if os.path.isdir(config.WEB_DIST):
    app.mount('/assets', StaticFiles(directory=f'{config.WEB_DIST}/assets'), name='assets')

    @app.get('/{full:path}')
    def spa(full: str):
        f = f'{config.WEB_DIST}/{full}'
        if full and os.path.isfile(f): return FileResponse(f)
        return FileResponse(f'{config.WEB_DIST}/index.html')
