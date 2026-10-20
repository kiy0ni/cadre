"""L'assistant de montage de Cadre, façon Claude Code : conversations suivies, modes (auto / demander avant / plan), autorisations par
modification, blocs d'outils, points de retour (checkpoints). Deux façons de joindre Claude, mêmes outils (ai/tools.py) :
  - « api »         : API Anthropic (clé ANTHROPIC_API_KEY ou profil `ant auth login`), boucle d'outils ici, historique
                      de la conversation conservé (data/projects/<id>/conversations/<conv>.api.json) ;
  - « claude-code » : ton abonnement Claude Code (`claude -p`, session reprise avec --resume), outils donnés par un petit
                      serveur MCP exposé par l'appli (/mcp/<tâche>/<secret>).
Chaque outil qui modifie le projet le pousse à l'éditeur : on voit le montage se construire en direct."""
import base64, os, json, shutil, secrets, subprocess, threading, time, uuid
from .. import store, analyse
from ..config import BASE_URL, CACHE
from . import tools as T

SESSIONS = {}          # id de tâche -> {ctx, secret, lock, job, mode, allow_all}
MUTATING = {n for n, _, _, _, m in T.TOOLS if m} | {'noter_preference'}
EDITABLE = ('timeline', 'music', 'tracks', 'mix', 'markers', 'title', 'preferences', 'overrides', 'glossary', 'format', 'packId',
            'speakers', 'defaultSpeaker')


# ------------------------------------------------------------------ consigne
BASE = """Tu es l'assistant de montage intégré à Cadre, un logiciel de montage vidéo professionnel. Tu montes en appelant des
outils qui modifient le projet ; la personne voit chaque modification en direct et peut tout retoucher à la main. Tu peux
faire tout le montage seul, du dérushage à l'étalonnage, ou seulement une retouche : suis la demande et le style du projet.

Comment marche la timeline :
- Une suite d'éléments joués l'un après l'autre (piste V1) : plans (extraits d'une source), cartons (titre, chapitre, narration, image, réseaux), arrêts sur image, médias (vidéo ou image plein écran).
- Par-dessus, des pistes libres (comme dans Premiere) : textes et incrustations (images, logos, vidéos, éléments sur fond vert) placés en temps de
  vidéo montée, et pistes audio. Chaque élément peut avoir une transition d'entrée, un étalonnage et un transform.
- Les temps des plans, sous-titres et effets sont en SECONDES DANS LA SOURCE (ceux de la transcription), jamais en temps de sortie.
- Les clips des pistes libres se règlent avec modifier_clip_piste / supprimer_clips_piste ; les niveaux avec mixage ; le
  format (vertical, carré…) avec format_projet ; des repères pour la personne avec marqueurs. N'exporte que si on te le demande.
- Automatique au rendu (ne le refais pas à la main) : coupes des silences dans les plans (selon le style), vitesse de base,
  censure des gros mots si le style la demande, baisse de la musique sous la voix, couleur des sous-titres selon la
  personne qui parle.
- ajouter_plan génère les sous-titres depuis la transcription et te les renvoie : relis-les (mots faux, découpage, qui parle,
  « ! » = style hype, cri = style cri) et corrige seulement ce qui doit l'être avec modifier_sous_titres.

Méthode :
1. etat_projet d'abord. Sur une longue source, moments_forts puis lire_transcription sur les passages utiles (jamais tout
   lire). Utilise regarder pour voir l'image quand le visuel compte (où est le sujet, ce qui se passe, un texte à l'écran),
   et regarder_montage pour vérifier le résultat aux moments importants.
2. Pour un montage complet : définis le titre (definir_titre) selon le style du pack, puis construis la structure du pack
   dans l'ordre, plan par plan, avec effets, sons et musiques. Vérifie à la fin avec etat_projet (durée, ordre).
3. Pour une retouche : ne touche qu'à ce qui est demandé. « ici » / « ce plan » = le contexte de l'éditeur donné avec la demande ;
   les mentions @… désignent des éléments par leur id.
4. On te donne une vidéo en exemple (lien, fichier) ? Ouvre-la avec analyser_video (sur la partie concernée) : tu vois ses
   images et tu sais quels sons / musiques de la bibliothèque y sont utilisés, à quels instants. Reproduis ce qui est
   reconnu (mêmes noms de sons, mêmes décalages, même morceau et même position dans le morceau) au lieu de deviner.
   Ne dis jamais que tu ne peux pas ouvrir une vidéo.
5. Ne jamais inventer ce qui n'est pas dans la transcription ou l'image (histoire, noms, répliques). Les titres de fichiers
   ou de clips peuvent être trompeurs : base-toi sur ce qui est dit et montré.
6. Quand on te donne un retour durable (« à chaque fois… », « retiens… »), enregistre-le avec noter_preference.
7. Si une modification est refusée par la personne, n'insiste pas : demande ce qu'elle préfère ou passe à la suite.
8. Réponds dans la langue de la personne (celle de sa demande, ou celle indiquée dans le contexte ; le français par défaut,
   en tutoyant). Termine par un message court (Markdown léger) : ce que tu as fait, la durée obtenue, ce qu'il faut
   vérifier. Pas de longue liste."""

MODE_NOTE = {
    'plan': ("[Mode plan] N'appelle AUCUN outil de modification (ils sont bloqués). Lis le projet et les transcriptions, puis "
             "réponds avec un plan de montage numéroté, concret (passages avec leurs temps, effets, musiques, durée visée). "
             "La personne cliquera « Exécuter le plan » si ça lui va."),
    'ask': "[Mode « demander avant de modifier »] Chaque modification est soumise à l'accord de la personne.",
    'auto': '',
}


def system_prompt(p):
    pack = store.get_pack(p['packId']) or {}
    sps = {s['id']: s for s in store.list_speakers()}
    lines = [BASE, '', f"# Style de montage : {pack.get('name', p['packId'])}", pack.get('description', ''),
             f"Structure : {pack.get('structure', '')}", f"Format : {p['format']['width']}x{p['format']['height']}", '',
             pack.get('rules', ''), '', '# Réglages de rendu du style', json.dumps(pack.get('style', {}), ensure_ascii=False), '',
             '# Personnes (voix) — id : nom, description, préférences']
    default = p.get('defaultSpeaker')
    for sid in p.get('speakers', []):
        s = sps.get(sid)
        if not s: continue
        lines.append(f"- {sid}{' (personne principale : sous-titres sans préfixe)' if sid == default else ''} : {s['name']}"
                     f"{' alias ' + ', '.join(s.get('aliases', [])) if s.get('aliases') else ''} — {s.get('description', '')}"
                     f"{' — PRÉFÉRENCES : ' + s['preferences'] if s.get('preferences') else ''}"
                     f"{'' if s.get('hasVoice') else ' (pas d’empreinte vocale)'}")
    return '\n'.join(lines)


def first_turn_context(p):
    parts = []
    if p.get('preferences'):
        parts.append('# Préférences de ce projet\n' + p['preferences'])
    if p.get('glossary'):
        parts.append('# Glossaire (mots souvent mal transcrits → bonne orthographe)\n' +
                     ', '.join(f'{k} → {v}' for k, v in p['glossary'].items()))
    return parts


def user_turn(p, request, context, mode, first):
    parts = first_turn_context(p) if first else []
    if context:
        c = []
        if context.get('selected'): c.append(f"élément sélectionné : {context['selected']}")
        if context.get('time') is not None: c.append(f"tête de lecture : {context['time']}")
        LANGS = {'en': 'anglais', 'es': 'espagnol', 'de': 'allemand', 'it': 'italien', 'pt': 'portugais', 'ja': 'japonais'}
        if context.get('lang') in LANGS: c.append(f"langue de l'interface : {LANGS[context['lang']]} — réponds dans cette langue")
        if c: parts.append('# Contexte dans l’éditeur\n' + ' ; '.join(c))
    if MODE_NOTE.get(mode): parts.append(MODE_NOTE[mode])
    parts.append(('# Demande\n' if parts else '') + request)
    return '\n\n'.join(parts)


# ------------------------------------------------------------------ choix du fournisseur
def api_credentials():
    if os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('ANTHROPIC_AUTH_TOKEN'): return 'variable d’environnement'
    if os.path.isdir(os.path.expanduser('~/.config/anthropic')) and shutil.which('ant'): return 'profil ant'
    return None


def provider(settings):
    pv = settings['ai'].get('provider', 'auto')
    if pv != 'auto': return pv
    if api_credentials(): return 'api'
    if shutil.which('claude'): return 'claude-code'
    return None


def status(settings):
    return {'provider': provider(settings), 'api': api_credentials(), 'claudeCode': bool(shutil.which('claude')),
            'settings': settings['ai']}


# ------------------------------------------------------------------ conversations
def conv_dir(pid):
    d = f'{store.pdir(pid)}/conversations'
    os.makedirs(d, exist_ok=True)
    return d


def migrate(p):
    """ancien chat (liste plate) -> une conversation."""
    if p.get('conversations') is not None: return False
    convs = []
    if p.get('chat'):
        msgs = []
        for m in p['chat']:
            if m['role'] == 'user': msgs.append({'id': m['id'], 'role': 'user', 'text': m['text'], 't': m.get('t', 0)})
            else: msgs.append({'id': m['id'], 'role': 'assistant', 't': m.get('t', 0), 'status': 'done', 'changes': m.get('changes', 0),
                               'blocks': [{'type': 'text', 'text': m['text']}]})
        convs.append({'id': store.new_id('cv'), 'title': (p['chat'][0]['text'][:48] if p['chat'] else 'Conversation'),
                      'createdAt': time.time(), 'updatedAt': time.time(), 'messages': msgs})
    p['conversations'] = convs
    return True


def get_conv(p, cid):
    for c in p.get('conversations', []):
        if c['id'] == cid: return c
    return None


def snapshot(p):
    return {k: json.loads(json.dumps(p.get(k))) for k in EDITABLE if k in p}


def save_checkpoint(p, msg_id):
    d = f'{store.pdir(p["id"])}/checkpoints'
    os.makedirs(d, exist_ok=True)
    store.write_json(f'{d}/{msg_id}.json', snapshot(p))


def rewind(pid, msg_id):
    p = store.get_project(pid)
    snap = store.read_json(f'{store.pdir(pid)}/checkpoints/{msg_id}.json')
    if snap is None: raise KeyError('point de retour introuvable')
    for k in EDITABLE:
        if k in snap: p[k] = snap[k]
    store.save_project(p)
    return p


# ------------------------------------------------------------------ une demande
class Turn:
    """réponse de l'IA en cours : blocs (texte, réflexion, outils) envoyés à l'éditeur et enregistrés à la fin."""
    def __init__(self, job):
        self.job, self.blocks, self.t0 = job, [], time.time()
        self.usage = {'input': 0, 'output': 0, 'cacheRead': 0, 'cost': None}
        self.changes = 0

    def text(self, delta):
        if self.blocks and self.blocks[-1]['type'] == 'text' and not self.blocks[-1].get('closed'):
            self.blocks[-1]['text'] += delta
        else:
            self.blocks.append({'type': 'text', 'text': delta})
        self.job.emit('delta', text=delta)

    def close_text(self):
        if self.blocks and self.blocks[-1]['type'] == 'text': self.blocks[-1]['closed'] = True
        self.job.emit('delta_end')

    def thinking(self, delta):
        if self.blocks and self.blocks[-1]['type'] == 'thinking':
            self.blocks[-1]['text'] += delta
        else:
            self.blocks.append({'type': 'thinking', 'text': delta})
        self.job.emit('note', text=delta)

    def public(self):
        return [{k: v for k, v in b.items() if k != 'closed'} for b in self.blocks]


def run(job, pid, request, context=None, conv_id=None, mode='auto'):
    settings = store.settings()
    pv = provider(settings)
    if not pv:
        raise RuntimeError("aucune IA disponible : ajoute une clé API (ANTHROPIC_API_KEY) ou installe Claude Code")
    p = store.get_project(pid)
    migrate(p)
    conv = get_conv(p, conv_id) if conv_id else None
    first = conv is None or not any(m['role'] == 'assistant' for m in conv['messages'])
    if conv is None:
        conv = {'id': store.new_id('cv'), 'title': request.strip().split('\n')[0][:48] or 'Conversation', 'createdAt': time.time(),
                'updatedAt': time.time(), 'messages': [], 'provider': pv}
        p['conversations'].insert(0, conv)
    umsg = {'id': store.new_id('u'), 'role': 'user', 'text': request, 't': time.time(), 'mode': mode,
            'context': (context or {}).get('selected')}
    save_checkpoint(p, umsg['id'])
    conv['messages'].append(umsg)
    conv['updatedAt'] = time.time()
    store.save_project(p)
    job.meta['conversation'] = conv['id']
    job.emit('conversation', id=conv['id'], userMessage=umsg)
    job.emit('project', project=p)
    _prepare_sources(job, p)

    turn = Turn(job)
    def on_change(proj):
        turn.changes += 1
        job.emit('project', project=proj)
    ctx = T.Ctx(p, on_change=on_change, log=lambda s: job.emit('log', text=s))
    sess = {'ctx': ctx, 'secret': secrets.token_urlsafe(16), 'lock': threading.Lock(), 'job': job, 'mode': mode,
            'allow_all': mode == 'auto', 'turn': turn, 'pending': {}}
    SESSIONS[job.id] = sess
    job.approve = lambda call_id, decision: _decide(sess, call_id, decision)
    status_ = 'done'
    err = None
    try:
        prompt = user_turn(ctx.p, request, context, mode, first)
        if pv == 'api': _run_api(job, sess, settings, prompt, conv)
        else: _run_cli(job, sess, settings, prompt, conv)
    except T.ToolError as e:
        status_ = 'cancelled' if job.cancelled else 'error'; err = str(e)
    except Exception as e:
        status_ = 'cancelled' if job.cancelled else 'error'; err = f'{type(e).__name__}: {e}'
        if status_ == 'error': raise
    finally:
        SESSIONS.pop(job.id, None)
        p = ctx.p
        c = get_conv(p, conv['id']) or conv
        amsg = {'id': store.new_id('a'), 'role': 'assistant', 't': time.time(), 'blocks': turn.public(), 'status': status_,
                'error': err, 'changes': turn.changes, 'usage': turn.usage, 'durationMs': int((time.time() - turn.t0) * 1000),
                'provider': pv, 'mode': mode}
        for b in amsg['blocks']:                 # une autorisation restée en attente (arrêt) = refusée
            if b.get('status') in ('pending', 'running'): b['status'] = 'denied' if b.get('status') == 'pending' else 'error'
        c['messages'].append(amsg)
        c['updatedAt'] = time.time()
        store.save_project(p)
        job.emit('project', project=p)
    return {'conversation': conv['id'], 'changes': turn.changes}


def _prepare_sources(job, p):
    todo = [s for s in p['sources'] if s['kind'] in ('video', 'audio') and not store.get_words(p['id'], s['id'])]
    for s in todo:
        job.step(None, f"transcription de {s['name']} avant de monter…")
        s['status']['transcript'] = 'running'
        n = analyse.transcribe(p, s['id'], job)
        s['status']['transcript'] = 'done'
        store.save_project(p)
        job.emit('project', project=p)
        job.emit('log', text=f"{s['name']} : {n} mots transcrits")


def _decide(sess, call_id, decision):
    ev = sess['pending'].get(call_id)
    if not ev: return False
    if decision == 'always': sess['allow_all'] = True
    ev['decision'] = decision
    ev['event'].set()
    return True


def _tool_call(sess, name, args, call_id=None):
    """exécute un outil avec les règles du mode (plan : lecture seule ; demander : accord de la personne)."""
    job, turn = sess['job'], sess['turn']
    call_id = call_id or store.new_id('tc')
    block = {'type': 'tool', 'id': call_id, 'name': name, 'label': T.summary(name, args), 'input': args, 'status': 'running'}
    turn.blocks.append(block)
    job.emit('tool_start', block=block)
    if name in MUTATING:
        if sess['mode'] == 'plan':
            out = "ERREUR : mode plan, aucune modification autorisée. Propose le plan dans ta réponse."
            block.update(status='denied', result=out)
            job.emit('tool_end', id=call_id, status='denied', result=out)
            return out, True, []
        if not sess['allow_all']:
            ev = {'event': threading.Event(), 'decision': None}
            sess['pending'][call_id] = ev
            block['status'] = 'pending'
            job.emit('approval', id=call_id, block=block)
            while not ev['event'].wait(0.5):
                if job.cancelled: raise T.ToolError('annulé')
            sess['pending'].pop(call_id, None)
            if ev['decision'] == 'deny':
                out = "La personne a REFUSÉ cette modification. Ne la refais pas ; demande ce qu'elle préfère ou passe à la suite."
                block.update(status='denied', result=out)
                job.emit('tool_end', id=call_id, status='denied', result=out)
                return out, True, []
            block['status'] = 'running'
            job.emit('tool_status', id=call_id, status='running')
    out, err, images = T.run(sess['ctx'], name, args)
    block.update(status='error' if err else 'done', result=out[:4000] + (f' [{len(images)} image(s)]' if images else ''))
    job.emit('tool_end', id=call_id, status=block['status'], result=block['result'])
    return out, err, images


# ------------------------------------------------------------------ API Anthropic
def _run_api(job, sess, settings, prompt, conv):
    import anthropic
    client = anthropic.Anthropic()
    ctx = sess['ctx']
    model = settings['ai'].get('model') or 'claude-opus-5-5'
    effort = settings['ai'].get('effort') or 'high'
    system = [{'type': 'text', 'text': system_prompt(ctx.p), 'cache_control': {'type': 'ephemeral'}}]
    tools = [dict(t, eager_input_streaming=True) for t in T.schemas()]
    hist_path = f"{conv_dir(ctx.p['id'])}/{conv['id']}.api.json"
    messages = store.read_json(hist_path, [])
    n0 = len(messages)
    messages.append({'role': 'user', 'content': prompt})
    extras = {'betas': ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'], 'fallbacks': 'default',
              'thinking': {'type': 'adaptive', 'display': 'updates'}}
    turn = sess['turn']
    completed = False
    try:
        for _ in range(80):
            job.step(None)
            try:
                msg = _stream_turn(job, turn, client, model, effort, system, tools, messages, extras)
            except anthropic.BadRequestError as e:
                if not extras.get('betas'): raise
                job.emit('log', text=f'réglages avancés refusés ({e.message[:120]}), nouvel essai sans')
                extras = {'thinking': {'type': 'adaptive'}}
                msg = _stream_turn(job, turn, client, model, effort, system, tools, messages, extras)
            messages.append({'role': 'assistant', 'content': [b.model_dump(mode='json', exclude_none=True) for b in msg.content]})
            u = msg.usage
            turn.usage['input'] += (u.input_tokens or 0) + (getattr(u, 'cache_creation_input_tokens', 0) or 0)
            turn.usage['cacheRead'] += getattr(u, 'cache_read_input_tokens', 0) or 0
            turn.usage['output'] += u.output_tokens or 0
            job.emit('usage', usage=turn.usage)
            if msg.stop_reason == 'refusal':
                turn.text("\n\nClaude a refusé cette demande."); turn.close_text(); completed = True; return
            uses = [b for b in msg.content if b.type == 'tool_use']
            if msg.stop_reason == 'max_tokens' and uses:
                messages.append({'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': b.id, 'is_error': True,
                                 'content': 'ERREUR : réponse coupée (trop longue), refais cet appel en plus petit'} for b in uses]})
                continue
            if not uses:
                completed = True; return
            results = []
            for b in uses:
                args = b.input if isinstance(b.input, dict) else None
                if args is None: out, err, images = 'ERREUR : arguments illisibles (INVALID_JSON), recommence', True, []
                else: out, err, images = _tool_call(sess, b.name, args, b.id)
                content = [{'type': 'text', 'text': out[:60000] or '(vide)'}] + [
                    {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': base64.b64encode(im).decode()}}
                    for im in images]
                results.append({'type': 'tool_result', 'tool_use_id': b.id, 'content': content, 'is_error': err})
            messages.append({'role': 'user', 'content': results})
        turn.text('\n(arrêt : trop d’étapes)')
    finally:
        # un tour interrompu (erreur, arrêt) n'est pas gardé dans l'historique : l'API refuserait un tour coupé au milieu
        # d'outils. L'IA retrouvera l'état réel du montage avec etat_projet.
        if not completed: del messages[n0:]
        store.write_json(hist_path, messages)


def _stream_turn(job, turn, client, model, effort, system, tools, messages, extras):
    kw = dict(model=model, max_tokens=64000, system=system, tools=tools, messages=messages, output_config={'effort': effort}, **extras)
    got_text = False
    with client.beta.messages.stream(**kw) as stream:
        for ev in stream:
            if job.cancelled: raise T.ToolError('annulé')
            if ev.type == 'content_block_delta':
                d = ev.delta
                if d.type == 'text_delta':
                    got_text = True; turn.text(d.text)
                elif d.type == 'thinking_delta' and getattr(d, 'thinking', ''):
                    turn.thinking(d.thinking)
            elif ev.type == 'content_block_stop' and got_text:
                turn.close_text(); got_text = False
        return stream.get_final_message()


# ------------------------------------------------------------------ Claude Code (abonnement)
def _run_cli(job, sess, settings, prompt, conv):
    ctx, turn = sess['ctx'], sess['turn']
    url = f"{BASE_URL}/mcp/{job.id}/{sess['secret']}"
    mcp = json.dumps({'mcpServers': {'cadre': {'type': 'http', 'url': url}}})
    model = settings['ai'].get('cliModel') or 'opus'
    work = f'{CACHE}/claude-cli'
    os.makedirs(work, exist_ok=True)
    cmd = [shutil.which('claude') or 'claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model,
           '--system-prompt', system_prompt(ctx.p), '--mcp-config', mcp, '--strict-mcp-config',
           '--tools', '', '--allowedTools', 'mcp__cadre', '--setting-sources', 'local']
    resumed = bool(conv.get('sessionId'))
    if resumed: cmd += ['--resume', conv['sessionId']]
    else:
        conv['sessionId'] = str(uuid.uuid4())
        cmd += ['--session-id', conv['sessionId']]
    env = dict(os.environ, MCP_TOOL_TIMEOUT='900000')          # une autorisation peut attendre la personne
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=work, env=env)
    job.proc = proc
    proc.stdin.write(prompt); proc.stdin.close()
    final, streamed, partial = None, False, False
    for line in proc.stdout:
        try: ev = json.loads(line)
        except json.JSONDecodeError: continue
        t = ev.get('type')
        if t == 'stream_event':
            partial = True
            e = ev.get('event', {})
            if e.get('type') == 'content_block_delta':
                d = e.get('delta', {})
                if d.get('type') == 'text_delta': streamed = True; turn.text(d.get('text', ''))
                elif d.get('type') == 'thinking_delta' and d.get('thinking'): turn.thinking(d['thinking'])
            elif e.get('type') == 'content_block_stop' and streamed:
                turn.close_text(); streamed = False
        elif t == 'assistant' and not partial:
            for b in ev.get('message', {}).get('content', []):            # sans flux partiel : le texte arrive en bloc
                if b.get('type') == 'text' and b.get('text', '').strip():
                    turn.text(b['text']); turn.close_text()
        elif t == 'result':
            final = ev
            u = ev.get('usage') or {}
            turn.usage.update(input=(u.get('input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0),
                              cacheRead=u.get('cache_read_input_tokens') or 0, output=u.get('output_tokens') or 0,
                              cost=ev.get('total_cost_usd'))
            job.emit('usage', usage=turn.usage)
            if ev.get('is_error'):
                if resumed and 'session' in str(ev.get('result', '')).lower():
                    conv.pop('sessionId', None)
                raise RuntimeError(f"Claude Code : {ev.get('result') or ev.get('subtype')}")
    code = proc.wait()
    if job.cancelled: raise T.ToolError('annulé')
    if code != 0 and not final:
        err = (proc.stderr.read() or '')[-400:]
        if resumed and 'session' in err.lower(): conv.pop('sessionId', None)
        raise RuntimeError('Claude Code a échoué : ' + err)
    store.save_project(ctx.p)


def mcp_handle(job_id, secret, msg):
    """serveur MCP minimal (HTTP « streamable », réponses JSON) : initialize, tools/list, tools/call."""
    sess = SESSIONS.get(job_id)
    if not sess or not secrets.compare_digest(secret, sess['secret']):
        return {'jsonrpc': '2.0', 'id': msg.get('id'), 'error': {'code': -32001, 'message': 'session inconnue'}}
    method, mid = msg.get('method'), msg.get('id')
    if mid is None:
        return None
    if method == 'initialize':
        ver = (msg.get('params') or {}).get('protocolVersion') or '2025-06-18'
        res = {'protocolVersion': ver, 'capabilities': {'tools': {'listChanged': False}},
               'serverInfo': {'name': 'cadre', 'version': '1.0'}}
    elif method == 'tools/list':
        res = {'tools': [{'name': n, 'description': d, 'inputSchema': s} for n, d, s, _, _ in T.TOOLS]}
    elif method == 'tools/call':
        prm = msg.get('params') or {}
        with sess['lock']:
            out, err, images = _tool_call(sess, prm.get('name'), prm.get('arguments') or {})
        res = {'content': [{'type': 'text', 'text': out}] + [{'type': 'image', 'data': base64.b64encode(im).decode(), 'mimeType': 'image/jpeg'}
                                                            for im in images], 'isError': err}
    elif method == 'ping':
        res = {}
    else:
        return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'méthode inconnue {method}'}}
    return {'jsonrpc': '2.0', 'id': mid, 'result': res}
