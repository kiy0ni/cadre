"""Cadre's editing assistant, Claude Code style: persistent conversations, modes (auto / ask before / plan), per-change
approvals, tool blocks, checkpoints. Two ways to reach Claude, same tools (ai/tools.py):
  - "api"         : Anthropic API (ANTHROPIC_API_KEY or an `ant auth login` profile), tool loop runs here, conversation
                    history kept (data/projects/<id>/conversations/<conv>.api.json);
  - "claude-code" : your Claude Code subscription (`claude -p`, session resumed with --resume), tools served by a small
                    MCP server exposed by the app (/mcp/<job>/<secret>).
Every tool that changes the project pushes it to the editor: the edit takes shape live."""
import base64, os, json, shutil, secrets, subprocess, threading, time, uuid
from .. import store, analyse
from ..config import BASE_URL, CACHE
from . import tools as T

SESSIONS = {}          # job id -> {ctx, secret, lock, job, mode, allow_all}
MUTATING = {n for n, _, _, _, m in T.TOOLS if m} | {'noter_preference'}
EDITABLE = ('timeline', 'music', 'tracks', 'mix', 'markers', 'title', 'preferences', 'overrides', 'glossary', 'format', 'packId',
            'speakers', 'defaultSpeaker')


# ------------------------------------------------------------------ system prompt
BASE = """You are the editing assistant built into Cadre, a professional video editing app. You edit by calling tools that
change the project; the person sees every change live and can adjust anything by hand. You can do the whole edit on your
own, from logging the footage to color grading, or just a single touch-up: follow the request and the project's style.

How the timeline works:
- A sequence of items played one after another (track V1): shots (excerpts of a source), cards (title, chapter, narration, image, socials), freeze frames, media (full-screen video or image).
- On top, free tracks (as in Premiere): texts and overlays (images, logos, videos, green-screen elements) placed in
  edited-video time, plus audio tracks. Every item can have an entry transition, a color grade and a transform.
- Times of shots, captions and effects are in SECONDS IN THE SOURCE (those of the transcript), never in output time.
- Free-track clips are adjusted with modifier_clip_piste / supprimer_clips_piste; levels with mixage; the
  format (vertical, square…) with format_projet; markers for the person with marqueurs. Only export if asked to.
- Automatic at render time (don't redo it by hand): silence cuts inside shots (depending on the style), base speed,
  bleeping of swear words if the style asks for it, music ducking under the voice, caption color based on who is
  speaking.
- ajouter_plan generates the captions from the transcript and returns only those containing words the transcription was
  unsure about: fix only what is wrong (word, who is speaking, "!" = hype style, shouting = cri style) with
  modifier_sous_titres; don't reread the others.
- V1 items can leave an empty gap before them (modifier_element espace_avant, in seconds); background music is an
  audio clip on the Music lane (modifier_clip_piste: debut_sortie, duree, depart_fichier, volume_db…).
- delier_audio splits a shot's sound from its picture (J-cut / L-cut: the next shot's sound starts under the end of the
  previous one); the resulting audio clips are moved with modifier_clip_piste.
- A track locked by the person is off-limits.

Method — work like an agent, step by step and visibly:
0. For a full edit or a multi-part request: first call etapes (3 to 7 concrete steps, e.g.
   "Find the best moments", "Lay out the intro", "Cut the core of the video", "Captions and sounds",
   "Music", "Check the result") and tick them off as you go. Before each step, write one short sentence
   (what you are about to do). Place shots one by one, in order, so the person sees the edit take shape;
   no long silent thinking followed by everything at once.
1. etat_projet first. On a long source, moments_forts then lire_transcription on the useful passages (never read
   everything). Use regarder to see the picture when visuals matter (where the subject is, what is happening, on-screen
   text), and regarder_montage to check the result at key moments.
2. For a full edit: set the title (definir_titre) following the pack's style, then build the pack's structure
   in order, shot by shot, with effects, sounds and music. Check at the end with etat_projet (duration, order).
3. For a touch-up: only change what was asked. "here" / "this shot" = the editor context given with the request;
   @… mentions refer to items by their id.
4. Given a video as an example (link, file)? Open it with analyser_video (on the relevant part): you see its
   frames and you know which library sounds / music tracks it uses, and at what times. Reproduce what was
   recognized (same sound names, same offsets, same track and same position in the track) instead of guessing.
   Never say you cannot open a video.
5. Quality — what people complain about most in AI-made edits:
   - never cut in the middle of a word or a sentence: shot boundaries on word starts / ends from the transcript,
     with a little breathing room (≈0.1 s before, 0.2 s after);
   - a chosen moment keeps its setup AND its payoff (the context of an answer, the end of a joke, the reaction);
   - stay restrained by default: readable captions, effects and sound effects where they serve, not on every sentence;
     heavier only if the style or the request calls for it;
   - a new project with no instructions: a clean, watchable edit first, the person will refine it with you afterwards.
6. Never invent what is not in the transcript or the picture (story, names, lines). File or clip titles
   can be misleading: rely on what is said and shown.
7. When given lasting feedback ("every time…", "remember…"), save it with noter_preference.
8. If the person rejects a change, don't insist: ask what they prefer or move on.
9. Be economical with tokens (the person pays for them): read only the transcript ranges you need, don't call
   etat_projet again unless the project changed outside your tools, look at a frame only when the picture matters
   (5 per request at most unless asked), put several changes in one call when a tool accepts lists, no full-video
   verification pass unless asked, update etapes only when a step changes, and keep your messages short.
10. Reply in the person's language (the language of their request, or the interface language given in the context);
   when replying in French, use "tu". End with a short message (light Markdown): what you did and why (main choices),
   the resulting duration, what to check (doubtful transcript words, hesitant passages), and 1 or 2 touch-up ideas
   the person can ask you for. No long list: the editor already shows the details of the changes."""

MODE_NOTE = {
    'plan': ("[Plan mode] Do NOT call any editing tool (they are blocked). Read the project and the transcripts, then "
             "reply with a concrete, numbered edit plan (passages with their times, effects, music, target duration). "
             "The person will click \"Apply plan\" if they are happy with it."),
    'ask': "[\"Ask before editing\" mode] Every change needs the person's approval.",
    'auto': '',
}


def system_prompt(p):
    pack = store.get_pack(p['packId']) or {}
    sps = {s['id']: s for s in store.list_speakers()}
    lines = [BASE, '', f"# Editing style: {pack.get('name', p['packId'])}", pack.get('description', ''),
             f"Structure: {pack.get('structure', '')}", f"Format: {p['format']['width']}x{p['format']['height']}", '',
             pack.get('rules', ''), '', '# Style render settings', json.dumps(pack.get('style', {}), ensure_ascii=False), '',
             '# People (voices) — id: name, description, preferences']
    default = p.get('defaultSpeaker')
    for sid in p.get('speakers', []):
        s = sps.get(sid)
        if not s: continue
        lines.append(f"- {sid}{' (main person: captions without prefix)' if sid == default else ''}: {s['name']}"
                     f"{' aka ' + ', '.join(s.get('aliases', [])) if s.get('aliases') else ''} — {s.get('description', '')}"
                     f"{' — PREFERENCES: ' + s['preferences'] if s.get('preferences') else ''}"
                     f"{'' if s.get('hasVoice') else ' (no voiceprint)'}")
    return '\n'.join(lines)


def first_turn_context(p):
    parts = []
    if p.get('preferences'):
        parts.append('# Preferences for this project\n' + p['preferences'])
    if p.get('glossary'):
        parts.append('# Glossary (often mistranscribed words → correct spelling)\n' +
                     ', '.join(f'{k} → {v}' for k, v in p['glossary'].items()))
    return parts


def user_turn(p, request, context, mode, first):
    parts = first_turn_context(p) if first else []
    if context:
        c = []
        if context.get('selected'): c.append(f"selected item: {context['selected']}")
        if context.get('time') is not None: c.append(f"playhead: {context['time']}")
        LANGS = {'en': 'English', 'es': 'Spanish', 'de': 'German', 'it': 'Italian', 'pt': 'Portuguese', 'ja': 'Japanese'}
        if context.get('lang') in LANGS: c.append(f"interface language: {LANGS[context['lang']]} — reply in this language")
        if c: parts.append('# Editor context\n' + '; '.join(c))
    if MODE_NOTE.get(mode): parts.append(MODE_NOTE[mode])
    parts.append(('# Request\n' if parts else '') + request)
    return '\n\n'.join(parts)


# ------------------------------------------------------------------ provider choice
def api_credentials():
    if os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('ANTHROPIC_AUTH_TOKEN'): return 'environment variable'
    if os.path.isdir(os.path.expanduser('~/.config/anthropic')) and shutil.which('ant'): return 'ant profile'
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
    """old chat (flat list) -> one conversation."""
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
    if snap is None: raise KeyError('checkpoint not found')
    for k in EDITABLE:
        if k in snap: p[k] = snap[k]
    store.save_project(p)
    return p


def measure(p):
    """a few edit counters, to summarize what an AI request changed (Assistant panel)"""
    ctx = T.Ctx(p)
    tl = p.get('timeline', [])
    fx = [f for it in tl if it.get('type') == 'clip' for f in it.get('fx', [])]
    clips = lambda pred: sum(1 for tr in p.get('tracks', []) if pred(tr) for _ in tr.get('clips', []))
    try: dur = sum(float(it.get('before') or 0) + T.item_duration(ctx, it) for it in tl)
    except Exception: dur = 0.0
    return {
        'plans': sum(1 for it in tl if it.get('type') in ('clip', 'media', 'freeze')),
        'cartons': sum(1 for it in tl if it.get('type') == 'card'),
        'duree': round(dur, 1),
        'soustitres': sum(len(it.get('captions', [])) for it in tl if it.get('type') == 'clip'),
        'effets': sum(1 for f in fx if f.get('kind') not in ('sfx', 'cut', 'keep')),
        'coupes': sum(1 for f in fx if f.get('kind') == 'cut'),
        'sons': sum(1 for f in fx if f.get('kind') == 'sfx') + clips(lambda tr: tr.get('role') == 'sfx'),
        'musique': len(p.get('music') or []) + clips(lambda tr: tr.get('role') == 'music'),
        'incrustations': clips(lambda tr: tr.get('kind') == 'video'),
        'titres': clips(lambda tr: tr.get('kind') == 'text'),
        'audio': clips(lambda tr: tr.get('kind') == 'audio' and not tr.get('role')),
        'looks': sum(1 for it in tl if it.get('look')) + sum(1 for tr in p.get('tracks', []) for c in tr.get('clips', []) if c.get('look')),
    }


def summarize(a, b):
    return [{'k': k, 'a': a.get(k, 0), 'b': v} for k, v in b.items() if v != a.get(k, 0)]


# ------------------------------------------------------------------ one request
class Turn:
    """AI reply in progress: blocks (text, thinking, tools) sent to the editor and saved at the end."""
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
        raise RuntimeError("no AI available: add an API key (ANTHROPIC_API_KEY) or install Claude Code")
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
    m0 = measure(p)

    turn = Turn(job)
    def on_change(proj):
        turn.changes += 1
        job.emit('project', project=proj)
    ctx = T.Ctx(p, on_change=on_change, log=lambda s: job.emit('log', text=s), emit=job.emit)
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
        try: amsg['summary'] = summarize(m0, measure(p))
        except Exception: pass
        if ctx.todos: amsg['todos'] = ctx.todos
        for b in amsg['blocks']:                 # an approval left pending (stopped) = denied
            if b.get('status') in ('pending', 'running'): b['status'] = 'denied' if b.get('status') == 'pending' else 'error'
        c['messages'].append(amsg)
        c['updatedAt'] = time.time()
        store.save_project(p)
        job.emit('project', project=p)
    return {'conversation': conv['id'], 'changes': turn.changes}


def _prepare_sources(job, p):
    todo = [s for s in p['sources'] if s['kind'] in ('video', 'audio') and not store.get_words(p['id'], s['id'])]
    for s in todo:
        job.step(None, f"transcribing {s['name']} before editing…")
        s['status']['transcript'] = 'running'
        n = analyse.transcribe(p, s['id'], job)
        s['status']['transcript'] = 'done'
        store.save_project(p)
        job.emit('project', project=p)
        job.emit('log', text=f"{s['name']}: {n} words transcribed")


def _decide(sess, call_id, decision):
    ev = sess['pending'].get(call_id)
    if not ev: return False
    if decision == 'always': sess['allow_all'] = True
    ev['decision'] = decision
    ev['event'].set()
    return True


def _tool_call(sess, name, args, call_id=None):
    """runs a tool under the mode's rules (plan: read-only; ask: the person's approval)."""
    job, turn = sess['job'], sess['turn']
    call_id = call_id or store.new_id('tc')
    block = {'type': 'tool', 'id': call_id, 'name': name, 'label': T.summary(name, args), 'input': args, 'status': 'running'}
    turn.blocks.append(block)
    job.emit('tool_start', block=block)
    if name in MUTATING:
        if sess['mode'] == 'plan':
            out = "ERROR: plan mode, no changes allowed. Put the plan in your reply."
            block.update(status='denied', result=out)
            job.emit('tool_end', id=call_id, status='denied', result=out)
            return out, True, []
        if not sess['allow_all']:
            ev = {'event': threading.Event(), 'decision': None}
            sess['pending'][call_id] = ev
            block['status'] = 'pending'
            job.emit('approval', id=call_id, block=block)
            while not ev['event'].wait(0.5):
                if job.cancelled: raise T.ToolError('cancelled')
            sess['pending'].pop(call_id, None)
            if ev['decision'] == 'deny':
                out = "The person REJECTED this change. Don't redo it; ask what they prefer or move on."
                block.update(status='denied', result=out)
                job.emit('tool_end', id=call_id, status='denied', result=out)
                return out, True, []
            block['status'] = 'running'
            job.emit('tool_status', id=call_id, status='running')
    out, err, images = T.run(sess['ctx'], name, args)
    if len(out) > 12000:                     # token economy: no giant tool result, the model can narrow its request
        out = out[:12000] + f'\n… (result truncated, {len(out) - 12000} more characters: narrow the request)'
    block.update(status='error' if err else 'done', result=out[:4000] + (f' [{len(images)} image(s)]' if images else ''))
    job.emit('tool_end', id=call_id, status=block['status'], result=block['result'])
    return out, err, images


# ------------------------------------------------------------------ API Anthropic
def _run_api(job, sess, settings, prompt, conv):
    import anthropic
    client = anthropic.Anthropic()
    ctx = sess['ctx']
    model = settings['ai'].get('model') or 'claude-opus-5-5'
    effort = settings['ai'].get('effort') or 'medium'
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
                job.emit('log', text=f'advanced settings rejected ({e.message[:120]}), retrying without them')
                extras = {'thinking': {'type': 'adaptive'}}
                msg = _stream_turn(job, turn, client, model, effort, system, tools, messages, extras)
            messages.append({'role': 'assistant', 'content': [b.model_dump(mode='json', exclude_none=True) for b in msg.content]})
            u = msg.usage
            turn.usage['input'] += (u.input_tokens or 0) + (getattr(u, 'cache_creation_input_tokens', 0) or 0)
            turn.usage['cacheRead'] += getattr(u, 'cache_read_input_tokens', 0) or 0
            turn.usage['output'] += u.output_tokens or 0
            job.emit('usage', usage=turn.usage)
            if msg.stop_reason == 'refusal':
                turn.text("\n\nClaude declined this request."); turn.close_text(); completed = True; return
            uses = [b for b in msg.content if b.type == 'tool_use']
            if msg.stop_reason == 'max_tokens' and uses:
                messages.append({'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': b.id, 'is_error': True,
                                 'content': 'ERROR: response cut off (too long), redo this call in smaller pieces'} for b in uses]})
                continue
            if not uses:
                completed = True; return
            results = []
            for b in uses:
                args = b.input if isinstance(b.input, dict) else None
                if args is None: out, err, images = 'ERROR: unreadable arguments (INVALID_JSON), try again', True, []
                else: out, err, images = _tool_call(sess, b.name, args, b.id)
                content = [{'type': 'text', 'text': out[:60000] or '(empty)'}] + [
                    {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': base64.b64encode(im).decode()}}
                    for im in images]
                results.append({'type': 'tool_result', 'tool_use_id': b.id, 'content': content, 'is_error': err})
            messages.append({'role': 'user', 'content': results})
        turn.text('\n(stopped: too many steps)')
    finally:
        # an interrupted turn (error, stop) is not kept in the history: the API would reject a turn cut off in the middle
        # of tool calls. The AI will get the real state of the edit back with etat_projet.
        if not completed: del messages[n0:]
        store.write_json(hist_path, messages)


def _stream_turn(job, turn, client, model, effort, system, tools, messages, extras):
    kw = dict(model=model, max_tokens=64000, system=system, tools=tools, messages=messages, output_config={'effort': effort}, **extras)
    got_text = False
    with client.beta.messages.stream(**kw) as stream:
        for ev in stream:
            if job.cancelled: raise T.ToolError('cancelled')
            if ev.type == 'content_block_delta':
                d = ev.delta
                if d.type == 'text_delta':
                    got_text = True; turn.text(d.text)
                elif d.type == 'thinking_delta' and getattr(d, 'thinking', ''):
                    turn.thinking(d.thinking)
            elif ev.type == 'content_block_stop' and got_text:
                turn.close_text(); got_text = False
        return stream.get_final_message()


# ------------------------------------------------------------------ Claude Code (subscription)
def _run_cli(job, sess, settings, prompt, conv):
    ctx, turn = sess['ctx'], sess['turn']
    url = f"{BASE_URL}/mcp/{job.id}/{sess['secret']}"
    mcp = json.dumps({'mcpServers': {'cadre': {'type': 'http', 'url': url}}})
    model = settings['ai'].get('cliModel') or 'opus'
    work = f'{CACHE}/claude-cli'
    os.makedirs(work, exist_ok=True)
    effort = settings['ai'].get('effort') or 'medium'
    cmd = [shutil.which('claude') or 'claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model,
           '--effort', effort,
           '--system-prompt', system_prompt(ctx.p), '--mcp-config', mcp, '--strict-mcp-config',
           '--tools', '', '--allowedTools', 'mcp__cadre', '--setting-sources', 'local']
    resumed = bool(conv.get('sessionId'))
    if resumed: cmd += ['--resume', conv['sessionId']]
    else:
        conv['sessionId'] = str(uuid.uuid4())
        cmd += ['--session-id', conv['sessionId']]
    env = dict(os.environ, MCP_TOOL_TIMEOUT='900000')          # an approval may wait for the person
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
            for b in ev.get('message', {}).get('content', []):            # no partial stream: text arrives in one block
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
                raise RuntimeError(f"Claude Code: {ev.get('result') or ev.get('subtype')}")
    code = proc.wait()
    if job.cancelled: raise T.ToolError('cancelled')
    if code != 0 and not final:
        err = (proc.stderr.read() or '')[-400:]
        if resumed and 'session' in err.lower(): conv.pop('sessionId', None)
        raise RuntimeError('Claude Code failed: ' + err)
    store.save_project(ctx.p)


def mcp_handle(job_id, secret, msg):
    """minimal MCP server ("streamable" HTTP, JSON responses): initialize, tools/list, tools/call."""
    sess = SESSIONS.get(job_id)
    if not sess or not secrets.compare_digest(secret, sess['secret']):
        return {'jsonrpc': '2.0', 'id': msg.get('id'), 'error': {'code': -32001, 'message': 'unknown session'}}
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
        return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'unknown method {method}'}}
    return {'jsonrpc': '2.0', 'id': mid, 'result': res}
