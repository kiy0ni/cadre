"""Importe un projet de l'ancien moteur kiyoni-studio (projects/<nom> : timeline.py + captions.py) dans Cadre.

    ./kiyoni importer mario-kart-world [--vod /chemin/vers/vod.mp4]      (depuis ~/Dev/perso/kiyoni-studio)

À lancer depuis un terminal (l'import lit timeline.py, qui charge le moteur et donc la banque de sons dans iCloud).
Dossier de kiyoni-studio : --studio, ou variable CADRE_KIYONI_STUDIO, sinon ~/Dev/perso/kiyoni-studio.
Convertit : plans (+ coupes, vitesse, cadrages alternés, effets, sous-titres écrits à la main calés sur les mots),
arrêts sur image, cartons, musiques (Bed), incrustations (OVERLAY), RIP / gros textes, outro."""
import os, re, sys, json, shutil, argparse, unicodedata
from .. import store, analyse
from ..media import probe, file_url
from ..ai import tools as T

STUDIO = os.environ.get('CADRE_KIYONI_STUDIO') or os.path.expanduser('~/Dev/perso/kiyoni-studio')

W, H = 1920, 1080


def norm_target(where):
    if isinstance(where, (tuple, list)) and len(where) == 2: return [round(where[0] / W, 4), round(where[1] / H, 4)]
    if where in ('center', 'centre'): return 'center'
    return 'face'


def _tok(t):
    t = unicodedata.normalize('NFD', t.lower())
    t = ''.join(c for c in t if unicodedata.category(c) != 'Mn')
    return re.sub(r"[^a-z0-9*']", '', t)


def _match(a, b):
    """mot écrit (peut contenir * de censure) ~ mot transcrit"""
    if not a or not b: return False
    if '*' in a: return re.fullmatch(a.replace('*', '.').replace("'", "'?"), b) is not None
    return a == b or (len(a) > 3 and (b.startswith(a) or a.startswith(b)))


def align_say(say, words, a, b, default_speaker, aliases):
    """« groupe / groupe / … » -> sous-titres calés sur les mots de la transcription (même principe que le moteur)."""
    ws = [w for w in words if w[1] > a and w[0] < b]
    toks = [_tok(w[2]) for w in ws]
    groups = [g.strip() for g in say.split('/') if g.strip()]
    caps, cur, last_end = [], 0, a
    for g in groups:
        speaker = None
        m = re.match(r'^([a-z_]+):\s*(.*)$', g)
        if m and m.group(1) in aliases:
            speaker, g = aliases[m.group(1)], m.group(2)
        style = 'normal'
        if g.startswith('!'): g, style = g[1:].strip(), 'hype'
        letters = [c for c in g if c.isalpha()]
        if letters and all(c == c.upper() for c in letters) and len(letters) > 2: style = 'shout'
        gt = [_tok(x) for x in re.split(r"[\s,.!?;:…]+", g) if _tok(x)]
        start = None
        for i in range(cur, min(len(toks), cur + 40)):
            if gt and (_match(gt[0], toks[i]) or (len(gt) > 1 and _match(gt[1], toks[i]))):
                start = i; break
        if start is None:
            t0 = min(b - 0.3, last_end + 0.05); t1 = min(b, t0 + 0.32 * max(1, len(gt)))
        else:
            j, k = start, 0
            end = start
            while j < len(toks) and k < len(gt):
                if _match(gt[k], toks[j]): end = j; k += 1; j += 1
                elif k + 1 < len(gt) and _match(gt[k + 1], toks[j]): k += 1
                elif j - end > 2: break
                else: j += 1
            end = max(end, min(len(toks) - 1, start + len(gt) - 1)) if k < len(gt) * 0.5 else end
            t0, t1 = ws[start][0], ws[end][1]
            cur = end + 1
        last_end = t1
        caps.append({'id': store.new_id('c'), 't0': round(max(a, t0), 3), 't1': round(min(b, max(t1, t0 + 0.3)), 3), 'text': g.strip(),
                     'speaker': None if speaker in (None, default_speaker) else speaker, 'style': style})
    return caps


def retext(caps, t0, t1, text, maxlen=32):
    """RETEXT du moteur : remplace les sous-titres d'une plage par ce texte, découpé en groupes et réparti sur la plage."""
    keep = [c for c in caps if c['t1'] <= t0 or c['t0'] >= t1]
    parts = []
    for sent in re.split(r'(?<=[.!?,])\s+', text.strip()):
        words, buf = sent.split(), []
        for w in words:
            if buf and len(' '.join(buf + [w])) > maxlen: parts.append(' '.join(buf)); buf = []
            buf.append(w)
        if buf: parts.append(' '.join(buf))
    total = sum(len(p) for p in parts) or 1
    t = t0
    for p_ in parts:
        d = (t1 - t0) * len(p_) / total
        keep.append({'id': store.new_id('c'), 't0': round(t, 3), 't1': round(t + d, 3), 'text': p_.rstrip('.,'), 'speaker': None, 'style': 'normal'})
        t += d
    return sorted(keep, key=lambda c: c['t0'])


def convert(name, vod_path=None):
    sys.path.insert(0, STUDIO)
    from studio import project as OP, engine as E
    from studio.config import SPEAKER_ALIASES, SPEAKERS as CFG_SPK
    cfg, TL, words_old, prof = OP.load(name)
    pack = store.get_pack('kiyoni-highlight')
    p = store.create_project(f"{cfg.get('jeu') or name} — importé", 'kiyoni-highlight', '', list(pack.get('speakers') or []))
    p['title'] = cfg.get('titre', '')
    p['glossary'] = cfg.get('glossaire', {})
    pdir = store.pdir(p['id'])
    if cfg.get('logo') and os.path.exists(cfg['logo']):
        dst = f'{pdir}/media/logo{os.path.splitext(cfg["logo"])[1]}'
        os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy(cfg['logo'], dst)
        p['logo'], p['logoUrl'] = dst, file_url(dst)
    main = cfg.get('principale')
    used = {(c.src or main) for c in TL if isinstance(c, (E.Clip, E.Freeze))}
    face = cfg.get('visage')
    aliases = dict(SPEAKER_ALIASES); aliases.update({k: k for k in CFG_SPK})

    # ---- sources + transcriptions
    for sid in sorted(used):
        path = vod_path if (sid == main and vod_path) else cfg['sources'][sid]
        if not os.path.exists(path): raise FileNotFoundError(f'source introuvable : {sid} → {path}')
        info = probe(path)
        src = {'id': sid, 'name': os.path.basename(path), 'path': path, 'url': file_url(path), 'origin': cfg.get('vod') if sid == main else None,
               **info, 'proxy': None, 'stems': None, 'status': {'transcript': 'none', 'speakers': 'none', 'stems': 'none', 'proxy': 'none'}}
        p['sources'].append(src)
        w = words_old.get(sid)
        if w:
            flat = analyse.flatten(w if isinstance(w, dict) else {'w': w})
            store.write_json(store.words_path(p['id'], sid), [x + [None] for x in flat])
            src['status']['transcript'] = 'done'
    store.save_project(p)
    ctx = T.Ctx(p)
    style = ctx.style()
    words = {s['id']: store.get_words(p['id'], s['id']) for s in p['sources']}

    # ---- éléments
    items, beds, pending_bed, overlays, rips = [], [], None, [], []
    pending_label = ''
    def close_bed(last_id):
        nonlocal pending_bed
        if pending_bed and pending_bed['from'] and last_id:
            pending_bed['to'] = last_id; beds.append(pending_bed)
        pending_bed = None
    for el in TL:
        if isinstance(el, E.Bed):
            last = items[-1]['id'] if items else None
            close_bed(last)
            if el.name:
                pending_bed = {'name': el.name, 'db': el.db, 'offset': el.start if isinstance(el.start, (int, float)) else 0.0, 'from': None}
            continue
        if isinstance(el, E.Clip):
            sid = el.src or main
            it = {'id': store.new_id('i'), 'type': 'clip', 'src': sid, 'in': round(el.a, 3), 'out': round(el.b, 3),
                  'label': el.label or pending_label, 'jump': bool(el.jump), 'speed': 1.0, 'captions': [], 'fx': []}
            pending_label = ''
            if el.gap and abs(el.gap - E.JUMP_GAP) > 1e-3: it['gap'] = el.gap
            if el.gain: it['volumeDb'] = el.gain
            if el.face: it['face'] = [round(el.face[0] / W, 4), round(el.face[1] / H, 4)]
            fixes, retexts, capoffs = [], [], []
            for f in el.fx:
                k, a_ = f.kind, f.args
                if k == 'zoom': it['fx'].append({'id': store.new_id('f'), 'kind': 'zoom', 't0': f.t0, 't1': f.t1, 'target': norm_target(a_['where']), 'scale': a_['zoom']})
                elif k == 'sfx': it['fx'].append({'id': store.new_id('f'), 'kind': 'sfx', 't': f.t0, 'name': a_['name'], 'db': a_.get('db', 0) or 0})
                elif k == 'shake': it['fx'].append({'id': store.new_id('f'), 'kind': 'shake', 't0': f.t0, 't1': f.t1, 'amp': a_.get('amp', 14)})
                elif k == 'tint': it['fx'].append({'id': store.new_id('f'), 'kind': 'tint', 't0': f.t0, 't1': f.t1, 'mode': a_.get('mode', 'red')})
                elif k == 'pip': it['fx'].append({'id': store.new_id('f'), 'kind': 'tint', 't0': f.t0, 't1': f.t1, 'mode': 'bw'})
                elif k == 'speed': it['fx'].append({'id': store.new_id('f'), 'kind': 'speed', 't0': f.t0, 't1': f.t1, 'rate': a_.get('k', 1.08)})
                elif k in ('keep', 'cut'): it['fx'].append({'id': store.new_id('f'), 'kind': k, 't0': f.t0, 't1': f.t1})
                elif k == 'bip': it['fx'].append({'id': store.new_id('f'), 'kind': 'censor', 't0': f.t0, 't1': f.t1})
                elif k in ('big', 'note', 'rip'):
                    it['fx'].append({'id': store.new_id('f'), 'kind': 'text', 't': f.t0, 'dur': a_.get('dur', 1.4), 'text': a_['text'],
                                     'style': {'big': 'big', 'note': 'note', 'rip': 'rip'}[k]})
                elif k == 'fix': fixes.append((a_['old'], a_['new']))
                elif k == 'retext': retexts.append((f.t0, f.t1, a_['text']))
                elif k == 'capoff': capoffs.append((f.t0, f.t1))
                elif k == 'overlay': overlays.append((it['id'], f))
            # cadrages alternés à chaque coupe (cycle) -> un zoom par morceau
            if el.cycle:
                for n, (s0, e0) in enumerate(T.pieces(it, words.get(sid, []), style)):
                    fr = el.cycle[n % len(el.cycle)]
                    if fr and not any(z['kind'] == 'zoom' and z['t0'] < e0 and z['t1'] > s0 for z in it['fx']):
                        it['fx'].append({'id': store.new_id('f'), 'kind': 'zoom', 't0': round(s0, 3), 't1': round(e0, 3), 'target': norm_target(fr[0]), 'scale': fr[1]})
            it['fx'].sort(key=lambda x: x.get('t', x.get('t0', 0)))
            if el.caps:
                if el.say: caps = align_say(el.say, words.get(sid, []), el.a, el.b, p.get('defaultSpeaker'), aliases)
                else:
                    caps = analyse.make_captions(words.get(sid, []), el.a, el.b, style, p['glossary'], p.get('defaultSpeaker'))
                    for old, new in fixes:
                        for c in caps: c['text'] = re.sub(rf'\b{re.escape(old.lower())}\b', new, c['text'])
                    for t0, t1, txt in retexts: caps = retext(caps, t0, t1, txt)
                for t0, t1 in capoffs: caps = [c for c in caps if c['t1'] <= t0 or c['t0'] >= t1]
                it['captions'] = caps
            items.append(it)
        elif isinstance(el, E.Freeze):
            it = {'id': store.new_id('i'), 'type': 'freeze', 'src': el.src or main, 't': round(el.t, 3), 'dur': el.dur,
                  'target': norm_target('center' if el.where is None else ('face' if el.where == 'avatar' else el.where)), 'scale': el.zoom or 1.0, 'sfx': None}
            if el.tint == 'bw': it['look'] = {'color': {'preset': 'nb'}}
            for f in el.fx:
                if f.kind == 'sfx' and not it['sfx']: it['sfx'] = f.args['name']
                elif f.kind == 'rip': rips.append((it['id'], f.t0, f.args['text'], f.args.get('dur', 2.2)))
            items.append(it)
        elif isinstance(el, E.Card):
            st = el.style if el.style in ('logo', 'twitch', 'narr', 'title') else 'chapter'
            items.append({'id': store.new_id('i'), 'type': 'card', 'dur': el.dur, 'text': el.title, 'sub': el.sub or '', 'style': st,
                          'image': p.get('logoUrl') if st == 'logo' else None})
            if el.label: pending_label = el.label
        elif isinstance(el, E.Media):
            info = probe(el.path)
            items.append({'id': store.new_id('i'), 'type': 'media', 'path': el.path, 'url': file_url(el.path), 'kind': info['kind'],
                          'dur': info['duration'] or 3.0, 'volumeDb': el.db or 0})
        if pending_bed and pending_bed['from'] is None and items:
            pending_bed['from'] = items[-1]['id']
    close_bed(items[-1]['id'] if items else None)
    p['timeline'] = items

    # ---- musiques
    for b in beds:
        t = None
        from . import library
        try: t = library.music_by_name(b['name'])
        except Exception: t = None
        if not t:
            print(f"  musique introuvable : {b['name']}"); continue
        p['music'].append({'id': store.new_id('m'), 'name': t['name'], 'url': t['url'], 'gainDb': t['gainDb'], 'db': b['db'],
                           'fromItem': b['from'], 'toItem': b['to'], 'offset': b['offset']})

    # ---- incrustations / RIP (en temps de sortie)
    ctx = T.Ctx(p)
    starts, t = {}, 0.0
    for it in p['timeline']:
        starts[it['id']] = t; t += T.item_duration(ctx, it)
    def out_time(item_id, src_t):
        it = next(x for x in p['timeline'] if x['id'] == item_id)
        acc = starts[item_id]
        for s0, e0, k in T.speed_parts(it, T.pieces(it, words.get(it['src'], []), style), style.get('baseSpeed', 1.0)):
            if src_t < s0: return acc
            if src_t <= e0: return acc + (src_t - s0) / k
            acc += (e0 - s0) / k
        return acc
    tracks = []
    if overlays:
        tr = {'id': store.new_id('t'), 'kind': 'video', 'name': 'Incrustations', 'clips': []}
        for item_id, f in overlays:
            a_ = f.args
            info = probe(a_['path'])
            w = a_.get('w', 1920); h = w * 9 / 16
            look = {}
            if w != 1920 or a_.get('x') or a_.get('y'):
                look = {'scale': round(w / W, 4), 'x': round((a_.get('x', 0) + w / 2 - W / 2) / W * 100, 2), 'y': round((a_.get('y', 0) + h / 2 - H / 2) / H * 100, 2)}
            if a_.get('chroma'): look['chroma'] = '#00ff00'
            dur = a_.get('dur') or info['duration'] or 3.0
            tr['clips'].append({'id': store.new_id('o'), 'type': 'video', 'kind': 'image' if info['kind'] == 'image' else 'video', 'path': a_['path'],
                                'url': file_url(a_['path']), 'in': a_.get('start', 0.0), 'start': round(out_time(item_id, f.t0), 3), 'dur': round(dur, 3),
                                'look': look, 'volumeDb': -100 if (a_.get('db') or 0) <= -60 else (a_.get('db') or 0),
                                'muted': (a_.get('db') or 0) <= -60, 'fadeIn': a_.get('fade', 0.15), 'fadeOut': a_.get('fade', 0.15),
                                'name': os.path.splitext(os.path.basename(a_['path']))[0]})
        tracks.append(tr)
    if rips:
        tr = {'id': store.new_id('t'), 'kind': 'text', 'name': 'Textes', 'clips': []}
        for item_id, t0, text, dur in rips:
            tr['clips'].append({'id': store.new_id('o'), 'type': 'text', 'start': round(starts[item_id] + t0, 3), 'dur': dur, 'text': text,
                                'style': {'font': 'Montserrat', 'size': 128, 'weight': 800, 'color': '#C8C8C8', 'stroke': 0, 'strokeColor': '#000000',
                                          'bg': None, 'x': 0.5, 'y': 0.5, 'align': 'center', 'anim': 'pop', 'shadow': True}})
        tracks.insert(0, tr)
    p['tracks'] = tracks
    store.save_project(p)
    n_caps = sum(len(i.get('captions', [])) for i in items)
    print(f"projet {p['id']} : {len(items)} éléments, {n_caps} sous-titres, {len(p['music'])} musiques, "
          f"{sum(len(t['clips']) for t in tracks)} clips de pistes, durée ≈ {t / 60:.1f} min")
    return p


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('nom')
    ap.add_argument('--vod')
    ap.add_argument('--studio')
    a = ap.parse_args()
    if a.studio: STUDIO = os.path.abspath(os.path.expanduser(a.studio))
    convert(a.nom, a.vod)
