"""Outils de montage donnés à l'IA. Chaque outil lit ou modifie le projet (dict) du contexte ; après chaque
modification, le projet est enregistré et poussé à l'éditeur, qui se met à jour en direct.

Modèle de timeline (le même que l'éditeur, voir web/src/types.ts) : une suite d'éléments joués l'un après l'autre.
  clip    {src, in, out, label, jump, speed, captions[], fx[]}   temps = secondes dans la source
  card    {dur, text, sub, style: title|chapter|narr, bg, color, band}
  freeze  {src, t, dur, target, scale, sfx}
  media   {path, url, dur}
Effets d'un plan (fx), temps source : zoom, shake, tint, sfx, text, cut, keep, speed, censor.
Musique : project.music = [{name, url, gainDb, db, fromItem, toItem}] (de l'élément A à l'élément B inclus)."""
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
    except (TypeError, ValueError): raise ToolError(f'« {name} » doit être un nombre (secondes)')


class Ctx:
    """contexte d'une session IA : projet en mémoire + fonction appelée après chaque modification."""
    def __init__(self, project, on_change=None, log=None):
        self.p = project
        self.on_change = on_change or (lambda p: None)
        self.log = log or (lambda s: None)
        self._words = {}
        self.pack = store.get_pack(project['packId']) or {}
        self.changes = 0

    def words(self, sid):
        if sid not in self._words: self._words[sid] = store.get_words(self.p['id'], sid)
        return self._words[sid]

    def src(self, sid):
        try: return store.source(self.p, sid)
        except KeyError: raise ToolError(f"source inconnue « {sid} ». Sources : {', '.join(s['id'] for s in self.p['sources'])}")

    def item(self, iid):
        for i, it in enumerate(self.p['timeline']):
            if it['id'] == iid: return i, it
        raise ToolError(f'élément inconnu « {iid} » (etat_projet donne les ids)')

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


# ------------------------------------------------------------------ calculs partagés avec l'éditeur
def pieces(clip, words, style):
    """morceaux gardés d'un plan (coupes des silences) — même logique que web/src/remotion/resolve.ts."""
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
    """morceaux découpés aux changements de vitesse -> [(début, fin, vitesse)] (comme resolve.ts:withSpeed)"""
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


# ------------------------------------------------------------------ lecture
def etat_projet(ctx, args):
    p = ctx.p
    lines = [f"Projet « {p['name']} » — pack {ctx.pack.get('name', p['packId'])} — {p['format']['width']}x{p['format']['height']} "
             f"— titre : {p.get('title') or '(pas encore de titre)'}"]
    lines.append('Sources :')
    for s in p['sources']:
        nw = len(ctx.words(s['id']))
        st = s.get('status', {})
        lines.append(f"- {s['id']} ({s['name']}) {s['kind']} {_fmt(s['duration'])} — transcription : "
                     f"{'oui, %d mots' % nw if nw else st.get('transcript', 'non')} — qui parle : {st.get('speakers', 'non')}"
                     f" — voix/fond séparés : {st.get('stems', 'non')}")
    tl = p['timeline']
    total = 0.0
    lines.append(f'Timeline ({len(tl)} éléments) :')
    for i, it in enumerate(tl):
        d = item_duration(ctx, it); total += d
        if it['type'] == 'clip':
            fx = {}
            for f in it.get('fx', []): fx[f['kind']] = fx.get(f['kind'], 0) + 1
            fxs = ', '.join(f'{k}×{v}' for k, v in fx.items()) or 'aucun'
            lines.append(f"{i}. [{it['id']}] PLAN {it['src']} {it['in']:.2f}-{it['out']:.2f} ({_fmt(it['in'])}→{_fmt(it['out'])}, "
                         f"≈{d:.1f} s montés){' «' + it['label'] + '»' if it.get('label') else ''}"
                         f"{' coupes=non' if it.get('jump') is False else ''}{' vitesse=%g' % it['speed'] if it.get('speed', 1) != 1 else ''}"
                         f" — {len(it.get('captions', []))} sous-titres — effets : {fxs}")
        elif it['type'] == 'card':
            lines.append(f"{i}. [{it['id']}] CARTON {it['style']} {it['dur']:g} s « {it.get('text', '')} »")
        elif it['type'] == 'freeze':
            lines.append(f"{i}. [{it['id']}] ARRÊT SUR IMAGE {it['src']} à {it['t']:.2f} {it['dur']:g} s zoom {it.get('scale', 1)}")
        else:
            lines.append(f"{i}. [{it['id']}] MÉDIA {os.path.basename(it.get('path', ''))} {d:.1f} s")
    lines.append(f'Durée montée estimée : {_fmt(total)}')
    f = p['format']
    lines.append(f"Format : {f['width']}×{f['height']} à {f['fps']} i/s")
    mx = p.get('mix') or {}
    if mx: lines.append('Mixage : ' + ', '.join(f'{k}={v}' for k, v in mx.items()))
    if p.get('markers'): lines.append('Marqueurs : ' + ', '.join(f"[{m['id']}] {m['t']:.1f}s {m.get('label', '')}" for m in p['markers']))
    for tr in ctx.p.get('tracks', []):
        lines.append(f"Piste {tr['kind']} « {tr['name'] } » [{tr['id']}] : " + (', '.join(
            f"[{c['id']}] {c.get('text') or os.path.basename(c.get('path') or c.get('url') or '')[:30]} {c['start']:.1f}+{c['dur']:.1f}s" for c in tr['clips']) or 'vide'))
    if p.get('music'):
        ids = [it['id'] for it in tl]
        lines.append('Musique :')
        for m in p['music']:
            a = ids.index(m['fromItem']) if m['fromItem'] in ids else '?'
            b = ids.index(m['toItem']) if m['toItem'] in ids else '?'
            lines.append(f"- [{m['id']}] « {m['name']} » de l'élément {a} à {b} ({m.get('db', -15)} dB)")
    return '\n'.join(lines)


def lire_transcription(ctx, args):
    s = ctx.src(args['source'])
    a = _num(args.get('debut', 0), 'debut'); b = _num(args.get('fin', a + 300), 'fin')
    if b - a > 1200: b = a + 1200
    ws = ctx.words(s['id'])
    if not ws: return f"la source {s['id']} n'est pas transcrite (outil transcrire, ou bouton Transcrire dans l'éditeur)"
    txt = analyse.dump(ws, a, b)
    return f"{s['id']} {_fmt(a)}→{_fmt(b)} (temps en secondes dans la source ; « nom: » = autre personne que {ctx.p.get('defaultSpeaker') or 'la personne principale'}) :\n" + (txt or '(silence)')


def _norm(t):
    t = unicodedata.normalize('NFD', t.lower())
    return re.sub(r'[^a-z0-9 ]', '', ''.join(c for c in t if unicodedata.category(c) != 'Mn'))


def chercher_texte(ctx, args):
    q = _norm(args['texte']).split()
    if not q: raise ToolError('texte vide')
    out = []
    for s in ([ctx.src(args['source'])] if args.get('source') else ctx.p['sources']):
        ws = ctx.words(s['id'])
        toks = [_norm(w[2]).strip() for w in ws]
        for i in range(len(toks) - len(q) + 1):
            if all(toks[i + j] == q[j] or (j == len(q) - 1 and toks[i + j].startswith(q[j])) for j in range(len(q))):
                ctxt = ' '.join(w[2].strip() for w in ws[max(0, i - 8):i + len(q) + 8])
                out.append(f"{s['id']} @{ws[i][0]:.2f} ({_fmt(ws[i][0])}) : …{ctxt}…")
                if len(out) >= 30: break
    return '\n'.join(out) or 'aucune occurrence'


def moments_forts(ctx, args):
    s = ctx.src(args['source'])
    ms = analyse.moments(ctx.p, s['id'], top=int(args.get('nombre', 30)))
    return '\n'.join(f"@{m['t']} ({_fmt(m['t'])}) score {m['score']} : {m['extrait']}" for m in ms) or 'rien trouvé'


def _lib():
    lib = library.ready()
    if lib is None:
        library.warm()
        raise ToolError("bibliothèque de sons pas encore prête (ou pas d'accès au dossier). Continue sans bruitages ni musiques "
                        "et signale-le dans ta réponse.")
    return lib


def bibliotheque(ctx, args):
    lib = _lib()
    q = (args.get('recherche') or '').lower()
    n = int(args.get('nombre', 40))
    if args.get('type') == 'musique':
        tracks = library.suggest_music(args.get('ambiance') or '', n=400)
        if q: tracks = [t for t in tracks if q in f"{t['name']} {' '.join(t['moods'])} {' '.join(t['genres'])} {t.get('folder', '')}".lower()]
        return '\n'.join(f"« {t['name']} » — {', '.join(t['moods']) or t.get('folder', '')} — énergie {t['energy'] or '?'} — "
                         f"{t['bpm'] or '?'} BPM" for t in tracks[:n]) or 'aucune musique (Réglages › Bibliothèques)'
    if args.get('type') == 'vfx':
        items = [v for v in lib['vfx'] if not q or q in f"{v['name']} {v['folder']}".lower()]
        return '\n'.join(f"{v['folder']}/{v['name']} ({v['kind']}) : {v['path']}" for v in items[:n]) or 'aucun visuel'
    named = [(k, v) for k, v in lib['sfx'].items() if not v.get('file')]
    files = [(k, v) for k, v in lib['sfx'].items() if v.get('file')]
    if q:
        named = [(k, v) for k, v in named if q in f"{k} {v['help']}".lower()]
        files = [(k, v) for k, v in files if q in f"{v['label']} {v['help']}".lower()]
    out = [f"{k} : {v['help']} ({len(v['variants'])} variantes)" for k, v in named]
    out += [f"{k} : {v['label']} — {v['help']}" for k, v in files[:max(0, n - len(out))]]
    more = len(files) - max(0, n - len(named))
    if more > 0: out.append(f"… et {more} autres sons (affine avec « recherche »)")
    return '\n'.join(out) or 'aucun son (Réglages › Bibliothèques)'


def regarder(ctx, args):
    """image d'une source à un instant (l'IA voit vraiment la vidéo)"""
    from .. import previews
    s = ctx.src(args['source'])
    if s['kind'] == 'audio': raise ToolError('source audio : rien à regarder')
    path = s['path']
    if s.get('proxy'):
        from ..media import path_of
        path = path_of(s['proxy']) or path
    t = _num(args.get('temps', 0), 'temps')
    jpg = previews.thumb(path, t, 768)
    if not jpg: raise ToolError('image impossible à extraire')
    return {'text': f"{s['id']} à {_fmt(t)} ({s['width']}x{s['height']})", 'images': [open(jpg, 'rb').read()]}


def regarder_montage(ctx, args):
    """ce qu'on voit dans la vidéo montée à un instant : l'image du plan + ce qui est posé dessus"""
    t_out = _num(args['temps'], 'temps')
    acc = 0.0
    st = ctx.style()
    for it in ctx.p['timeline']:
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
                r['text'] = (f"à {_fmt(t_out)} de la vidéo montée : plan [{it['id']}] ({it['src']} à {_fmt(src_t)})"
                             f" — sous-titre : {caps[0] if caps else 'aucun'} — effets : {', '.join(fx) or 'aucun'}")
                return r
            return f"à {_fmt(t_out)} : {it['type']} [{it['id']}] « {it.get('text', '')} »"
        acc += d
    raise ToolError(f'la vidéo montée dure {_fmt(acc)}')


STYLE_KEYS = {
    'police': ('captions', 'font'), 'taille_sous_titres': ('captions', 'size'), 'couleur_sous_titres': ('captions', 'color'),
    'contour': ('captions', 'outline'), 'fond_sous_titres': ('captions', 'box'), 'majuscules': ('captions', 'uppercase'),
    'mot_a_mot': ('captions', 'mode'), 'marge_bas': ('captions', 'bottom'), 'silence_max': ('jumpCuts', 'gap'),
    'couper_silences': ('jumpCuts', 'enabled'), 'vitesse_base': ('baseSpeed', None), 'musique_db': ('music', 'db'),
    'baisse_musique_db': ('music', 'duckDb'), 'bruitages_db': ('sfxDb', None), 'censure': ('censor', 'captions'),
    'zoom_visage': ('zoom', 'face'), 'zoom_centre': ('zoom', 'center'), 'visage': ('face', None),
}


def regler_style(ctx, args):
    """réglages de rendu propres à ce projet (par-dessus le style)"""
    ov = ctx.p.setdefault('overrides', {})
    done = []
    for k, v in (args.get('reglages') or {}).items():
        if k not in STYLE_KEYS: raise ToolError(f"réglage inconnu « {k} » ({', '.join(STYLE_KEYS)})")
        a, b = STYLE_KEYS[k]
        if k == 'mot_a_mot': v = 'words' if v else 'groups'
        if k == 'censure': ov.setdefault('censor', {}).update({'captions': bool(v), 'audio': bool(v)}); done.append(k); continue
        if b: ov.setdefault(a, {})[b] = v
        else: ov[a] = v
        done.append(k)
    ctx.changed()
    return f"réglé : {', '.join(done)}"


def lire_element(ctx, args):
    i, it = ctx.item(args['element'])
    return json.dumps(it, ensure_ascii=False)


# ------------------------------------------------------------------ écriture
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
    if b - a < 0.2: raise ToolError(f'plan trop court ou hors de la source (durée {s["duration"]:.1f} s)')
    clip = {'id': store.new_id('i'), 'type': 'clip', 'src': s['id'], 'in': round(a, 3), 'out': round(b, 3),
            'label': args.get('titre_chapitre') or '', 'jump': args.get('coupes_silences'), 'speed': 1.0,
            'captions': [], 'fx': []}
    if args.get('sous_titres', 'auto') != 'aucun' and ctx.words(s['id']):
        clip['captions'] = analyse.make_captions(ctx.words(s['id']), a, b, ctx.style(), ctx.p.get('glossary'), ctx.p.get('defaultSpeaker'))
    idx = _insert(ctx, clip, args)
    ctx.changed()
    caps = ' / '.join(f"[{c['id']}] {c['t0']:.1f} {(c['speaker'] + ': ') if c['speaker'] else ''}{c['text']}" for c in clip['captions'][:60])
    return f"plan [{clip['id']}] ajouté en position {idx} (≈{item_duration(ctx, clip):.1f} s montés). Sous-titres auto ({len(clip['captions'])}) : {caps or 'aucun'}"


CARD_STYLES = {'titre': 'title', 'chapitre': 'chapter', 'texte': 'narr'}


def _color(v, name):
    v = str(v or '').strip()
    if v and not re.fullmatch(r'#[0-9a-fA-F]{6}', v): raise ToolError(f'{name} : couleur #rrggbb attendue')
    return v


def ajouter_carton(ctx, args):
    style = CARD_STYLES.get(args.get('style', 'title'), args.get('style'))
    if style not in ('title', 'chapter', 'narr'): raise ToolError('style : title, chapter ou narr')
    card = {'id': store.new_id('i'), 'type': 'card', 'dur': round(_num(args.get('duree', 1.8 if style == 'chapter' else 1.4), 'duree'), 2),
            'text': args.get('texte', ''), 'sub': args.get('sous_texte', ''), 'style': style}
    for key, arg in (('bg', 'fond'), ('color', 'couleur')):
        if args.get(arg): card[key] = _color(args[arg], arg)
    if style == 'title' and 'bandeau' in args: card['band'] = _color(args['bandeau'], 'bandeau')
    idx = _insert(ctx, card, args)
    ctx.changed()
    return f"carton [{card['id']}] ({style}) en position {idx}"


def ajouter_arret_image(ctx, args):
    s = ctx.src(args['source'])
    t = _num(args['temps'], 'temps')
    fr = {'id': store.new_id('i'), 'type': 'freeze', 'src': s['id'], 't': round(t, 3), 'dur': round(_num(args.get('duree', 1.3), 'duree'), 2),
          'target': _target(args.get('cible', 'visage')), 'scale': float(args.get('echelle', 2.2)),
          'sfx': args.get('son') or None}
    idx = _insert(ctx, fr, args)
    ctx.changed()
    return f"arrêt sur image [{fr['id']}] en position {idx}"


def ajouter_media(ctx, args):
    path = args['chemin']
    src = next((x for x in ctx.p['sources'] if x['id'] == path), None)
    if src: path = src['path']
    if path in ('outro', 'OUTRO'):
        path = ctx.pack.get('outro') or ''
        if not path: raise ToolError("ce style n'a pas d'outro (Styles › Général)")
    if not os.path.exists(path): raise ToolError(f'fichier introuvable : {path}')
    info = probe(path)
    dur = float(args.get('duree') or (info['duration'] if info['kind'] != 'image' else 3.0))
    it = {'id': store.new_id('i'), 'type': 'media', 'path': path, 'url': file_url(path), 'kind': info['kind'],
          'dur': round(dur, 3), 'chroma': bool(args.get('fond_vert', False))}
    idx = _insert(ctx, it, args)
    ctx.changed()
    return f"média [{it['id']}] ({os.path.basename(path)}, {dur:.1f} s) en position {idx}"


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
    if not kind: raise ToolError(f"type d'effet inconnu « {e.get('type')} » ({', '.join(FX_KINDS)})")
    f = {'id': store.new_id('f'), 'kind': kind}
    if kind in ('sfx', 'text'):
        f['t'] = round(_num(e.get('temps', e.get('debut')), 'temps'), 3)
    else:
        f['t0'] = round(_num(e.get('debut'), 'debut'), 3); f['t1'] = round(_num(e.get('fin'), 'fin'), 3)
        if f['t1'] <= f['t0']: raise ToolError('fin <= debut')
    t = f.get('t', f.get('t0'))
    if not (clip['in'] - 0.5 <= t <= clip['out'] + 0.5):
        raise ToolError(f"effet à {t:.2f} hors du plan [{clip['id']}] ({clip['in']:.2f}-{clip['out']:.2f}) : les temps sont ceux de la source")
    if kind == 'zoom':
        f['target'] = _target(e.get('cible', 'visage'))
        st = ctx.style().get('zoom', {})
        f['scale'] = float(e.get('echelle') or (st.get('face', 2.0) if f['target'] == 'face' else st.get('center', 1.3)))
    elif kind == 'shake': f['amp'] = float(e.get('force', 14))
    elif kind == 'tint': f['mode'] = TINTS.get(str(e.get('mode', 'nb')).lower(), 'bw')
    elif kind == 'sfx':
        name = e.get('nom')
        if name not in _lib()['sfx']: raise ToolError(f"son inconnu « {name} » (outil bibliotheque)")
        f['name'] = name; f['db'] = float(e.get('volume_db', 0))
    elif kind == 'text':
        f['text'] = e.get('texte', ''); f['dur'] = float(e.get('duree', 1.4)); f['style'] = TEXTS.get(e.get('style', 'gros'), 'big')
    elif kind == 'speed': f['rate'] = float(e.get('facteur', 1.5))
    return f


def ajouter_effets(ctx, args):
    i, clip = ctx.item(args['element'])
    if clip['type'] != 'clip': raise ToolError('les effets se posent sur un plan')
    added, errors = [], []
    for e in args.get('effets', []):
        try:
            f = _fx(ctx, clip, e); clip['fx'].append(f); added.append(f"{f['id']}:{f['kind']}")
        except ToolError as err:
            errors.append(str(err))
    clip['fx'].sort(key=lambda f: f.get('t', f.get('t0', 0)))
    if added: ctx.changed()
    return f"{len(added)} effet(s) ajouté(s) sur [{clip['id']}] : {', '.join(added)}" + (f"\nERREURS : {' | '.join(errors)}" if errors else '')


def supprimer_effets(ctx, args):
    i, clip = ctx.item(args['element'])
    ids, kinds = set(args.get('ids') or []), {FX_KINDS.get(k, k) for k in (args.get('types') or [])}
    before = len(clip.get('fx', []))
    clip['fx'] = [f for f in clip.get('fx', []) if f['id'] not in ids and f['kind'] not in kinds]
    ctx.changed()
    return f'{before - len(clip["fx"])} effet(s) supprimé(s)'


STYLES = {'normal': 'normal', 'hype': 'hype', 'cri': 'shout', 'shout': 'shout'}


def _speaker_id(ctx, name):
    if not name: return None
    low = str(name).lower()
    for sp in store.list_speakers():
        if low in (sp['id'].lower(), sp['name'].lower(), *[a.lower() for a in sp.get('aliases', [])]):
            return None if sp['id'] == ctx.p.get('defaultSpeaker') else sp['id']
    raise ToolError(f"personne inconnue « {name} » (voir la liste des personnes dans tes instructions)")


def ecrire_sous_titres(ctx, args):
    i, clip = ctx.item(args['element'])
    if clip['type'] != 'clip': raise ToolError('les sous-titres se posent sur un plan')
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
    return f"{len(caps)} sous-titre(s) écrits sur [{clip['id']}]"


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
    return f'{n} sous-titre(s) modifié(s)'


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
         'cadrage_horizontal': 'cropX', 'silence_max': 'gap', 'fondu_entree': 'fadeIn', 'fondu_sortie': 'fadeOut', 'sons_auto': 'autoSfx'}
    for k, v in ch.items():
        key = m.get(k, k)
        if key == 'sons' and it['type'] == 'card':
            lib = _lib()
            out = []
            for so in v or []:
                nm = so.get('nom') or so.get('name')
                if nm not in lib['sfx']: raise ToolError(f"son inconnu « {nm} » (outil bibliotheque type=sons)")
                out.append({'id': store.new_id('s'), 'name': nm, 'at': float(so.get('decalage', 0)), 'db': float(so.get('db', 0))})
            it['sounds'] = out
            continue
        if key == 'autoSfx': it['autoSfx'] = bool(v); continue
        if key == 'cible': it['target'] = _target(v); continue
        if key in ('in', 'out', 'speed', 'dur', 't', 'scale', 'volumeDb', 'cropX', 'gap', 'fadeIn', 'fadeOut'): v = _num(v, k)
        if key == 'cropX': v = max(0.0, min(1.0, v))
        it[key] = v
    if it['type'] == 'clip':
        s = ctx.src(it['src'])
        it['in'] = max(0.0, it['in']); it['out'] = min(float(s['duration']), it['out'])
        if it['out'] - it['in'] < 0.2: raise ToolError('plan trop court')
        if args.get('regenerer_sous_titres') or 'debut' in ch or 'fin' in ch:
            if args.get('regenerer_sous_titres', True):
                it['captions'] = analyse.make_captions(ctx.words(it['src']), it['in'], it['out'], ctx.style(), ctx.p.get('glossary'),
                                                       ctx.p.get('defaultSpeaker'))
    ctx.changed()
    return f"[{it['id']}] modifié"


def supprimer_element(ctx, args):
    ids = set(args.get('elements') or [])
    before = len(ctx.p['timeline'])
    ctx.p['timeline'] = [it for it in ctx.p['timeline'] if it['id'] not in ids]
    left = {it['id'] for it in ctx.p['timeline']}
    ctx.p['music'] = [m for m in ctx.p.get('music', []) if m['fromItem'] in left and m['toItem'] in left]
    ctx.changed()
    return f'{before - len(ctx.p["timeline"])} élément(s) supprimé(s)'


def deplacer_element(ctx, args):
    i, it = ctx.item(args['element'])
    tl = ctx.p['timeline']; tl.pop(i)
    _insert(ctx, it, args)
    ctx.changed()
    return f"[{it['id']}] déplacé en position {tl.index(it)}"


def vider_timeline(ctx, args):
    ctx.p['timeline'] = []; ctx.p['music'] = []
    ctx.changed()
    return 'timeline vidée'


def musique(ctx, args):
    if args.get('action') == 'supprimer':
        ctx.p['music'] = [m for m in ctx.p.get('music', []) if m['id'] != args.get('id')]
        ctx.changed(); return 'musique supprimée'
    _lib()
    t = library.music_by_name(args.get('nom', ''))
    if not t: raise ToolError(f"musique inconnue « {args.get('nom')} » (outil bibliotheque type=musique)")
    ctx.item(args['de_element']); ctx.item(args['a_element'])
    db = float(args.get('volume_db', ctx.style().get('music', {}).get('db', -15)))
    cue = {'id': store.new_id('m'), 'name': t['name'], 'url': t['url'], 'gainDb': t['gainDb'], 'db': db,
           'fromItem': args['de_element'], 'toItem': args['a_element'], 'offset': float(args.get('debut_morceau', 0))}
    ctx.p.setdefault('music', []).append(cue)
    ctx.changed()
    return f"musique [{cue['id']}] « {t['name']} » posée"


def definir_titre(ctx, args):
    ctx.p['title'] = args['titre'].strip()
    ctx.changed()
    return 'titre enregistré'


def item_start(ctx, iid):
    t = 0.0
    for it in ctx.p['timeline']:
        if it['id'] == iid: return t
        t += item_duration(ctx, it)
    raise ToolError(f'élément inconnu « {iid} »')


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
    _track(ctx, 'text', 'Textes')['clips'].append(clip)
    ctx.changed()
    return f"texte [{clip['id']}] à {start:.1f} s (temps de la vidéo montée)"


def ajouter_incrustation(ctx, args):
    path = args['chemin']
    if not os.path.exists(path): raise ToolError(f'fichier introuvable : {path} (outil bibliotheque type=vfx)')
    info = probe(path)
    start = item_start(ctx, args['element']) + float(args.get('decalage', 0)) if args.get('element') else float(args.get('debut_sortie', 0))
    dur = float(args.get('duree') or (info['duration'] if info['kind'] == 'video' else 2.0))
    look = {'scale': float(args.get('echelle', 1)), 'x': float(args.get('x', 0)), 'y': float(args.get('y', 0))}
    if args.get('fond_vert'): look['chroma'] = '#00ff00'
    clip = {'id': store.new_id('o'), 'type': 'video', 'kind': 'image' if info['kind'] == 'image' else 'video', 'path': path,
            'url': file_url(path), 'in': 0, 'start': round(start, 3), 'dur': round(dur, 3), 'look': look,
            'volumeDb': float(args.get('volume_db', 0)), 'fadeIn': 0.1, 'fadeOut': 0.15}
    _track(ctx, 'video', 'Incrustations')['clips'].append(clip)
    ctx.changed()
    return f"incrustation [{clip['id']}] {os.path.basename(path)} à {start:.1f} s pendant {dur:.1f} s"


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
    return f'étalonnage appliqué sur {n} élément(s)'


def transition(ctx, args):
    i, it = ctx.item(args['element'])
    kind = args.get('type', 'fade')
    if kind == 'aucune': it['transition'] = None
    else:
        if kind not in ('fade', 'flash', 'zoom', 'whip', 'glitch', 'blur'): raise ToolError('type : fade, flash, zoom, whip, glitch, blur ou aucune')
        it['transition'] = {'kind': kind, 'dur': float(args.get('duree', 0.35))}
    ctx.changed()
    return f"transition « {kind} » à l'entrée de [{it['id']}]"


def regler_image(ctx, args):
    i, it = ctx.item(args['element'])
    look = it.setdefault('look', {})
    for k_in, k in (('x', 'x'), ('y', 'y'), ('echelle', 'scale'), ('rotation', 'rotation'), ('opacite', 'opacity'), ('fusion', 'blend')):
        if args.get(k_in) is not None: look[k] = args[k_in]
    if args.get('miroir') is not None: look['flipH'] = bool(args['miroir'])
    ctx.changed()
    return f"image de [{it['id']}] réglée"


def noter_preference(ctx, args):
    txt = args['texte'].strip()
    portee = args.get('portee', 'projet')
    if portee == 'pack':
        pk = store.get_pack(ctx.p['packId'])
        if '## Retours appris' not in pk.get('rules', ''): pk['rules'] = pk.get('rules', '') + '\n\n## Retours appris'
        pk['rules'] += f'\n- {txt}'
        store.save_pack(pk); ctx.pack = pk
        return f"règle ajoutée au pack « {pk['name']} »"
    if portee == 'personne':
        sid = _speaker_id(ctx, args.get('personne')) or ctx.p.get('defaultSpeaker')
        sp = store.get_speaker(sid)
        if not sp: raise ToolError('personne inconnue')
        sp['preferences'] = (sp.get('preferences', '') + '\n- ' + txt).strip()
        store.save_speaker(sp)
        return f"préférence ajoutée à {sp['name']}"
    ctx.p['preferences'] = (ctx.p.get('preferences', '') + '\n- ' + txt).strip()
    ctx.changed()
    return 'préférence ajoutée au projet'


# ------------------------------------------------------------------ registre
S = lambda props, req=(): {'type': 'object', 'properties': props, 'required': list(req)}
NUM = {'type': 'number'}
STR = {'type': 'string'}
POS = {'apres': {'type': 'string', 'description': "id de l'élément après lequel insérer"},
       'avant': {'type': 'string', 'description': "id de l'élément avant lequel insérer"},
       'position': {'type': 'integer', 'description': 'index (0 = début). Sans apres/avant/position : à la fin'}}


# ------------------------------------------------------------------ pistes libres, mixage, format, marqueurs, export
def _clip(ctx, cid):
    for tr in ctx.p.get('tracks', []):
        for c in tr['clips']:
            if c['id'] == cid: return tr, c
    raise ToolError(f'clip de piste inconnu « {cid} » (etat_projet liste les pistes et leurs clips)')


def modifier_clip_piste(ctx, args):
    tr, c = _clip(ctx, args['clip'])
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
        elif k in ('fondu_entree', 'fondu_sortie'): c['fadeIn' if k == 'fondu_entree' else 'fadeOut'] = max(0.0, float(v))
        elif k in ('echelle', 'pos_x', 'pos_y', 'opacite', 'rotation') and c['type'] == 'video':
            look = c.setdefault('look', {})
            look[{'echelle': 'scale', 'pos_x': 'x', 'pos_y': 'y', 'opacite': 'opacity', 'rotation': 'rotation'}[k]] = float(v)
        elif k == 'piste':
            dst = next((t for t in ctx.p.get('tracks', []) if t['id'] == v or t['name'] == v), None)
            if not dst or dst['kind'] != tr['kind']: raise ToolError('piste de destination inconnue ou d\'un autre type')
            tr['clips'].remove(c); dst['clips'].append(c)
        else: raise ToolError(f'champ « {k} » non modifiable sur un clip {c["type"]}')
        done.append(k)
    ctx.changed()
    return f"clip [{c['id']}] modifié : {', '.join(done)}"


def supprimer_clips_piste(ctx, args):
    ids = set(args['clips'])
    n = 0
    for tr in ctx.p.get('tracks', []):
        before = len(tr['clips'])
        tr['clips'] = [c for c in tr['clips'] if c['id'] not in ids]
        n += before - len(tr['clips'])
    if args.get('supprimer_pistes_vides'): ctx.p['tracks'] = [t for t in ctx.p.get('tracks', []) if t['clips']]
    ctx.changed()
    return f'{n} clip(s) supprimé(s)'


def mixage(ctx, args):
    mix = ctx.p.setdefault('mix', {})
    done = []
    for k_in, k in (('voix_db', 'voiceDb'), ('musique_db', 'musicDb'), ('bruitages_db', 'sfxDb')):
        if args.get(k_in) is not None: mix[k] = max(-40.0, min(12.0, float(args[k_in]))); done.append(k_in)
    for k_in, k in (('couper_voix', 'voiceMuted'), ('couper_musique', 'musicMuted'), ('couper_bruitages', 'sfxMuted'), ('masquer_sous_titres', 'captionsHidden')):
        if args.get(k_in) is not None: mix[k] = bool(args[k_in]); done.append(k_in)
    for pt in args.get('pistes') or []:
        tr = next((t for t in ctx.p.get('tracks', []) if t['id'] == pt.get('piste') or t['name'] == pt.get('piste')), None)
        if not tr: raise ToolError(f"piste inconnue « {pt.get('piste')} »")
        if pt.get('volume_db') is not None: tr['volumeDb'] = float(pt['volume_db'])
        if pt.get('muet') is not None: tr['muted'] = bool(pt['muet'])
        if pt.get('masquee') is not None: tr['hidden'] = bool(pt['masquee'])
        done.append(tr['name'])
    ctx.changed()
    return f"mixage réglé : {', '.join(done) or 'rien'}"


FORMATS = {'16:9': (1920, 1080), '9:16': (1080, 1920), '1:1': (1080, 1080), '4:5': (1080, 1350), '4k': (3840, 2160)}


def format_projet(ctx, args):
    f = ctx.p['format']
    if args.get('format'):
        if args['format'] not in FORMATS: raise ToolError(f"format inconnu ({', '.join(FORMATS)})")
        f['width'], f['height'] = FORMATS[args['format']]
    if args.get('ips'): f['fps'] = int(args['ips'])
    ctx.changed()
    return f"format : {f['width']}×{f['height']} à {f['fps']} i/s" + (" (vertical : règle le recadrage horizontal des plans avec modifier_element si le sujet n'est pas au centre)" if f['height'] > f['width'] else '')


def marqueurs(ctx, args):
    ms = ctx.p.setdefault('markers', [])
    if args.get('action') == 'supprimer':
        ids = set(args.get('ids') or [])
        ctx.p['markers'] = [m for m in ms if m['id'] not in ids] if ids else []
        ctx.changed()
        return 'marqueurs supprimés'
    if args.get('action') == 'ajouter':
        m = {'id': store.new_id('k'), 't': round(float(args['temps_sortie']), 3), 'label': args.get('texte', '')}
        ms.append(m)
        ctx.changed()
        return f"marqueur [{m['id']}] à {m['t']:.1f} s"
    return json.dumps(ms, ensure_ascii=False) or '[]'


def exporter(ctx, args):
    from .. import jobs, render as R
    preset = args.get('preset') or 'web'
    if preset not in R.PRESETS: raise ToolError(f"préréglage inconnu ({', '.join(R.PRESETS)})")
    if not ctx.p['timeline']: raise ToolError('timeline vide')
    store.save_project(ctx.p)
    pid = ctx.p['id']
    job = jobs.submit('render', lambda job: R.render(store.get_project(pid), job, preset), pid, f"rendu — {ctx.p.get('title') or ctx.p['name']}")
    return f"export lancé ({R.PRESETS[preset]['label']}) : la personne suit la progression dans l'espace Export"


# ------------------------------------------------------------------ effets d'image (mêmes types que web/src/remotion/effects.tsx)
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
    if t['type'] in ('card', 'text', 'audio'): raise ToolError("cet élément ne prend pas d'effets d'image")
    look = t.setdefault('look', {})
    fx = look.setdefault('effects', [])
    if args.get('vider'): fx.clear()
    rm = set(args.get('retirer') or [])
    if rm: fx[:] = [e for e in fx if e['id'] not in rm and e['kind'] not in rm]
    added = []
    for e in args.get('ajouter') or []:
        kind = e.get('type')
        if kind not in VFX: raise ToolError(f"effet inconnu « {kind} » ({', '.join(VFX)})")
        p = dict(VFX[kind])
        for k, v in e.items():
            if k in p: p[k] = v
        item = {'id': store.new_id('x'), 'kind': kind, 'on': True, 'p': p}
        fx.append(item); added.append(f"{kind} [{item['id']}]")
    ctx.changed()
    return f"effets : {', '.join(added) or 'aucun ajouté'} ; en place : {', '.join(e['kind'] for e in fx) or 'aucun'}"


def analyser_video(ctx, args):
    """ouvre une vidéo de référence (lien, fichier ou source du projet) : images, plans, paroles, sons et musiques reconnus"""
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
    ('etat_projet', "Résumé du projet : sources (durée, transcription), éléments de la timeline avec leurs ids, durée montée estimée, musiques. À appeler en premier.",
     S({}), etat_projet, False),
    ('lire_transcription', "Transcription mot à mot d'une plage d'une source (20 min max par appel), avec temps en secondes source et « nom: » quand ce n'est pas la personne principale qui parle.",
     S({'source': STR, 'debut': NUM, 'fin': NUM}, ['source', 'debut', 'fin']), lire_transcription, False),
    ('chercher_texte', "Cherche une phrase dans les transcriptions (sans accents ni ponctuation) et donne les temps.",
     S({'texte': STR, 'source': STR}, ['texte']), chercher_texte, False),
    ('moments_forts', "Moments forts d'une source longue (cris, pics de voix, gros mots, mots de hype) avec extrait : à utiliser sur une VOD pour ne pas tout lire.",
     S({'source': STR, 'nombre': {'type': 'integer'}}, ['source']), moments_forts, False),
    ('bibliotheque', "Bibliothèque de l'utilisateur : type=sfx (sons nommés puis fichiers « f:… »), type=musique (filtrable par ambiance : « action », « colère », « Funny, Quirky »…), type=vfx (visuels / overlays). « recherche » filtre par mot.",
     S({'type': {'type': 'string', 'enum': ['sfx', 'musique', 'vfx']}, 'ambiance': STR, 'recherche': STR, 'nombre': {'type': 'integer'}}, ['type']), bibliotheque, False),
    ('regarder', "Regarde une image d'une source à un instant (secondes source) : pour vérifier ce qui se passe à l'écran, le cadrage, où est le visage ou le sujet (coordonnées 0-1 pour les zooms).",
     S({'source': STR, 'temps': NUM}, ['source', 'temps']), regarder, False),
    ('regarder_montage', "Regarde la vidéo montée à un instant (secondes de sortie) : image du plan + sous-titre et effets posés à ce moment. Pour vérifier ton travail.",
     S({'temps': NUM}, ['temps']), regarder_montage, False),
    ('regler_style', "Réglages de rendu de CE projet (par-dessus le style) : police, taille_sous_titres, couleur_sous_titres (#hex), contour, fond_sous_titres, majuscules, mot_a_mot, marge_bas, silence_max, couper_silences, vitesse_base, musique_db, baisse_musique_db, bruitages_db, censure, zoom_visage, zoom_centre, visage ([x, y] 0-1).",
     S({'reglages': {'type': 'object'}}, ['reglages']), regler_style, True),
    ('lire_element', "JSON complet d'un élément (plan avec ses sous-titres et effets, carton…).",
     S({'element': STR}, ['element']), lire_element, False),
    ('definir_titre', "Enregistre le titre de la vidéo (fil rouge du montage et de la miniature).",
     S({'titre': STR}, ['titre']), definir_titre, True),
    ('ajouter_plan', "Ajoute un plan (extrait d'une source, temps en secondes source). Les silences sont coupés automatiquement (coupes_silences=false pour garder un échange entier). Les sous-titres sont générés depuis la transcription (sous_titres='aucun' pour ne pas en mettre) : relis-les dans la réponse et corrige avec modifier_sous_titres si besoin.",
     S({'source': STR, 'debut': NUM, 'fin': NUM, 'titre_chapitre': {'type': 'string', 'description': 'nom de chapitre YouTube sur le premier plan d\'une partie'},
        'coupes_silences': {'type': 'boolean'}, 'sous_titres': {'type': 'string', 'enum': ['auto', 'aucun']}, **POS},
       ['source', 'debut', 'fin']), ajouter_plan, True),
    ('ajouter_carton', "Ajoute un carton plein écran (texte sur fond uni) : title (gros titre, avec bandeau de couleur), chapter (titre de partie), narr (texte de narration). Pour une image ou une vidéo en plein écran (logo, photo…), utilise ajouter_media.",
     S({'style': {'type': 'string', 'enum': ['title', 'chapter', 'narr']}, 'texte': STR, 'sous_texte': STR, 'duree': NUM,
        'fond': {'type': 'string', 'description': 'couleur de fond #rrggbb (noir par défaut)'}, 'couleur': {'type': 'string', 'description': 'couleur du texte #rrggbb (blanc par défaut)'},
        'bandeau': {'type': 'string', 'description': "title : couleur du bandeau #rrggbb, '' pour aucun"}, **POS}, ['style', 'texte']), ajouter_carton, True),
    ('ajouter_arret_image', "Arrêt sur image avec zoom (moment fort), avec un son de la bibliothèque si on en donne un.",
     S({'source': STR, 'temps': NUM, 'duree': NUM, 'cible': {'description': "'visage', 'centre' ou [x, y] entre 0 et 1"},
        'echelle': NUM, 'son': STR, **POS}, ['source', 'temps']), ajouter_arret_image, True),
    ('ajouter_media', "Ajoute une vidéo ou une image (logo, photo, affiche…) en plein écran : chemin = id d'une source du projet ou chemin d'un fichier (bibliothèque).",
     S({'chemin': STR, 'duree': NUM, 'fond_vert': {'type': 'boolean'}, **POS}, ['chemin']), ajouter_media, True),
    ('ajouter_effets', "Ajoute des effets sur un plan (temps en secondes SOURCE, dans le plan). type : zoom {debut, fin, cible: 'visage'|'centre'|[x,y], echelle} (zoom sec), secousse {debut, fin, force}, teinte {debut, fin, mode: nb|flash}, son {temps, nom, volume_db}, texte {temps, duree, texte, style: gros|note}, coupe {debut, fin} (enlève un passage), garder {debut, fin} (garde un silence), vitesse {debut, fin, facteur}, censure {debut, fin} (bip forcé).",
     S({'element': STR, 'effets': {'type': 'array', 'items': {'type': 'object', 'properties': {'type': {'type': 'string', 'enum': list(FX_KINDS)}}, 'required': ['type']}}},
       ['element', 'effets']), ajouter_effets, True),
    ('supprimer_effets', "Supprime des effets d'un plan, par ids et/ou par types (ex. types=['son']).",
     S({'element': STR, 'ids': {'type': 'array', 'items': STR}, 'types': {'type': 'array', 'items': STR}}, ['element']), supprimer_effets, True),
    ('ecrire_sous_titres', "Remplace (ou complète avec remplacer=false) les sous-titres d'un plan. Chaque sous-titre : {debut, fin, texte, personne (id, absent = personne principale), style: normal|hype|cri}. Groupes de sens de 2-6 mots, jamais avant la parole.",
     S({'element': STR, 'remplacer': {'type': 'boolean'}, 'sous_titres': {'type': 'array', 'items': {'type': 'object', 'properties': {
         'debut': NUM, 'fin': NUM, 'texte': STR, 'personne': STR, 'style': {'type': 'string', 'enum': ['normal', 'hype', 'cri']}}, 'required': ['debut', 'texte']}}},
       ['element', 'sous_titres']), ecrire_sous_titres, True),
    ('modifier_sous_titres', "Corrige des sous-titres existants par id : {id, texte?, personne?, style?, debut?, fin?, supprimer?}.",
     S({'element': STR, 'modifications': {'type': 'array', 'items': {'type': 'object', 'properties': {
         'id': STR, 'texte': STR, 'personne': STR, 'style': STR, 'debut': NUM, 'fin': NUM, 'supprimer': {'type': 'boolean'}}, 'required': ['id']}}},
       ['element', 'modifications']), modifier_sous_titres, True),
    ('generer_sous_titres', "Regénère les sous-titres d'un plan depuis la transcription.",
     S({'element': STR}, ['element']), generer_sous_titres, True),
    ('modifier_element', "Modifie un élément : champs parmi debut, fin, titre_chapitre, coupes_silences, silence_max (s), vitesse, volume_db, fondu_entree, fondu_sortie, cadrage_horizontal (0 gauche … 1 droite, en vertical) (plan) ; texte, sous_texte, duree, style, sons_auto (false = coupe les sons automatiques du carton), sons=[{nom, decalage (s depuis le début du carton), db}] (remplace les sons posés sur le carton) (carton) ; temps, duree, cible, echelle, son (arrêt sur image).",
     S({'element': STR, 'champs': {'type': 'object'}, 'regenerer_sous_titres': {'type': 'boolean'}}, ['element', 'champs']), modifier_element, True),
    ('supprimer_element', "Supprime des éléments de la timeline.",
     S({'elements': {'type': 'array', 'items': STR}}, ['elements']), supprimer_element, True),
    ('deplacer_element', "Déplace un élément (apres / avant / position).",
     S({'element': STR, **POS}, ['element']), deplacer_element, True),
    ('vider_timeline', "Vide toute la timeline (pour remonter de zéro).", S({}), vider_timeline, True),
    ('musique', "Musique de fond : action=ajouter {nom, de_element, a_element, volume_db, debut_morceau} joue en continu du début de de_element à la fin de a_element (baisse auto sous la voix) ; action=supprimer {id}.",
     S({'action': {'type': 'string', 'enum': ['ajouter', 'supprimer']}, 'nom': STR, 'de_element': STR, 'a_element': STR, 'volume_db': NUM,
        'debut_morceau': NUM, 'id': STR}, ['action']), musique, True),
    ('ajouter_texte', "Texte libre à l'écran (titre, encadré, bandeau…) sur une piste Texte, placé au début d'un élément + decalage (s de vidéo montée). style : titre, sous-titre, encadre, bandeau, note.",
     S({'texte': STR, 'element': STR, 'decalage': NUM, 'debut_sortie': NUM, 'duree': NUM, 'style': {'type': 'string', 'enum': list(TEXT_PRESETS)},
        'x': NUM, 'y': NUM, 'taille': NUM, 'couleur': STR, 'animation': {'type': 'string', 'enum': ['pop', 'fade', 'slide', 'type', 'none']}}, ['texte']), ajouter_texte, True),
    ('ajouter_incrustation', "Incruste une vidéo / image par-dessus le montage (meme GTA, confettis… : bibliotheque type=vfx), fond_vert=true pour retirer le vert. Placée au début d'un élément + decalage.",
     S({'chemin': STR, 'element': STR, 'decalage': NUM, 'debut_sortie': NUM, 'duree': NUM, 'fond_vert': {'type': 'boolean'}, 'echelle': NUM,
        'x': NUM, 'y': NUM, 'volume_db': NUM}, ['chemin']), ajouter_incrustation, True),
    ('etalonnage', "Couleur d'éléments (tous si elements absent) : preset parmi none, film, vif, doux, nb, chaud, froid, vintage, nuit, punch, et/ou réglages -100..100 (exposure, contrast, saturation, temperature, tint, highlights, shadows) et vignette 0..100.",
     S({'elements': {'type': 'array', 'items': STR}, 'preset': STR, 'exposure': NUM, 'contrast': NUM, 'saturation': NUM, 'temperature': NUM,
        'tint': NUM, 'highlights': NUM, 'shadows': NUM, 'vignette': NUM, 'remplacer': {'type': 'boolean'}}), etalonnage, True),
    ('transition', "Transition d'entrée d'un élément : fade, flash, zoom, whip, glitch, blur ou aucune (avec son auto).",
     S({'element': STR, 'type': STR, 'duree': NUM}, ['element', 'type']), transition, True),
    ('regler_image', "Transform d'un élément : x / y (décalage en %), echelle (1 = 100 %), rotation (°), opacite (0-1), fusion (mode CSS), miroir.",
     S({'element': STR, 'x': NUM, 'y': NUM, 'echelle': NUM, 'rotation': NUM, 'opacite': NUM, 'fusion': STR, 'miroir': {'type': 'boolean'}}, ['element']), regler_image, True),
    ('modifier_clip_piste', "Modifie un clip d'une piste libre (texte, incrustation, audio) par son id : champs parmi debut_sortie, duree, depart_fichier, texte, x, y, taille, couleur, animation (texte), volume_db, muet, baisser_sous_voix, fondu_entree, fondu_sortie, echelle, pos_x, pos_y, opacite, rotation (incrustation), piste (id ou nom d'une piste du même type).",
     S({'clip': STR, 'champs': {'type': 'object'}}, ['clip', 'champs']), modifier_clip_piste, True),
    ('supprimer_clips_piste', "Supprime des clips de pistes libres (textes, incrustations, audio) par id.",
     S({'clips': {'type': 'array', 'items': STR}, 'supprimer_pistes_vides': {'type': 'boolean'}}, ['clips']), supprimer_clips_piste, True),
    ('mixage', "Niveaux du projet : voix_db, musique_db, bruitages_db (-40..12, 0 = niveau du style), couper_voix / couper_musique / couper_bruitages, masquer_sous_titres, et par piste libre : pistes=[{piste, volume_db, muet, masquee}].",
     S({'voix_db': NUM, 'musique_db': NUM, 'bruitages_db': NUM, 'couper_voix': {'type': 'boolean'}, 'couper_musique': {'type': 'boolean'},
        'couper_bruitages': {'type': 'boolean'}, 'masquer_sous_titres': {'type': 'boolean'},
        'pistes': {'type': 'array', 'items': {'type': 'object'}}}), mixage, True),
    ('format_projet', "Change le format de la vidéo : 16:9, 9:16 (vertical), 1:1, 4:5, 4k ; ips = images par seconde.",
     S({'format': {'type': 'string', 'enum': list(FORMATS)}, 'ips': {'type': 'integer'}}), format_projet, True),
    ('marqueurs', "Marqueurs de la timeline (repères pour la personne) : action=lister, ajouter (temps_sortie, texte) ou supprimer (ids ; sans ids : tous).",
     S({'action': {'type': 'string', 'enum': ['lister', 'ajouter', 'supprimer']}, 'temps_sortie': NUM, 'texte': STR, 'ids': {'type': 'array', 'items': STR}}, ['action']), marqueurs, True),
    ('exporter', "Lance l'export de la vidéo (seulement si on te le demande) : preset web (H.264), 4k, hevc, prores, draft (brouillon ½), audio (WAV).",
     S({'preset': {'type': 'string', 'enum': ['web', '4k', 'hevc', 'prores', 'draft', 'audio']}}), exporter, True),
    ('effets_image', "Effets d'image empilés sur un plan / média (element) ou un clip vidéo de piste (clip) : ajouter=[{type, paramètres}], retirer=[ids ou types], vider. Types et paramètres (valeurs par défaut) : motion (Ken Burns / animation début→fin : scale0, scale1 en %, x0, x1, y0, y1 en % du cadre, rot0, rot1, ease douce|lineaire|entree|sortie), fade (in, out en s, color noir|blanc|transparent), mirror (axis h|v), blur (amount px), sharpen (amount 0-100), pixelate (size px), glow (amount, radius), grain (amount, size), rgbsplit (amount px), bw/sepia/invert (amount %), hue (deg), letterbox (ratio 2.39|2.0|1.85|1.33|1, color), rounded (radius %), border (width px, color), shadow (amount %, size, y). Utilise-les avec goût : un effet doit servir le propos.",
     S({'element': STR, 'clip': STR, 'ajouter': {'type': 'array', 'items': {'type': 'object'}}, 'retirer': {'type': 'array', 'items': STR}, 'vider': {'type': 'boolean'}}), effets_image, True),
    ('analyser_video', "Ouvre une vidéo de référence ou d'exemple : lien YouTube / Twitch / autre, chemin de fichier, ou id d'une source du projet. Sur l'extrait [debut, fin] (s, 5 min max, 90 s par défaut ; vise la partie utile, ex. l'intro) : images clés (tu les vois), changements de plan, paroles, niveau sonore, et surtout les SONS et MUSIQUES DE LA BIBLIOTHÈQUE reconnus avec leurs instants (nom à réutiliser tel quel dans tes outils) et la position dans le morceau. À utiliser dès qu'on te donne une vidéo en exemple ou qu'on te demande de « faire comme dans » une vidéo.",
     S({'video': STR, 'debut': NUM, 'fin': NUM, 'images': {'type': 'integer'}, 'sons': {'type': 'boolean'}}, ['video']), analyser_video, False),
    ('noter_preference', "Retient une préférence pour la suite : portee=projet (ce projet), pack (toutes les vidéos de ce pack : seulement si on te demande de retenir une règle générale), personne (préférence liée à une personne).",
     S({'portee': {'type': 'string', 'enum': ['projet', 'pack', 'personne']}, 'texte': STR, 'personne': STR}, ['texte']), noter_preference, False),
]

BY_NAME = {t[0]: t for t in TOOLS}
LABELS = {
    'etat_projet': '📋 lit le projet', 'lire_transcription': '📖 lit la transcription', 'chercher_texte': '🔎 cherche',
    'moments_forts': '⚡ repère les moments forts', 'bibliotheque': '🎵 parcourt la banque', 'lire_element': '🔍 regarde un élément',
    'definir_titre': '🏷️ titre', 'ajouter_plan': '🎬 ajoute un plan', 'ajouter_carton': '🪧 ajoute un carton',
    'ajouter_arret_image': '⏸️ arrêt sur image', 'ajouter_media': '🎞️ ajoute un média', 'ajouter_effets': '✨ ajoute des effets',
    'supprimer_effets': '🧹 enlève des effets', 'ecrire_sous_titres': '💬 écrit des sous-titres', 'modifier_sous_titres': '✏️ corrige des sous-titres',
    'generer_sous_titres': '💬 regénère des sous-titres', 'modifier_element': '✏️ modifie un élément', 'supprimer_element': '🗑️ supprime',
    'deplacer_element': '↕️ déplace', 'vider_timeline': '🧨 vide la timeline', 'ajouter_texte': '🔤 ajoute un texte',
    'ajouter_incrustation': '🖼️ incruste', 'etalonnage': '🎨 étalonne', 'transition': '🔀 transition', 'regler_image': '📐 règle l’image',
    'modifier_clip_piste': '✏️ modifie un clip', 'supprimer_clips_piste': '🗑️ supprime des clips', 'mixage': '🎚️ mixage', 'analyser_video': '🔎 analyse une vidéo', 'effets_image': '✨ effets d’image', 'format_projet': '📐 format', 'marqueurs': '📍 marqueurs', 'exporter': '📤 exporte',
    'regarder': '👁 regarde', 'regarder_montage': '👁 regarde le montage', 'regler_style': '🎛 règle le style', 'musique': '🎶 musique', 'noter_preference': '🧠 retient une préférence',
}


def schemas():
    return [{'name': n, 'description': d, 'input_schema': s} for n, d, s, _, _ in TOOLS]


def validate(name, args):
    if name not in BY_NAME: raise ToolError(f'outil inconnu {name}')
    if not isinstance(args, dict): raise ToolError('arguments invalides (objet JSON attendu)')
    schema = BY_NAME[name][2]
    missing = [k for k in schema.get('required', []) if k not in args]
    if missing: raise ToolError(f"arguments manquants : {', '.join(missing)}")


def run(ctx, name, args):
    """exécute un outil -> (texte du résultat, erreur ?, images jpeg)"""
    try:
        validate(name, args)
        out = BY_NAME[name][3](ctx, args)
        if isinstance(out, dict): return str(out.get('text', '')), False, out.get('images', [])
        return str(out), False, []
    except ToolError as e:
        return f'ERREUR : {e}', True, []
    except (KeyError, ValueError, TypeError) as e:
        return f'ERREUR : {type(e).__name__} {e}', True, []


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
