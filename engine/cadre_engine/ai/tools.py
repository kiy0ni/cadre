"""Editing tools given to the AI. Each tool reads or changes the context's project (dict); after every change
the project is saved and pushed to the editor, which updates live.

Timeline model (same as the editor, see web/src/types.ts): a sequence of items played one after another.
  clip    {src, in, out, label, jump, speed, captions[], fx[]}   times = seconds in the source
  card    {dur, text, sub, style: title|chapter|narr, bg, color, band}
  freeze  {src, t, dur, target, scale, sfx}
  media   {path, url, dur}
Shot effects (fx), source time: zoom, shake, tint, sfx, text, cut, keep, speed, censor.
Music: project.music = [{name, url, gainDb, db, fromItem, toItem}] (from item A to item B inclusive)."""
import os, re, json, unicodedata
from .. import store, analyse, library
from ..media import probe, file_url


class ToolError(Exception):
    pass


def _fmt(t):
    t = max(0, float(t)); h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f'{h}:{m:02d}:{s:04.1f}' if h else f'{m}:{s:04.1f}'


def _num(v, name):
    try: return float(v)
    except (TypeError, ValueError): raise ToolError(f'"{name}" must be a number (seconds)')


class Ctx:
    """context of an AI session: in-memory project + function called after every change."""
    def __init__(self, project, on_change=None, log=None, emit=None):
        self.p = project
        self.on_change = on_change or (lambda p: None)
        self.log = log or (lambda s: None)
        self.emit = emit or (lambda *a, **k: None)
        self.todos = []
        self._words = {}
        self.pack = store.get_pack(project['packId']) or {}
        self.changes = 0

    def words(self, sid):
        if sid not in self._words: self._words[sid] = store.get_words(self.p['id'], sid)
        return self._words[sid]

    def src(self, sid):
        try: return store.source(self.p, sid)
        except KeyError: raise ToolError(f"unknown source \"{sid}\". Sources: {', '.join(s['id'] for s in self.p['sources'])}")

    def item(self, iid):
        for i, it in enumerate(self.p['timeline']):
            if it['id'] == iid: return i, it
        raise ToolError(f'unknown item "{iid}" (etat_projet gives the ids)')

    def changed(self):
        self.changes += 1
        store.save_project(self.p)
        self.on_change(self.p)

    def style(self):
        st = json.loads(json.dumps(self.pack.get('style') or {}))
        for k, v in (self.p.get('overrides') or {}).items():
            if isinstance(v, dict) and isinstance(st.get(k), dict): st[k].update(v)
            else: st[k] = v
        return st


# ------------------------------------------------------------------ computations shared with the editor
def pieces(clip, words, style):
    """kept pieces of a shot (silence cuts) — same logic as web/src/remotion/resolve.ts."""
    a, b = clip['in'], clip['out']
    jc = style.get('jumpCuts') or {}
    jump = clip.get('jump')
    if jump is None: jump = jc.get('enabled', True)
    ws = [w for w in words if w[1] > a and w[0] < b]
    if not jump or not ws: out = [[a, b]]
    else:
        gap, pre, post = clip.get('gap') or jc.get('gap', 0.25), jc.get('pre', 0.1), jc.get('post', 0.22)
        runs = []
        for w in ws:
            if runs and w[0] - runs[-1][1] <= gap: runs[-1][1] = max(runs[-1][1], w[1])
            else: runs.append([w[0], w[1]])
        out = []
        for s, e in runs:
            s, e = max(a, s - pre), min(b, e + post)
            if out and s <= out[-1][1] + 0.05: out[-1][1] = max(out[-1][1], e)
            else: out.append([s, e])
    for f in clip.get('fx', []):
        if f['kind'] == 'keep':
            out.append([max(a, f['t0']), min(b, f['t1'])])
    out.sort()
    merged = []
    for s, e in out:
        if merged and s <= merged[-1][1] + 0.05: merged[-1][1] = max(merged[-1][1], e)
        else: merged.append([s, e])
    for f in clip.get('fx', []):
        if f['kind'] == 'cut':
            nxt = []
            for s, e in merged:
                if f['t1'] <= s or f['t0'] >= e: nxt.append([s, e]); continue
                if f['t0'] > s: nxt.append([s, f['t0']])
                if f['t1'] < e: nxt.append([f['t1'], e])
            merged = nxt
    return [[s, e] for s, e in merged if e - s >= 0.08]


def speed_parts(clip, pcs, base):
    """pieces split at speed changes -> [(start, end, speed)] (like resolve.ts:withSpeed)"""
    k = base * (clip.get('speed') or 1.0)
    sp = [f for f in clip.get('fx', []) if f['kind'] == 'speed']
    out = []
    for a, b in pcs:
        cuts = sorted({a, b, *[x for f in sp for x in (f['t0'], f['t1']) if a < x < b]})
        for s0, s1 in zip(cuts, cuts[1:]):
            mid = (s0 + s1) / 2
            f = next((f for f in sp if f['t0'] <= mid < f['t1']), None)
            out.append((s0, s1, k * f['rate'] if f else k))
    return out


def item_duration(ctx, it):
    st = ctx.style()
    if it['type'] == 'clip':
        parts = speed_parts(it, pieces(it, ctx.words(it['src']), st), st.get('baseSpeed', 1.0))
        return sum((b - a) / k for a, b, k in parts)
    return float(it.get('dur') or 0)


# ------------------------------------------------------------------ reading
def etat_projet(ctx, args):
    p = ctx.p
    lines = [f"Project \"{p['name']}\" — pack {ctx.pack.get('name', p['packId'])} — {p['format']['width']}x{p['format']['height']} "
             f"— title: {p.get('title') or '(no title yet)'}"]
    lines.append('Sources:')
    for s in p['sources']:
        nw = len(ctx.words(s['id']))
        st = s.get('status', {})
        lines.append(f"- {s['id']} ({s['name']}) {s['kind']} {_fmt(s['duration'])} — transcript: "
                     f"{'yes, %d words' % nw if nw else st.get('transcript', 'no')} — who speaks: {st.get('speakers', 'no')}"
                     f" — voice/background separated: {st.get('stems', 'no')}")
    tl = p['timeline']
    total = 0.0
    lines.append(f'Timeline ({len(tl)} items):')
    for i, it in enumerate(tl):
        d = item_duration(ctx, it); total += d + float(it.get('before') or 0)
        if it['type'] == 'clip':
            fx = {}
            for f in it.get('fx', []): fx[f['kind']] = fx.get(f['kind'], 0) + 1
            fxs = ', '.join(f'{k}×{v}' for k, v in fx.items()) or 'none'
            lines.append(f"{i}. [{it['id']}] SHOT {it['src']} {it['in']:.2f}-{it['out']:.2f} ({_fmt(it['in'])}→{_fmt(it['out'])}, "
                         f"≈{d:.1f} s edited){' “' + it['label'] + '”' if it.get('label') else ''}"
                         f"{' coupes_silences=false' if it.get('jump') is False else ''}{' speed=%g' % it['speed'] if it.get('speed', 1) != 1 else ''}"
                         f" — {len(it.get('captions', []))} captions — effects: {fxs}")
        elif it['type'] == 'card':
            lines.append(f"{i}. [{it['id']}] CARD {it['style']} {it['dur']:g} s \"{it.get('text', '')}\"")
        elif it['type'] == 'freeze':
            lines.append(f"{i}. [{it['id']}] FREEZE FRAME {it['src']} at {it['t']:.2f} {it['dur']:g} s zoom {it.get('scale', 1)}")
        else:
            lines.append(f"{i}. [{it['id']}] MEDIA {os.path.basename(it.get('path', ''))} {d:.1f} s")
    lines.append(f'Estimated edited duration: {_fmt(total)}')
    f = p['format']
    lines.append(f"Format: {f['width']}×{f['height']} at {f['fps']} fps")
    mx = p.get('mix') or {}
    if mx: lines.append('Mix: ' + ', '.join(f'{k}={v}' for k, v in mx.items()))
    if p.get('markers'): lines.append('Markers: ' + ', '.join(f"[{m['id']}] {m['t']:.1f}s {m.get('label', '')}" for m in p['markers']))
    for tr in ctx.p.get('tracks', []):
        lines.append(f"{tr['kind']} track \"{tr['name']}\" [{tr['id']}]: " + (', '.join(
            f"[{c['id']}] {c.get('text') or c.get('name') or os.path.basename(c.get('path') or c.get('url') or '')[:30]} {c['start']:.1f}+{c['dur']:.1f}s" for c in tr['clips']) or 'empty'))
    if p.get('music'):
        ids = [it['id'] for it in tl]
        lines.append('Music:')
        for m in p['music']:
            a = ids.index(m['fromItem']) if m['fromItem'] in ids else '?'
            b = ids.index(m['toItem']) if m['toItem'] in ids else '?'
            lines.append(f"- [{m['id']}] \"{m['name']}\" from item {a} to {b} ({m.get('db', -15)} dB)")
    return '\n'.join(lines)


def lire_transcription(ctx, args):
    s = ctx.src(args['source'])
    a = _num(args.get('debut', 0), 'debut'); b = _num(args.get('fin', a + 300), 'fin')
    if b - a > 1200: b = a + 1200
    ws = ctx.words(s['id'])
    if not ws: return f"source {s['id']} is not transcribed (transcribe tool, or the Transcribe button in the editor)"
    txt = analyse.dump(ws, a, b)
    return f"{s['id']} {_fmt(a)}→{_fmt(b)} (times in seconds in the source; \"name:\" = someone other than {ctx.p.get('defaultSpeaker') or 'the main person'}):\n" + (txt or '(silence)')


def _norm(t):
    t = unicodedata.normalize('NFD', t.lower())
    return re.sub(r'[^a-z0-9 ]', '', ''.join(c for c in t if unicodedata.category(c) != 'Mn'))


def chercher_texte(ctx, args):
    q = _norm(args['texte']).split()
    if not q: raise ToolError('empty text')
    out = []
    for s in ([ctx.src(args['source'])] if args.get('source') else ctx.p['sources']):
        ws = ctx.words(s['id'])
        toks = [_norm(w[2]).strip() for w in ws]
        for i in range(len(toks) - len(q) + 1):
            if all(toks[i + j] == q[j] or (j == len(q) - 1 and toks[i + j].startswith(q[j])) for j in range(len(q))):
                ctxt = ' '.join(w[2].strip() for w in ws[max(0, i - 8):i + len(q) + 8])
                out.append(f"{s['id']} @{ws[i][0]:.2f} ({_fmt(ws[i][0])}): …{ctxt}…")
                if len(out) >= 30: break
    return '\n'.join(out) or 'no match'


def moments_forts(ctx, args):
    s = ctx.src(args['source'])
    ms = analyse.moments(ctx.p, s['id'], top=int(args.get('nombre', 30)))
    return '\n'.join(f"@{m['t']} ({_fmt(m['t'])}) score {m['score']}: {m['extrait']}" for m in ms) or 'nothing found'


def _lib():
    lib = library.ready()
    if lib is None:
        library.warm()
        raise ToolError("sound library not ready yet (or no access to its folder). Carry on without sound effects or music "
                        "and mention it in your reply.")
    return lib


def bibliotheque(ctx, args):
    lib = _lib()
    q = (args.get('recherche') or '').lower()
    n = int(args.get('nombre', 40))
    if args.get('type') == 'musique':
        tracks = library.suggest_music(args.get('ambiance') or '', n=400)
        if q: tracks = [t for t in tracks if q in f"{t['name']} {' '.join(t['moods'])} {' '.join(t['genres'])} {t.get('folder', '')}".lower()]
        return '\n'.join(f"\"{t['name']}\" — {', '.join(t['moods']) or t.get('folder', '')} — energy {t['energy'] or '?'} — "
                         f"{t['bpm'] or '?'} BPM" for t in tracks[:n]) or 'no music (Settings › Libraries)'
    if args.get('type') == 'vfx':
        items = [v for v in lib['vfx'] if not q or q in f"{v['name']} {v['folder']}".lower()]
        return '\n'.join(f"{v['folder']}/{v['name']} ({v['kind']}): {v['path']}" for v in items[:n]) or 'no visuals'
    named = [(k, v) for k, v in lib['sfx'].items() if not v.get('file')]
    files = [(k, v) for k, v in lib['sfx'].items() if v.get('file')]
    if q:
        named = [(k, v) for k, v in named if q in f"{k} {v['help']}".lower()]
        files = [(k, v) for k, v in files if q in f"{v['label']} {v['help']}".lower()]
    out = [f"{k}: {v['help']} ({len(v['variants'])} variants)" for k, v in named]
    out += [f"{k}: {v['label']} — {v['help']}" for k, v in files[:max(0, n - len(out))]]
    more = len(files) - max(0, n - len(named))
    if more > 0: out.append(f"… and {more} more sounds (narrow down with \"recherche\")")
    return '\n'.join(out) or 'no sounds (Settings › Libraries)'


def regarder(ctx, args):
    """frame of a source at a given time (the AI really sees the video)"""
    from .. import previews
    s = ctx.src(args['source'])
    if s['kind'] == 'audio': raise ToolError('audio source: nothing to look at')
    path = s['path']
    if s.get('proxy'):
        from ..media import path_of
        path = path_of(s['proxy']) or path
    t = _num(args.get('temps', 0), 'temps')
    jpg = previews.thumb(path, t, 512)          # 512 px is enough to judge framing, and costs far fewer tokens
    if not jpg: raise ToolError('could not extract the frame')
    return {'text': f"{s['id']} at {_fmt(t)} ({s['width']}x{s['height']})", 'images': [open(jpg, 'rb').read()]}


def regarder_montage(ctx, args):
    """what the edited video shows at a given time: the shot's frame + what is laid on top of it"""
    t_out = _num(args['temps'], 'temps')
    acc = 0.0
    st = ctx.style()
    for it in ctx.p['timeline']:
        acc += float(it.get('before') or 0)          # empty gap before the item
        if acc > t_out: return {'text': f'at {_fmt(t_out)}: empty gap (black) before item [{it["id"]}]', 'images': []}
        d = item_duration(ctx, it)
        if acc + d > t_out:
            local = t_out - acc
            if it['type'] == 'clip':
                rem = local
                for a, b, k in speed_parts(it, pieces(it, ctx.words(it['src']), st), st.get('baseSpeed', 1.0)):
                    if rem <= (b - a) / k:
                        src_t = a + rem * k; break
                    rem -= (b - a) / k
                else:
                    src_t = it['out']
                caps = [c['text'] for c in it.get('captions', []) if c['t0'] <= src_t <= c['t1'] + 0.3]
                fx = [f"{f['kind']}" + (f" ×{f.get('scale')}" if f['kind'] == 'zoom' else '') for f in it.get('fx', [])
                      if f.get('t0', f.get('t', 0)) <= src_t <= f.get('t1', f.get('t', 0) + 0.5)]
                r = regarder(ctx, {'source': it['src'], 'temps': src_t})
                r['text'] = (f"at {_fmt(t_out)} of the edited video: shot [{it['id']}] ({it['src']} at {_fmt(src_t)})"
                             f" — caption: {caps[0] if caps else 'none'} — effects: {', '.join(fx) or 'none'}")
                return r
            return f"at {_fmt(t_out)}: {it['type']} [{it['id']}] \"{it.get('text', '')}\""
        acc += d
    raise ToolError(f'the edited video is {_fmt(acc)} long')


STYLE_KEYS = {
    'police': ('captions', 'font'), 'taille_sous_titres': ('captions', 'size'), 'couleur_sous_titres': ('captions', 'color'),
    'contour': ('captions', 'outline'), 'fond_sous_titres': ('captions', 'box'), 'majuscules': ('captions', 'uppercase'),
    'mot_a_mot': ('captions', 'mode'), 'marge_bas': ('captions', 'bottom'), 'silence_max': ('jumpCuts', 'gap'),
    'couper_silences': ('jumpCuts', 'enabled'), 'vitesse_base': ('baseSpeed', None), 'musique_db': ('music', 'db'),
    'baisse_musique_db': ('music', 'duckDb'), 'bruitages_db': ('sfxDb', None), 'censure': ('censor', 'captions'),
    'zoom_visage': ('zoom', 'face'), 'zoom_centre': ('zoom', 'center'), 'visage': ('face', None),
}


def regler_style(ctx, args):
    """render settings specific to this project (on top of the style)"""
    ov = ctx.p.setdefault('overrides', {})
    done = []
    for k, v in (args.get('reglages') or {}).items():
        if k not in STYLE_KEYS: raise ToolError(f"unknown setting \"{k}\" ({', '.join(STYLE_KEYS)})")
        a, b = STYLE_KEYS[k]
        if k == 'mot_a_mot': v = 'words' if v else 'groups'
        if k == 'censure': ov.setdefault('censor', {}).update({'captions': bool(v), 'audio': bool(v)}); done.append(k); continue
        if b: ov.setdefault(a, {})[b] = v
        else: ov[a] = v
        done.append(k)
    ctx.changed()
    return f"set: {', '.join(done)}"


def lire_element(ctx, args):
    i, it = ctx.item(args['element'])
    return json.dumps(it, ensure_ascii=False)


# ------------------------------------------------------------------ writing
def _insert(ctx, item, args):
    tl = ctx.p['timeline']
    if args.get('apres'):
        i, _ = ctx.item(args['apres']); tl.insert(i + 1, item)
    elif args.get('avant'):
        i, _ = ctx.item(args['avant']); tl.insert(i, item)
    elif args.get('position') is not None and str(args['position']).lstrip('-').isdigit():
        tl.insert(max(0, min(len(tl), int(args['position']))), item)
    else:
        tl.append(item)
    return tl.index(item)


def ajouter_plan(ctx, args):
    s = ctx.src(args['source'])
    a, b = _num(args['debut'], 'debut'), _num(args['fin'], 'fin')
    a, b = max(0.0, a), min(float(s['duration']), b)
    if b - a < 0.2: raise ToolError(f'shot too short or outside the source (duration {s["duration"]:.1f} s)')
    clip = {'id': store.new_id('i'), 'type': 'clip', 'src': s['id'], 'in': round(a, 3), 'out': round(b, 3),
            'label': args.get('titre_chapitre') or '', 'jump': args.get('coupes_silences'), 'speed': 1.0,
            'captions': [], 'fx': []}
    if args.get('sous_titres', 'auto') != 'aucun' and ctx.words(s['id']):
        clip['captions'] = analyse.make_captions(ctx.words(s['id']), a, b, ctx.style(), ctx.p.get('glossary'), ctx.p.get('defaultSpeaker'))
    idx = _insert(ctx, clip, args)
    ctx.changed()
    # token economy: only the captions that contain words Whisper was unsure about are sent back for review
    words = ctx.words(s['id'])
    doubt = [c for c in clip['captions'] if any(len(w) > 3 and w[3] is not None and w[3] < 0.55 and w[0] < c['t1'] and w[1] > c['t0'] for w in words
                                                if a <= w[0] <= b)]
    caps = ' / '.join(f"[{c['id']}] {c['t0']:.1f} {(c['speaker'] + ': ') if c['speaker'] else ''}{c['text']}" for c in doubt[:20])
    return (f"shot [{clip['id']}] added at position {idx} (≈{item_duration(ctx, clip):.1f} s edited). {len(clip['captions'])} auto captions"
            + (f"; to check (uncertain words): {caps}" if caps else '; no uncertain words'))


CARD_STYLES = {'titre': 'title', 'chapitre': 'chapter', 'texte': 'narr'}


def _color(v, name):
    v = str(v or '').strip()
    if v and not re.fullmatch(r'#[0-9a-fA-F]{6}', v): raise ToolError(f'{name}: expected a #rrggbb color')
    return v


def ajouter_carton(ctx, args):
    style = CARD_STYLES.get(args.get('style', 'title'), args.get('style'))
    if style not in ('title', 'chapter', 'narr'): raise ToolError('style: title, chapter or narr')
    card = {'id': store.new_id('i'), 'type': 'card', 'dur': round(_num(args.get('duree', 1.8 if style == 'chapter' else 1.4), 'duree'), 2),
            'text': args.get('texte', ''), 'sub': args.get('sous_texte', ''), 'style': style}
    for key, arg in (('bg', 'fond'), ('color', 'couleur')):
        if args.get(arg): card[key] = _color(args[arg], arg)
    if style == 'title' and 'bandeau' in args: card['band'] = _color(args['bandeau'], 'bandeau')
    idx = _insert(ctx, card, args)
    ctx.changed()
    return f"card [{card['id']}] ({style}) at position {idx}"


def ajouter_arret_image(ctx, args):
    s = ctx.src(args['source'])
    t = _num(args['temps'], 'temps')
    fr = {'id': store.new_id('i'), 'type': 'freeze', 'src': s['id'], 't': round(t, 3), 'dur': round(_num(args.get('duree', 1.3), 'duree'), 2),
          'target': _target(args.get('cible', 'visage')), 'scale': float(args.get('echelle', 2.2)),
          'sfx': args.get('son') or None}
    idx = _insert(ctx, fr, args)
    ctx.changed()
    return f"freeze frame [{fr['id']}] at position {idx}"


def ajouter_media(ctx, args):
    path = args['chemin']
    src = next((x for x in ctx.p['sources'] if x['id'] == path), None)
    if src: path = src['path']
    if path in ('outro', 'OUTRO'):
        path = ctx.pack.get('outro') or ''
        if not path: raise ToolError("this style has no outro (Styles › General)")
    if not os.path.exists(path): raise ToolError(f'file not found: {path}')
    info = probe(path)
    dur = float(args.get('duree') or (info['duration'] if info['kind'] != 'image' else 3.0))
    it = {'id': store.new_id('i'), 'type': 'media', 'path': path, 'url': file_url(path), 'kind': info['kind'],
          'dur': round(dur, 3), 'chroma': bool(args.get('fond_vert', False))}
    idx = _insert(ctx, it, args)
    ctx.changed()
    return f"media [{it['id']}] ({os.path.basename(path)}, {dur:.1f} s) at position {idx}"


def _target(v):
    if isinstance(v, (list, tuple)) and len(v) == 2: return [float(v[0]), float(v[1])]
    v = str(v or 'visage').lower()
    return 'center' if v.startswith('cent') else 'face' if v.startswith(('vis', 'face', 'ava')) else v


FX_KINDS = {'zoom': 'zoom', 'secousse': 'shake', 'teinte': 'tint', 'son': 'sfx', 'texte': 'text', 'coupe': 'cut',
            'garder': 'keep', 'vitesse': 'speed', 'censure': 'censor'}
TINTS = {'nb': 'bw', 'noir et blanc': 'bw', 'bw': 'bw', 'flash': 'flash'}
TEXTS = {'gros': 'big', 'big': 'big', 'note': 'note'}


def _fx(ctx, clip, e):
    kind = FX_KINDS.get(e.get('type'))
    if not kind: raise ToolError(f"unknown effect type \"{e.get('type')}\" ({', '.join(FX_KINDS)})")
    f = {'id': store.new_id('f'), 'kind': kind}
    if kind in ('sfx', 'text'):
        f['t'] = round(_num(e.get('temps', e.get('debut')), 'temps'), 3)
    else:
        f['t0'] = round(_num(e.get('debut'), 'debut'), 3); f['t1'] = round(_num(e.get('fin'), 'fin'), 3)
        if f['t1'] <= f['t0']: raise ToolError('fin <= debut')
    t = f.get('t', f.get('t0'))
    if not (clip['in'] - 0.5 <= t <= clip['out'] + 0.5):
        raise ToolError(f"effect at {t:.2f} is outside shot [{clip['id']}] ({clip['in']:.2f}-{clip['out']:.2f}): times are source times")
    if kind == 'zoom':
        f['target'] = _target(e.get('cible', 'visage'))
        st = ctx.style().get('zoom', {})
        f['scale'] = float(e.get('echelle') or (st.get('face', 2.0) if f['target'] == 'face' else st.get('center', 1.3)))
    elif kind == 'shake': f['amp'] = float(e.get('force', 14))
    elif kind == 'tint': f['mode'] = TINTS.get(str(e.get('mode', 'nb')).lower(), 'bw')
    elif kind == 'sfx':
        name = e.get('nom')
        if name not in _lib()['sfx']: raise ToolError(f"unknown sound \"{name}\" (bibliotheque tool)")
        f['name'] = name; f['db'] = float(e.get('volume_db', 0))
    elif kind == 'text':
        f['text'] = e.get('texte', ''); f['dur'] = float(e.get('duree', 1.4)); f['style'] = TEXTS.get(e.get('style', 'gros'), 'big')
    elif kind == 'speed': f['rate'] = float(e.get('facteur', 1.5))
    return f


def ajouter_effets(ctx, args):
    i, clip = ctx.item(args['element'])
    if clip['type'] != 'clip': raise ToolError('effects go on a shot')
    added, errors = [], []
    for e in args.get('effets', []):
        try:
            f = _fx(ctx, clip, e); clip['fx'].append(f); added.append(f"{f['id']}:{f['kind']}")
        except ToolError as err:
            errors.append(str(err))
    clip['fx'].sort(key=lambda f: f.get('t', f.get('t0', 0)))
    if added: ctx.changed()
    return f"{len(added)} effect(s) added on [{clip['id']}]: {', '.join(added)}" + (f"\nERRORS: {' | '.join(errors)}" if errors else '')


def supprimer_effets(ctx, args):
    i, clip = ctx.item(args['element'])
    ids, kinds = set(args.get('ids') or []), {FX_KINDS.get(k, k) for k in (args.get('types') or [])}
    before = len(clip.get('fx', []))
    clip['fx'] = [f for f in clip.get('fx', []) if f['id'] not in ids and f['kind'] not in kinds]
    ctx.changed()
    return f'{before - len(clip["fx"])} effect(s) removed'


STYLES = {'normal': 'normal', 'hype': 'hype', 'cri': 'shout', 'shout': 'shout'}


def _speaker_id(ctx, name):
    if not name: return None
    low = str(name).lower()
    for sp in store.list_speakers():
        if low in (sp['id'].lower(), sp['name'].lower(), *[a.lower() for a in sp.get('aliases', [])]):
            return None if sp['id'] == ctx.p.get('defaultSpeaker') else sp['id']
    raise ToolError(f"unknown person \"{name}\" (see the list of people in your instructions)")


def ecrire_sous_titres(ctx, args):
    i, clip = ctx.item(args['element'])
    if clip['type'] != 'clip': raise ToolError('captions go on a shot')
    caps = []
    for c in args.get('sous_titres', []):
        t0 = _num(c['debut'], 'debut'); t1 = _num(c.get('fin', t0 + 1.2), 'fin')
        text = c['texte'].strip()
        style = STYLES.get(c.get('style', 'normal'), 'normal')
        if text.startswith('!'): text, style = text[1:].strip(), 'hype'
        if any(ch.isalpha() for ch in text) and text == text.upper() and len(text) > 2 and style == 'normal': style = 'shout'
        caps.append({'id': store.new_id('c'), 't0': round(t0, 3), 't1': round(max(t1, t0 + 0.2), 3), 'text': text,
                     'speaker': _speaker_id(ctx, c.get('personne')), 'style': style})
    if args.get('remplacer', True): clip['captions'] = caps
    else: clip['captions'] = sorted(clip.get('captions', []) + caps, key=lambda c: c['t0'])
    ctx.changed()
    return f"{len(caps)} caption(s) written on [{clip['id']}]"


def modifier_sous_titres(ctx, args):
    i, clip = ctx.item(args['element'])
    byid = {c['id']: c for c in clip.get('captions', [])}
    n = 0
    for m in args.get('modifications', []):
        c = byid.get(m.get('id'))
        if not c: continue
        if m.get('supprimer'):
            clip['captions'].remove(c); n += 1; continue
        if 'texte' in m: c['text'] = m['texte']
        if 'personne' in m: c['speaker'] = _speaker_id(ctx, m['personne'])
        if 'style' in m: c['style'] = STYLES.get(m['style'], 'normal')
        if 'debut' in m: c['t0'] = _num(m['debut'], 'debut')
        if 'fin' in m: c['t1'] = _num(m['fin'], 'fin')
        n += 1
    clip['captions'].sort(key=lambda c: c['t0'])
    ctx.changed()
    return f'{n} caption(s) changed'


def generer_sous_titres(ctx, args):
    i, clip = ctx.item(args['element'])
    clip['captions'] = analyse.make_captions(ctx.words(clip['src']), clip['in'], clip['out'], ctx.style(), ctx.p.get('glossary'),
                                             ctx.p.get('defaultSpeaker'))
    ctx.changed()
    return ' / '.join(f"[{c['id']}] {c['t0']:.1f} {(c['speaker'] + ': ') if c['speaker'] else ''}{c['text']}" for c in clip['captions'])


def modifier_element(ctx, args):
    i, it = ctx.item(args['element'])
    ch = args.get('champs') or {}
    m = {'debut': 'in', 'fin': 'out', 'titre_chapitre': 'label', 'coupes_silences': 'jump', 'vitesse': 'speed', 'texte': 'text',
         'sous_texte': 'sub', 'duree': 'dur', 'style': 'style', 'volume_db': 'volumeDb', 'echelle': 'scale', 'temps': 't', 'son': 'sfx',
         'cadrage_horizontal': 'cropX', 'silence_max': 'gap', 'fondu_entree': 'fadeIn', 'fondu_sortie': 'fadeOut', 'sons_auto': 'autoSfx',
         'espace_avant': 'before', 'raison': 'note'}
    for k, v in ch.items():
        key = m.get(k, k)
        if key == 'sons' and it['type'] == 'card':
            lib = _lib()
            out = []
            for so in v or []:
                nm = so.get('nom') or so.get('name')
                if nm not in lib['sfx']: raise ToolError(f"unknown sound \"{nm}\" (bibliotheque tool, type=sfx)")
                out.append({'id': store.new_id('s'), 'name': nm, 'at': float(so.get('decalage', 0)), 'db': float(so.get('db', 0))})
            it['sounds'] = out
            continue
        if key == 'autoSfx': it['autoSfx'] = bool(v); continue
        if k == 'image' and it['type'] == 'card': it['image'] = _image_url(ctx, v); continue
        if key == 'cible': it['target'] = _target(v); continue
        if key in ('in', 'out', 'speed', 'dur', 't', 'scale', 'volumeDb', 'cropX', 'gap', 'fadeIn', 'fadeOut', 'before'): v = _num(v, k)
        if key == 'before': v = max(0.0, v)
        if key == 'cropX': v = max(0.0, min(1.0, v))
        it[key] = v
    if it['type'] == 'clip':
        s = ctx.src(it['src'])
        it['in'] = max(0.0, it['in']); it['out'] = min(float(s['duration']), it['out'])
        if it['out'] - it['in'] < 0.2: raise ToolError('shot too short')
        if args.get('regenerer_sous_titres') or 'debut' in ch or 'fin' in ch:
            if args.get('regenerer_sous_titres', True):
                it['captions'] = analyse.make_captions(ctx.words(it['src']), it['in'], it['out'], ctx.style(), ctx.p.get('glossary'),
                                                       ctx.p.get('defaultSpeaker'))
    ctx.changed()
    return f"[{it['id']}] changed"


def _image_url(ctx, v):
    """card image (logo…): '' = none; a project image source (id or name), a library visual (name) or a file path"""
    v = str(v or '').strip()
    if not v: return None
    for s in ctx.p['sources']:
        if s['kind'] == 'image' and v in (s['id'], s['name']): return s['url']
    for x in _lib().get('vfx', []):
        if v in (x['name'], x['path']): return x['url']
    path = os.path.expanduser(v)
    if os.path.exists(path): return file_url(path)
    raise ToolError(f'unknown image "{v}": give an image source of the project, a library visual or a file path')


def ordre_piste(ctx, args):
    """stacking order of free tracks: a track higher in the list is drawn above the ones below it (like V2 over V1)"""
    tracks = ctx.p.setdefault('tracks', [])
    tr = next((t for t in tracks if args['piste'] in (t['id'], t['name'])), None)
    if not tr or tr.get('role'): raise ToolError('unknown track (etat_projet lists them), or a Voice / Music / SFX row')
    peers = [k for k, t in enumerate(tracks) if (t['kind'] == 'audio') == (tr['kind'] == 'audio') and not t.get('role')]
    i = tracks.index(tr); pos = peers.index(i)
    to = {'monter': pos - 1, 'descendre': pos + 1, 'tout_en_haut': 0, 'tout_en_bas': len(peers) - 1}.get(args.get('position'))
    if to is None: raise ToolError('position: monter, descendre, tout_en_haut or tout_en_bas')
    to = max(0, min(len(peers) - 1, to))
    tracks.pop(i); tracks.insert(peers[to], tr)
    ctx.changed()
    return 'order (top → bottom): ' + ', '.join(t['name'] for t in tracks if (t['kind'] == 'audio') == (tr['kind'] == 'audio') and not t.get('role'))


def supprimer_element(ctx, args):
    ids = set(args.get('elements') or [])
    before = len(ctx.p['timeline'])
    ctx.p['timeline'] = [it for it in ctx.p['timeline'] if it['id'] not in ids]
    left = {it['id'] for it in ctx.p['timeline']}
    ctx.p['music'] = [m for m in ctx.p.get('music', []) if m['fromItem'] in left and m['toItem'] in left]
    ctx.changed()
    return f'{before - len(ctx.p["timeline"])} item(s) removed'


def deplacer_element(ctx, args):
    i, it = ctx.item(args['element'])
    tl = ctx.p['timeline']; tl.pop(i)
    _insert(ctx, it, args)
    ctx.changed()
    return f"[{it['id']}] moved to position {tl.index(it)}"


def vider_timeline(ctx, args):
    ctx.p['timeline'] = []; ctx.p['music'] = []
    ctx.changed()
    return 'timeline cleared'


def _role_track(ctx, role):
    tracks = ctx.p.setdefault('tracks', [])
    for tr in tracks:
        if tr.get('role') == role: return tr
    tr = {'id': store.new_id('t'), 'kind': 'audio', 'role': role, 'name': {'music': 'Music', 'sfx': 'Sound effects', 'voice': 'Voice'}[role], 'clips': []}
    tracks.append(tr)
    return tr


def musique(ctx, args):
    """background music = audio clip on the A2 Music lane (can be moved / trimmed in the timeline)"""
    if args.get('action') == 'supprimer':
        mid = args.get('id')
        ctx.p['music'] = [m for m in ctx.p.get('music', []) if m['id'] != mid]
        for tr in ctx.p.get('tracks', []): tr['clips'] = [c for c in tr['clips'] if c['id'] != mid]
        ctx.changed(); return 'music removed'
    _lib()
    t = library.music_by_name(args.get('nom', ''))
    if not t: raise ToolError(f"unknown music \"{args.get('nom')}\" (bibliotheque tool, type=musique)")
    ctx.item(args['de_element']); _, last = ctx.item(args['a_element'])
    start = item_start(ctx, args['de_element'])
    end = item_start(ctx, args['a_element']) + item_duration(ctx, last)
    if end - start < 0.5: raise ToolError('span too short (de_element must come before a_element)')
    db = float(args.get('volume_db', ctx.style().get('music', {}).get('db', -15)))
    clip = {'id': store.new_id('o'), 'type': 'audio', 'name': t['name'], 'path': t.get('path'), 'url': t['url'], 'start': round(start, 3),
            'dur': round(end - start, 3), 'in': float(args.get('debut_morceau', 0)), 'volumeDb': round(t['gainDb'] + db, 2), 'duck': True,
            'loop': True, 'fadeIn': 0.4, 'fadeOut': 0.8}
    _role_track(ctx, 'music')['clips'].append(clip)
    ctx.changed()
    return f"music [{clip['id']}] \"{t['name']}\" from {_fmt(start)} to {_fmt(end)} (Music lane)"


def definir_titre(ctx, args):
    ctx.p['title'] = args['titre'].strip()
    ctx.changed()
    return 'title saved'


def item_start(ctx, iid):
    t = 0.0
    for it in ctx.p['timeline']:
        t += float(it.get('before') or 0)
        if it['id'] == iid: return t
        t += item_duration(ctx, it)
    raise ToolError(f'unknown item "{iid}"')


def _track(ctx, kind, name):
    tracks = ctx.p.setdefault('tracks', [])
    for tr in tracks:
        if tr['kind'] == kind and not tr.get('locked'): return tr
    tr = {'id': store.new_id('t'), 'kind': kind, 'name': name, 'clips': []}
    if kind == 'audio': tracks.append(tr)
    else: tracks.insert(0, tr)
    return tr


TEXT_PRESETS = {
    'titre': {'font': 'Montserrat', 'size': 150, 'weight': 900, 'color': '#FFFFFF', 'stroke': 10, 'strokeColor': '#000000', 'bg': None,
              'x': 0.5, 'y': 0.42, 'align': 'center', 'anim': 'pop', 'uppercase': True, 'shadow': True},
    'sous-titre': {'font': 'Montserrat', 'size': 70, 'weight': 800, 'color': '#FFFFFF', 'stroke': 6, 'strokeColor': '#000000', 'bg': None,
                   'x': 0.5, 'y': 0.82, 'align': 'center', 'anim': 'pop'},
    'encadre': {'font': 'Montserrat', 'size': 64, 'weight': 800, 'color': '#FFFFFF', 'stroke': 0, 'strokeColor': '#000000', 'bg': '#E8232A',
                'x': 0.5, 'y': 0.15, 'align': 'center', 'anim': 'slide'},
    'bandeau': {'font': 'Montserrat', 'size': 48, 'weight': 700, 'color': '#FFFFFF', 'stroke': 0, 'strokeColor': '#000000', 'bg': 'rgba(0,0,0,0.65)',
                'x': 0.22, 'y': 0.85, 'align': 'left', 'anim': 'slide'},
    'note': {'font': 'Montserrat', 'size': 56, 'weight': 800, 'color': '#FFFFFF', 'stroke': 5, 'strokeColor': '#000000', 'bg': None,
             'x': 0.5, 'y': 0.12, 'align': 'center', 'anim': 'fade'},
}


def ajouter_texte(ctx, args):
    style = dict(TEXT_PRESETS.get(args.get('style', 'titre'), TEXT_PRESETS['titre']))
    for k_in, k in (('x', 'x'), ('y', 'y'), ('taille', 'size'), ('couleur', 'color'), ('animation', 'anim')):
        if args.get(k_in) is not None: style[k] = args[k_in]
    start = item_start(ctx, args['element']) + float(args.get('decalage', 0)) if args.get('element') else float(args.get('debut_sortie', 0))
    clip = {'id': store.new_id('o'), 'type': 'text', 'start': round(start, 3), 'dur': float(args.get('duree', 2.5)), 'text': args['texte'], 'style': style}
    _track(ctx, 'text', 'Texts')['clips'].append(clip)
    ctx.changed()
    return f"text [{clip['id']}] at {start:.1f} s (edited-video time)"


def ajouter_incrustation(ctx, args):
    path = args['chemin']
    if not os.path.exists(path): raise ToolError(f'file not found: {path} (bibliotheque tool, type=vfx)')
    info = probe(path)
    start = item_start(ctx, args['element']) + float(args.get('decalage', 0)) if args.get('element') else float(args.get('debut_sortie', 0))
    dur = float(args.get('duree') or (info['duration'] if info['kind'] == 'video' else 2.0))
    look = {'scale': float(args.get('echelle', 1)), 'x': float(args.get('x', 0)), 'y': float(args.get('y', 0))}
    if args.get('fond_vert'): look['chroma'] = '#00ff00'
    clip = {'id': store.new_id('o'), 'type': 'video', 'kind': 'image' if info['kind'] == 'image' else 'video', 'path': path,
            'url': file_url(path), 'in': 0, 'start': round(start, 3), 'dur': round(dur, 3), 'look': look,
            'volumeDb': float(args.get('volume_db', 0)), 'fadeIn': 0.1, 'fadeOut': 0.15}
    _track(ctx, 'video', 'Overlays')['clips'].append(clip)
    ctx.changed()
    return f"overlay [{clip['id']}] {os.path.basename(path)} at {start:.1f} s for {dur:.1f} s"


def etalonnage(ctx, args):
    ids = args.get('elements') or [it['id'] for it in ctx.p['timeline'] if it['type'] != 'card']
    n = 0
    for iid in ids:
        i, it = ctx.item(iid)
        if it['type'] == 'card': continue
        look = it.setdefault('look', {})
        col = {} if args.get('remplacer', True) else dict(look.get('color') or {})
        if args.get('preset'): col['preset'] = args['preset']
        for k in ('exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows', 'vignette'):
            if args.get(k) is not None: col[k] = float(args[k])
        look['color'] = col
        n += 1
    ctx.changed()
    return f'color grade applied to {n} item(s)'


def transition(ctx, args):
    i, it = ctx.item(args['element'])
    kind = args.get('type', 'fade')
    if kind == 'aucune': it['transition'] = None
    else:
        if kind not in ('fade', 'flash', 'zoom', 'whip', 'glitch', 'blur'): raise ToolError('type: fade, flash, zoom, whip, glitch, blur or aucune')
        it['transition'] = {'kind': kind, 'dur': float(args.get('duree', 0.35))}
    ctx.changed()
    return f"transition \"{kind}\" at the start of [{it['id']}]"


def regler_image(ctx, args):
    i, it = ctx.item(args['element'])
    look = it.setdefault('look', {})
    for k_in, k in (('x', 'x'), ('y', 'y'), ('echelle', 'scale'), ('rotation', 'rotation'), ('opacite', 'opacity'), ('fusion', 'blend')):
        if args.get(k_in) is not None: look[k] = args[k_in]
    if args.get('miroir') is not None: look['flipH'] = bool(args['miroir'])
    ctx.changed()
    return f"transform of [{it['id']}] set"


def noter_preference(ctx, args):
    txt = args['texte'].strip()
    portee = args.get('portee', 'projet')
    if portee == 'pack':
        pk = store.get_pack(ctx.p['packId'])
        rules = pk.get('rules', '')
        if '## Learned feedback' not in rules and '## Retours appris' not in rules:     # older packs use the French heading
            pk['rules'] = rules + '\n\n## Learned feedback'
        pk['rules'] += f'\n- {txt}'
        store.save_pack(pk); ctx.pack = pk
        return f"rule added to pack \"{pk['name']}\""
    if portee == 'personne':
        sid = _speaker_id(ctx, args.get('personne')) or ctx.p.get('defaultSpeaker')
        sp = store.get_speaker(sid)
        if not sp: raise ToolError('unknown person')
        sp['preferences'] = (sp.get('preferences', '') + '\n- ' + txt).strip()
        store.save_speaker(sp)
        return f"preference added for {sp['name']}"
    ctx.p['preferences'] = (ctx.p.get('preferences', '') + '\n- ' + txt).strip()
    ctx.changed()
    return 'preference added to the project'


# ------------------------------------------------------------------ registry
S = lambda props, req=(): {'type': 'object', 'properties': props, 'required': list(req)}
NUM = {'type': 'number'}
STR = {'type': 'string'}
POS = {'apres': {'type': 'string', 'description': "apres (after): id of the item to insert after"},
       'avant': {'type': 'string', 'description': "avant (before): id of the item to insert before"},
       'position': {'type': 'integer', 'description': 'index (0 = start). Without apres/avant/position: at the end'}}


# ------------------------------------------------------------------ free tracks, mix, format, markers, export
def _clip(ctx, cid):
    for tr in ctx.p.get('tracks', []):
        for c in tr['clips']:
            if c['id'] == cid: return tr, c
    raise ToolError(f'unknown track clip "{cid}" (etat_projet lists the tracks and their clips)')


def etapes(ctx, args):
    """task list visible to the person (like an agent ticking off its plan as it goes)"""
    items = []
    for x in args.get('etapes') or []:
        t = str(x.get('texte') or '').strip()[:120]
        if not t: continue
        e = x.get('etat') if x.get('etat') in ('a_faire', 'en_cours', 'fait') else 'a_faire'
        items.append({'text': t, 'status': {'a_faire': 'todo', 'en_cours': 'doing', 'fait': 'done'}[e]})
    if not items: raise ToolError('give at least one step {texte, etat}')
    ctx.todos = items
    ctx.emit('todos', items=items)
    done = sum(1 for i in items if i['status'] == 'done')
    cur = next((i['text'] for i in items if i['status'] == 'doing'), None)
    return f"{done}/{len(items)} steps done" + (f"; in progress: {cur}" if cur else '')


def delier_audio(ctx, args):
    """sound of a V1 shot (or of a video overlay) as separate audio clips that move on their own (J/L-cut); or the reverse"""
    rid = args.get('element') or args.get('clip')
    if not rid: raise ToolError('give element (V1 shot) or clip (video overlay)')
    tracks = ctx.p.setdefault('tracks', [])
    linked = [c for tr in tracks for c in tr['clips'] if c.get('link') == rid]
    if args.get('action') == 'rattacher':
        for tr in tracks: tr['clips'] = [c for c in tr['clips'] if c.get('link') != rid]
        it = next((x for x in ctx.p['timeline'] if x['id'] == rid), None)
        if it: it.pop('audioOff', None)
        for tr in tracks:
            for c in tr['clips']:
                if c['id'] == rid and c['type'] == 'video': c['muted'] = False
        ctx.changed(); return f'sound relinked ({len(linked)} audio clip(s) removed)'
    if linked: raise ToolError('sound already unlinked (action=rattacher to undo)')
    made = []
    if args.get('element'):
        _, it = ctx.item(rid)
        t = item_start(ctx, rid)
        if it['type'] == 'clip':
            st = ctx.style()
            parts = speed_parts(it, pieces(it, ctx.words(it['src']), st), st.get('baseSpeed', 1.0))
            for a, b, k in parts:
                d = (b - a) / k
                made.append({'id': store.new_id('o'), 'type': 'audio', 'name': it.get('label') or '', 'src': it['src'], 'in': round(a, 3),
                             'start': round(t, 3), 'dur': round(d, 3), 'speed': k, 'volumeDb': it.get('volumeDb') or 0, 'link': rid})
                t += d
        elif it['type'] == 'media' and it.get('kind') == 'video':
            made.append({'id': store.new_id('o'), 'type': 'audio', 'path': it.get('path'), 'url': it.get('url'), 'in': 0, 'start': round(t, 3),
                         'dur': float(it['dur']), 'volumeDb': it.get('volumeDb') or 0, 'link': rid})
        else: raise ToolError('only shots and video media have sound to unlink')
        _role_track(ctx, 'voice')['clips'].extend(made)
        it['audioOff'] = True
    else:
        tr0, c = _clip(ctx, rid)
        if c['type'] != 'video' or c.get('kind') != 'video': raise ToolError('only a video clip has sound to unlink')
        made.append({'id': store.new_id('o'), 'type': 'audio', 'name': c.get('name') or '', 'src': c.get('src'), 'path': c.get('path'), 'url': c.get('url'),
                     'in': c['in'], 'start': c['start'], 'dur': c['dur'], 'speed': c.get('speed') or 1, 'volumeDb': c.get('volumeDb') or 0, 'link': rid})
        tr = next((t for t in ctx.p['tracks'] if t['kind'] == 'audio' and not t.get('role') and not t.get('locked')), None)
        if not tr:
            tr = {'id': store.new_id('t'), 'kind': 'audio', 'name': 'Audio', 'clips': []}
            ctx.p['tracks'].append(tr)
        tr['clips'].extend(made)
        c['muted'] = True
    ctx.changed()
    return f"sound unlinked: {len(made)} audio clip(s) [{', '.join(m['id'] for m in made)}] (move them with modifier_clip_piste)"


def modifier_clip_piste(ctx, args):
    tr, c = _clip(ctx, args['clip'])
    if tr.get('locked'): raise ToolError(f"track \"{tr['name']}\" is locked by the person: don't touch it")
    ch = args.get('champs') or {}
    done = []
    for k, v in ch.items():
        if k == 'debut_sortie': c['start'] = round(max(0.0, float(v)), 3)
        elif k == 'duree': c['dur'] = round(max(0.1, float(v)), 3)
        elif k == 'depart_fichier' and c['type'] != 'text': c['in'] = max(0.0, float(v))
        elif k == 'texte' and c['type'] == 'text': c['text'] = str(v)
        elif k in ('x', 'y') and c['type'] == 'text': c['style'][k] = float(v)
        elif k == 'taille' and c['type'] == 'text': c['style']['size'] = float(v)
        elif k == 'couleur' and c['type'] == 'text': c['style']['color'] = str(v)
        elif k == 'animation' and c['type'] == 'text': c['style']['anim'] = str(v)
        elif k == 'volume_db' and c['type'] != 'text': c['volumeDb'] = float(v)
        elif k == 'muet' and c['type'] == 'video': c['muted'] = bool(v)
        elif k == 'baisser_sous_voix' and c['type'] == 'audio': c['duck'] = bool(v)
        elif k == 'boucle' and c['type'] == 'audio': c['loop'] = bool(v)
        elif k == 'raison': c['note'] = str(v)[:200]
        elif k in ('fondu_entree', 'fondu_sortie'): c['fadeIn' if k == 'fondu_entree' else 'fadeOut'] = max(0.0, float(v))
        elif k in ('echelle', 'pos_x', 'pos_y', 'opacite', 'rotation') and c['type'] == 'video':
            look = c.setdefault('look', {})
            look[{'echelle': 'scale', 'pos_x': 'x', 'pos_y': 'y', 'opacite': 'opacity', 'rotation': 'rotation'}[k]] = float(v)
        elif k == 'piste':
            dst = next((t for t in ctx.p.get('tracks', []) if t['id'] == v or t['name'] == v), None)
            if not dst or dst['kind'] != tr['kind']: raise ToolError('destination track unknown or of another type')
            tr['clips'].remove(c); dst['clips'].append(c)
        else: raise ToolError(f'field "{k}" cannot be changed on a {c["type"]} clip')
        done.append(k)
    ctx.changed()
    return f"clip [{c['id']}] changed: {', '.join(done)}"


def supprimer_clips_piste(ctx, args):
    ids = set(args['clips'])
    n = 0
    for tr in ctx.p.get('tracks', []):
        if tr.get('locked') and any(c['id'] in ids for c in tr['clips']):
            raise ToolError(f"track \"{tr['name']}\" is locked by the person: don't touch it")
        before = len(tr['clips'])
        tr['clips'] = [c for c in tr['clips'] if c['id'] not in ids]
        n += before - len(tr['clips'])
    if args.get('supprimer_pistes_vides'): ctx.p['tracks'] = [t for t in ctx.p.get('tracks', []) if t['clips']]
    ctx.changed()
    return f'{n} clip(s) removed'


def mixage(ctx, args):
    mix = ctx.p.setdefault('mix', {})
    done = []
    for k_in, k in (('voix_db', 'voiceDb'), ('musique_db', 'musicDb'), ('bruitages_db', 'sfxDb')):
        if args.get(k_in) is not None: mix[k] = max(-40.0, min(12.0, float(args[k_in]))); done.append(k_in)
    for k_in, k in (('couper_voix', 'voiceMuted'), ('couper_musique', 'musicMuted'), ('couper_bruitages', 'sfxMuted'), ('masquer_sous_titres', 'captionsHidden')):
        if args.get(k_in) is not None: mix[k] = bool(args[k_in]); done.append(k_in)
    for pt in args.get('pistes') or []:
        tr = next((t for t in ctx.p.get('tracks', []) if t['id'] == pt.get('piste') or t['name'] == pt.get('piste')), None)
        if not tr: raise ToolError(f"unknown track \"{pt.get('piste')}\"")
        if pt.get('volume_db') is not None: tr['volumeDb'] = float(pt['volume_db'])
        if pt.get('muet') is not None: tr['muted'] = bool(pt['muet'])
        if pt.get('masquee') is not None: tr['hidden'] = bool(pt['masquee'])
        done.append(tr['name'])
    ctx.changed()
    return f"mix set: {', '.join(done) or 'nothing'}"


FORMATS = {'16:9': (1920, 1080), '9:16': (1080, 1920), '1:1': (1080, 1080), '4:5': (1080, 1350), '4k': (3840, 2160)}


def format_projet(ctx, args):
    f = ctx.p['format']
    if args.get('format'):
        if args['format'] not in FORMATS: raise ToolError(f"unknown format ({', '.join(FORMATS)})")
        f['width'], f['height'] = FORMATS[args['format']]
    if args.get('ips'): f['fps'] = int(args['ips'])
    ctx.changed()
    return f"format: {f['width']}×{f['height']} at {f['fps']} fps" + (" (vertical: set the shots' horizontal framing with modifier_element if the subject isn't centered)" if f['height'] > f['width'] else '')


def marqueurs(ctx, args):
    ms = ctx.p.setdefault('markers', [])
    if args.get('action') == 'supprimer':
        ids = set(args.get('ids') or [])
        ctx.p['markers'] = [m for m in ms if m['id'] not in ids] if ids else []
        ctx.changed()
        return 'markers removed'
    if args.get('action') == 'ajouter':
        m = {'id': store.new_id('k'), 't': round(float(args['temps_sortie']), 3), 'label': args.get('texte', '')}
        ms.append(m)
        ctx.changed()
        return f"marker [{m['id']}] at {m['t']:.1f} s"
    return json.dumps(ms, ensure_ascii=False) or '[]'


def exporter(ctx, args):
    from .. import jobs, render as R
    preset = args.get('preset') or 'web'
    if preset == 'xml':
        from .. import interchange
        store.save_project(ctx.p)
        return f"edit exported as XML (Premiere / Resolve): {interchange.export_xml(ctx.p)}"
    if preset not in R.PRESETS: raise ToolError(f"unknown preset ({', '.join(R.PRESETS)})")
    if not ctx.p['timeline']: raise ToolError('empty timeline')
    store.save_project(ctx.p)
    pid = ctx.p['id']
    job = jobs.submit('render', lambda job: R.render(store.get_project(pid), job, preset), pid, f"render — {ctx.p.get('title') or ctx.p['name']}")
    return f"export started ({R.PRESETS[preset]['label']}): the person follows its progress in the Export workspace"


# ------------------------------------------------------------------ image effects (same types as web/src/remotion/effects.tsx)
VFX = {
    'motion': {'scale0': 100, 'scale1': 115, 'x0': 0, 'x1': 0, 'y0': 0, 'y1': 0, 'rot0': 0, 'rot1': 0, 'ease': 'douce'},
    'fade': {'in': 0.5, 'out': 0.5, 'color': 'noir'}, 'mirror': {'axis': 'h'},
    'blur': {'amount': 8}, 'sharpen': {'amount': 35}, 'pixelate': {'size': 16},
    'glow': {'amount': 45, 'radius': 18}, 'grain': {'amount': 25, 'size': 1}, 'rgbsplit': {'amount': 6},
    'bw': {'amount': 100}, 'sepia': {'amount': 70}, 'hue': {'deg': 90}, 'invert': {'amount': 100},
    'letterbox': {'ratio': '2.39', 'color': '#000000'}, 'rounded': {'radius': 6}, 'border': {'width': 8, 'color': '#ffffff'},
    'shadow': {'amount': 60, 'size': 30, 'y': 14},
}


def effets_image(ctx, args):
    if args.get('clip'): _, t = _clip(ctx, args['clip'])
    else: _, t = ctx.item(args['element'])
    if t['type'] in ('card', 'text', 'audio'): raise ToolError("this item does not take image effects")
    look = t.setdefault('look', {})
    fx = look.setdefault('effects', [])
    if args.get('vider'): fx.clear()
    rm = set(args.get('retirer') or [])
    if rm: fx[:] = [e for e in fx if e['id'] not in rm and e['kind'] not in rm]
    added = []
    for e in args.get('ajouter') or []:
        kind = e.get('type')
        if kind not in VFX: raise ToolError(f"unknown effect \"{kind}\" ({', '.join(VFX)})")
        p = dict(VFX[kind])
        for k, v in e.items():
            if k in p: p[k] = v
        item = {'id': store.new_id('x'), 'kind': kind, 'on': True, 'p': p}
        fx.append(item); added.append(f"{kind} [{item['id']}]")
    ctx.changed()
    return f"effects: {', '.join(added) or 'none added'}; in place: {', '.join(e['kind'] for e in fx) or 'none'}"


def analyser_video(ctx, args):
    """opens a reference video (link, file or project source): frames, shots, speech, recognized sounds and music"""
    from .. import refs
    src = str(args['video']).strip()
    if not re.match(r'^https?://', src) and not os.path.isabs(os.path.expanduser(src)):
        s = ctx.src(src)
        src = s['path']
    lang = (ctx.pack.get('whisper') or {}).get('language') or None
    try:
        out = refs.analyse(src, args.get('debut', 0), args.get('fin'), int(args.get('images', 8)), args.get('sons', True) is not False,
                           None, lang)
    except RuntimeError as e:
        raise ToolError(str(e))
    return out

TOOLS = [
    ('etat_projet', "Project summary: sources (duration, transcript), timeline items with their ids, estimated edited duration, music. Call it first.",
     S({}), etat_projet, False),
    ('lire_transcription', "Word-by-word transcript of a range of a source (20 min max per call), with times in source seconds and \"name:\" when the speaker is not the main person. debut / fin = start / end (s).",
     S({'source': STR, 'debut': NUM, 'fin': NUM}, ['source', 'debut', 'fin']), lire_transcription, False),
    ('chercher_texte', "Searches the transcripts for a phrase (texte; accents and punctuation ignored) and returns its times.",
     S({'texte': STR, 'source': STR}, ['texte']), chercher_texte, False),
    ('moments_forts', "Highlights of a long source (shouts, voice peaks, swear words, hype words) with an excerpt: use it on a VOD instead of reading everything. nombre = how many.",
     S({'source': STR, 'nombre': {'type': 'integer'}}, ['source']), moments_forts, False),
    ('bibliotheque', "The user's library: type=sfx (named sounds, then \"f:…\" files), type=musique (music, filterable by mood with ambiance: \"action\", \"colère\", \"Funny, Quirky\"…), type=vfx (visuals / overlays). \"recherche\" filters by keyword, \"nombre\" = how many.",
     S({'type': {'type': 'string', 'enum': ['sfx', 'musique', 'vfx']}, 'ambiance': STR, 'recherche': STR, 'nombre': {'type': 'integer'}}, ['type']), bibliotheque, False),
    ('regarder', "Looks at a frame of a source at a given time (temps, source seconds): to check what is happening on screen, the framing, where the face or the subject is (0-1 coordinates for zooms).",
     S({'source': STR, 'temps': NUM}, ['source', 'temps']), regarder, False),
    ('regarder_montage', "Looks at the edited video at a given time (temps, output seconds): the shot's frame + the caption and effects placed at that moment. To check your work.",
     S({'temps': NUM}, ['temps']), regarder_montage, False),
    ('regler_style', "Render settings for THIS project (on top of the style), in reglages: police (font), taille_sous_titres (caption size), couleur_sous_titres (caption color, #hex), contour (outline), fond_sous_titres (caption box), majuscules (uppercase), mot_a_mot (word by word), marge_bas (bottom margin), silence_max (max silence), couper_silences (cut silences), vitesse_base (base speed), musique_db, baisse_musique_db (music ducking), bruitages_db (sfx level), censure (bleep), zoom_visage (face zoom), zoom_centre (center zoom), visage (face, [x, y] 0-1).",
     S({'reglages': {'type': 'object'}}, ['reglages']), regler_style, True),
    ('lire_element', "Full JSON of an item (shot with its captions and effects, card…).",
     S({'element': STR}, ['element']), lire_element, False),
    ('definir_titre', "Saves the video's title (titre; the common thread of the edit and the thumbnail).",
     S({'titre': STR}, ['titre']), definir_titre, True),
    ('ajouter_plan', "Adds a shot (excerpt of a source, debut / fin = start / end in source seconds). Silences are cut automatically (coupes_silences=false to keep a whole exchange). Captions are generated from the transcript (sous_titres='aucun' for none): proofread them in the result and fix them with modifier_sous_titres if needed.",
     S({'source': STR, 'debut': NUM, 'fin': NUM, 'titre_chapitre': {'type': 'string', 'description': 'YouTube chapter name, on the first shot of a section'},
        'coupes_silences': {'type': 'boolean'}, 'sous_titres': {'type': 'string', 'enum': ['auto', 'aucun']}, **POS},
       ['source', 'debut', 'fin']), ajouter_plan, True),
    ('ajouter_carton', "Adds a full-screen card (text on a plain background): title (big title, with a colored band), chapter (section title), narr (narration text). texte / sous_texte = text / subtext, duree = duration (s). For a full-screen image or video (logo, photo…), use ajouter_media.",
     S({'style': {'type': 'string', 'enum': ['title', 'chapter', 'narr']}, 'texte': STR, 'sous_texte': STR, 'duree': NUM,
        'fond': {'type': 'string', 'description': 'background color #rrggbb (black by default)'}, 'couleur': {'type': 'string', 'description': 'text color #rrggbb (white by default)'},
        'bandeau': {'type': 'string', 'description': "title: band color #rrggbb, '' for none"}, **POS}, ['style', 'texte']), ajouter_carton, True),
    ('ajouter_arret_image', "Freeze frame with a zoom (highlight moment), with a library sound (son) if one is given. temps = source time, duree = duration, echelle = zoom scale.",
     S({'source': STR, 'temps': NUM, 'duree': NUM, 'cible': {'description': "target: 'visage' (face), 'centre' (center) or [x, y] between 0 and 1"},
        'echelle': NUM, 'son': STR, **POS}, ['source', 'temps']), ajouter_arret_image, True),
    ('ajouter_media', "Adds a full-screen video or image (logo, photo, poster…): chemin (path) = id of a project source or path of a file (library). fond_vert = remove green screen.",
     S({'chemin': STR, 'duree': NUM, 'fond_vert': {'type': 'boolean'}, **POS}, ['chemin']), ajouter_media, True),
    ('ajouter_effets', "Adds effects on a shot (times in SOURCE seconds, inside the shot; debut / fin = start / end). type: zoom {debut, fin, cible: 'visage'|'centre'|[x,y], echelle} (hard zoom), secousse (shake) {debut, fin, force}, teinte (tint) {debut, fin, mode: nb (black & white)|flash}, son (sound) {temps, nom, volume_db}, texte {temps, duree, texte, style: gros (big)|note}, coupe (cut) {debut, fin} (removes a passage), garder (keep) {debut, fin} (keeps a silence), vitesse (speed) {debut, fin, facteur}, censure {debut, fin} (forced bleep).",
     S({'element': STR, 'effets': {'type': 'array', 'items': {'type': 'object', 'properties': {'type': {'type': 'string', 'enum': list(FX_KINDS)}}, 'required': ['type']}}},
       ['element', 'effets']), ajouter_effets, True),
    ('supprimer_effets', "Removes effects from a shot, by ids and/or by types (e.g. types=['son']).",
     S({'element': STR, 'ids': {'type': 'array', 'items': STR}, 'types': {'type': 'array', 'items': STR}}, ['element']), supprimer_effets, True),
    ('ecrire_sous_titres', "Replaces (or adds to, with remplacer=false) a shot's captions. Each caption: {debut, fin, texte, personne (person id, omitted = main person), style: normal|hype|cri (shout)}. Meaningful groups of 2-6 words, never before the speech.",
     S({'element': STR, 'remplacer': {'type': 'boolean'}, 'sous_titres': {'type': 'array', 'items': {'type': 'object', 'properties': {
         'debut': NUM, 'fin': NUM, 'texte': STR, 'personne': STR, 'style': {'type': 'string', 'enum': ['normal', 'hype', 'cri']}}, 'required': ['debut', 'texte']}}},
       ['element', 'sous_titres']), ecrire_sous_titres, True),
    ('modifier_sous_titres', "Fixes existing captions by id: {id, texte?, personne?, style?, debut?, fin?, supprimer? (delete)}.",
     S({'element': STR, 'modifications': {'type': 'array', 'items': {'type': 'object', 'properties': {
         'id': STR, 'texte': STR, 'personne': STR, 'style': STR, 'debut': NUM, 'fin': NUM, 'supprimer': {'type': 'boolean'}}, 'required': ['id']}}},
       ['element', 'modifications']), modifier_sous_titres, True),
    ('generer_sous_titres', "Regenerates a shot's captions from the transcript.",
     S({'element': STR}, ['element']), generer_sous_titres, True),
    ('modifier_element', "Changes an item: espace_avant (seconds of empty gap before the item, all types), raison (why this choice, shown to the person); champs among debut, fin, titre_chapitre, coupes_silences, silence_max (s), vitesse (speed), volume_db, fondu_entree (fade in), fondu_sortie (fade out), cadrage_horizontal (horizontal framing, 0 left … 1 right, in vertical format) (shot); texte, sous_texte, duree, style, sons_auto (false = turns off the card's automatic sounds), sons=[{nom, decalage (s from the start of the card), db}] (replaces the sounds placed on the card) (card); temps, duree, cible, echelle, son (freeze frame). Card: image (logo or picture shown on the card: project image source id/name, library visual name or file path; '' = none; with style logo the card is just that image).",
     S({'element': STR, 'champs': {'type': 'object'}, 'regenerer_sous_titres': {'type': 'boolean'}}, ['element', 'champs']), modifier_element, True),
    ('supprimer_element', "Removes items from the timeline.",
     S({'elements': {'type': 'array', 'items': STR}}, ['elements']), supprimer_element, True),
    ('deplacer_element', "Moves an item (apres / avant / position).",
     S({'element': STR, **POS}, ['element']), deplacer_element, True),
    ('vider_timeline', "Clears the whole timeline (to re-edit from scratch).", S({}), vider_timeline, True),
    ('musique', "Background music: action=ajouter (add) {nom, de_element, a_element, volume_db, debut_morceau (start offset in the track)} plays continuously from the start of de_element to the end of a_element (auto-ducked under the voice); action=supprimer (remove) {id}.",
     S({'action': {'type': 'string', 'enum': ['ajouter', 'supprimer']}, 'nom': STR, 'de_element': STR, 'a_element': STR, 'volume_db': NUM,
        'debut_morceau': NUM, 'id': STR}, ['action']), musique, True),
    ('ajouter_texte', "Free on-screen text (title, callout, lower third…) on a Text track, placed at the start of an item + decalage (offset, s of edited video), or at debut_sortie (output time). style: titre (title), sous-titre (subtitle), encadre (callout), bandeau (lower third), note. taille = size, couleur = color.",
     S({'texte': STR, 'element': STR, 'decalage': NUM, 'debut_sortie': NUM, 'duree': NUM, 'style': {'type': 'string', 'enum': list(TEXT_PRESETS)},
        'x': NUM, 'y': NUM, 'taille': NUM, 'couleur': STR, 'animation': {'type': 'string', 'enum': ['pop', 'fade', 'slide', 'type', 'none']}}, ['texte']), ajouter_texte, True),
    ('ajouter_incrustation', "Overlays a video / image on top of the edit (GTA meme, confetti…: bibliotheque type=vfx), fond_vert=true to key out the green. Placed at the start of an item + decalage (offset), or at debut_sortie (output time). echelle = scale.",
     S({'chemin': STR, 'element': STR, 'decalage': NUM, 'debut_sortie': NUM, 'duree': NUM, 'fond_vert': {'type': 'boolean'}, 'echelle': NUM,
        'x': NUM, 'y': NUM, 'volume_db': NUM}, ['chemin']), ajouter_incrustation, True),
    ('etalonnage', "Color grade of items (all of them if elements is omitted): preset among none, film, vif (vivid), doux (soft), nb (black & white), chaud (warm), froid (cool), vintage, nuit (night), punch, and/or adjustments -100..100 (exposure, contrast, saturation, temperature, tint, highlights, shadows) and vignette 0..100.",
     S({'elements': {'type': 'array', 'items': STR}, 'preset': STR, 'exposure': NUM, 'contrast': NUM, 'saturation': NUM, 'temperature': NUM,
        'tint': NUM, 'highlights': NUM, 'shadows': NUM, 'vignette': NUM, 'remplacer': {'type': 'boolean'}}), etalonnage, True),
    ('transition', "Entry transition of an item: fade, flash, zoom, whip, glitch, blur or aucune (none) (with an automatic sound). duree = duration.",
     S({'element': STR, 'type': STR, 'duree': NUM}, ['element', 'type']), transition, True),
    ('regler_image', "Transform of an item: x / y (offset in %), echelle (scale, 1 = 100 %), rotation (°), opacite (opacity 0-1), fusion (CSS blend mode), miroir (mirror).",
     S({'element': STR, 'x': NUM, 'y': NUM, 'echelle': NUM, 'rotation': NUM, 'opacite': NUM, 'fusion': STR, 'miroir': {'type': 'boolean'}}, ['element']), regler_image, True),
    ('etapes', "Your step list, shown to the person and ticked off live. For any multi-part request (full edit, big change), call it BEFORE you start with 3 to 7 concrete steps, then each time you move from one step to the next (only one en_cours, the previous ones fait). Always send the full list. etat: a_faire (to do), en_cours (in progress), fait (done).",
     S({'etapes': {'type': 'array', 'items': {'type': 'object', 'properties': {'texte': STR, 'etat': {'type': 'string', 'enum': ['a_faire', 'en_cours', 'fait']}}, 'required': ['texte', 'etat']}}}, ['etapes']), etapes, False),
    ('ordre_piste', "Stacking order of a free track (video / title tracks among themselves, audio tracks among themselves): a higher track is drawn above the lower ones. position = monter (up), descendre (down), tout_en_haut (top), tout_en_bas (bottom).",
     S({'piste': STR, 'position': {'type': 'string', 'enum': ['monter', 'descendre', 'tout_en_haut', 'tout_en_bas']}}, ['piste', 'position']), ordre_piste, True),
    ('delier_audio', "Unlinks the sound of a V1 shot (element) or of a video overlay (clip): it becomes separate audio clips (Voice lane / audio track) that move on their own for a J-cut / L-cut (the sound starts before or ends after the picture); action=rattacher (relink) for the reverse.",
     S({'element': STR, 'clip': STR, 'action': {'type': 'string', 'enum': ['delier', 'rattacher']}}), delier_audio, True),
    ('modifier_clip_piste', "Changes a free-track clip (text, overlay, audio) by its id: champs among debut_sortie (output start), duree, depart_fichier (start offset in the file), texte, x, y, taille, couleur, animation (text), volume_db, muet (muted), baisser_sous_voix (duck under voice), fondu_entree (fade in), fondu_sortie (fade out), echelle, pos_x, pos_y, opacite, rotation (overlay), boucle (loop, audio), raison (why this clip, shown to the person), piste (id or name of a track of the same type).",
     S({'clip': STR, 'champs': {'type': 'object'}}, ['clip', 'champs']), modifier_clip_piste, True),
    ('supprimer_clips_piste', "Removes free-track clips (texts, overlays, audio) by id. supprimer_pistes_vides = also remove empty tracks.",
     S({'clips': {'type': 'array', 'items': STR}, 'supprimer_pistes_vides': {'type': 'boolean'}}, ['clips']), supprimer_clips_piste, True),
    ('mixage', "Project levels: voix_db (voice), musique_db (music), bruitages_db (sound effects) (-40..12, 0 = the style's level), couper_voix / couper_musique / couper_bruitages (mute), masquer_sous_titres (hide captions), and per free track: pistes=[{piste, volume_db, muet (muted), masquee (hidden)}].",
     S({'voix_db': NUM, 'musique_db': NUM, 'bruitages_db': NUM, 'couper_voix': {'type': 'boolean'}, 'couper_musique': {'type': 'boolean'},
        'couper_bruitages': {'type': 'boolean'}, 'masquer_sous_titres': {'type': 'boolean'},
        'pistes': {'type': 'array', 'items': {'type': 'object'}}}), mixage, True),
    ('format_projet', "Changes the video format: 16:9, 9:16 (vertical), 1:1, 4:5, 4k; ips = frames per second.",
     S({'format': {'type': 'string', 'enum': list(FORMATS)}, 'ips': {'type': 'integer'}}), format_projet, True),
    ('marqueurs', "Timeline markers (cues for the person): action=lister (list), ajouter (add: temps_sortie = output time, texte) or supprimer (remove: ids; without ids: all).",
     S({'action': {'type': 'string', 'enum': ['lister', 'ajouter', 'supprimer']}, 'temps_sortie': NUM, 'texte': STR, 'ids': {'type': 'array', 'items': STR}}, ['action']), marqueurs, True),
    ('exporter', "Starts exporting the video (only when asked to): preset web (H.264), 4k, hevc, prores, draft (½ draft), audio (WAV), xml (edit for Premiere Pro / DaVinci Resolve).",
     S({'preset': {'type': 'string', 'enum': ['web', '4k', 'hevc', 'prores', 'draft', 'audio', 'xml']}}), exporter, True),
    ('effets_image', "Stacked image effects on a shot / media (element) or a track video clip (clip): ajouter (add)=[{type, parameters}], retirer (remove)=[ids or types], vider (clear). Types and parameters (default values): motion (Ken Burns / start→end animation: scale0, scale1 in %, x0, x1, y0, y1 in % of the frame, rot0, rot1, ease douce|lineaire|entree|sortie (smooth|linear|ease-in|ease-out)), fade (in, out in s, color noir|blanc|transparent (black|white|transparent)), mirror (axis h|v), blur (amount px), sharpen (amount 0-100), pixelate (size px), glow (amount, radius), grain (amount, size), rgbsplit (amount px), bw/sepia/invert (amount %), hue (deg), letterbox (ratio 2.39|2.0|1.85|1.33|1, color), rounded (radius %), border (width px, color), shadow (amount %, size, y). Use them with taste: an effect must serve the point.",
     S({'element': STR, 'clip': STR, 'ajouter': {'type': 'array', 'items': {'type': 'object'}}, 'retirer': {'type': 'array', 'items': STR}, 'vider': {'type': 'boolean'}}), effets_image, True),
    ('analyser_video', "Opens a reference or example video: YouTube / Twitch / other link, file path, or id of a project source. On the excerpt [debut, fin] (s, 5 min max, 90 s by default; aim for the useful part, e.g. the intro): key frames (you see them), shot changes, speech, loudness, and above all the LIBRARY SOUNDS AND MUSIC recognized with their times (name to reuse as-is in your tools) and the position within the track. images = number of frames, sons = recognize sounds. Use it whenever you are given an example video or asked to \"do it like\" a video.",
     S({'video': STR, 'debut': NUM, 'fin': NUM, 'images': {'type': 'integer'}, 'sons': {'type': 'boolean'}}, ['video']), analyser_video, False),
    ('noter_preference', "Remembers a preference (texte) for later: portee (scope)=projet (this project), pack (every video of this pack: only if asked to remember a general rule), personne (a preference tied to a person).",
     S({'portee': {'type': 'string', 'enum': ['projet', 'pack', 'personne']}, 'texte': STR, 'personne': STR}, ['texte']), noter_preference, False),
]

BY_NAME = {t[0]: t for t in TOOLS}
LABELS = {
    'etat_projet': '📋 reads the project', 'lire_transcription': '📖 reads the transcript', 'chercher_texte': '🔎 searches',
    'moments_forts': '⚡ finds the highlights', 'bibliotheque': '🎵 browses the library', 'lire_element': '🔍 inspects an item',
    'definir_titre': '🏷️ title', 'ajouter_plan': '🎬 adds a shot', 'ajouter_carton': '🪧 adds a card',
    'ajouter_arret_image': '⏸️ freeze frame', 'ajouter_media': '🎞️ adds media', 'ajouter_effets': '✨ adds effects',
    'supprimer_effets': '🧹 removes effects', 'ecrire_sous_titres': '💬 writes captions', 'modifier_sous_titres': '✏️ fixes captions',
    'generer_sous_titres': '💬 regenerates captions', 'modifier_element': '✏️ edits an item', 'supprimer_element': '🗑️ removes',
    'deplacer_element': '↕️ moves', 'vider_timeline': '🧨 clears the timeline', 'ajouter_texte': '🔤 adds a text',
    'ajouter_incrustation': '🖼️ overlays', 'etalonnage': '🎨 color grades', 'transition': '🔀 transition', 'regler_image': '📐 sets the transform',
    'modifier_clip_piste': '✏️ edits a clip', 'supprimer_clips_piste': '🗑️ removes clips', 'mixage': '🎚️ mix', 'analyser_video': '🔎 analyzes a video', 'effets_image': '✨ image effects', 'format_projet': '📐 format', 'marqueurs': '📍 markers', 'exporter': '📤 exports',
    'regarder': '👁 looks', 'regarder_montage': '👁 looks at the edit', 'regler_style': '🎛 sets the style', 'musique': '🎶 music', 'noter_preference': '🧠 remembers a preference',
}


def schemas():
    return [{'name': n, 'description': d, 'input_schema': s} for n, d, s, _, _ in TOOLS]


def validate(name, args):
    if name not in BY_NAME: raise ToolError(f'unknown tool {name}')
    if not isinstance(args, dict): raise ToolError('invalid arguments (JSON object expected)')
    schema = BY_NAME[name][2]
    missing = [k for k in schema.get('required', []) if k not in args]
    if missing: raise ToolError(f"missing arguments: {', '.join(missing)}")


def run(ctx, name, args):
    """runs a tool -> (result text, error?, jpeg images)"""
    try:
        validate(name, args)
        out = BY_NAME[name][3](ctx, args)
        if isinstance(out, dict): return str(out.get('text', '')), False, out.get('images', [])
        return str(out), False, []
    except ToolError as e:
        return f'ERROR: {e}', True, []
    except (KeyError, ValueError, TypeError) as e:
        return f'ERROR: {type(e).__name__} {e}', True, []


def summary(name, args):
    lab = LABELS.get(name, name)
    bits = []
    for k in ('source', 'element', 'nom', 'style', 'texte', 'titre', 'titre_chapitre'):
        if args.get(k): bits.append(str(args[k])[:40])
    if 'debut' in args and 'fin' in args:
        try: bits.append(f"{_fmt(args['debut'])}→{_fmt(args['fin'])}")
        except (TypeError, ValueError): pass
    if args.get('effets'): bits.append(', '.join(str(e.get('type')) for e in args['effets'][:6]))
    return lab + (' · ' + ' · '.join(bits) if bits else '')
