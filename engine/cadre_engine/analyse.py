"""Analyse des sources : transcription mot à mot, qui parle (empreintes vocales), voix / reste séparés, moments forts.
Plus la fabrication des sous-titres (groupes de sens courts, gros mots censurés, couleur par personne)."""
import os, re, json
import numpy as np
from . import store, ff, text as TX, transcribe as ASR, voices as VX
from .media import file_url
from .config import CACHE, PEOPLE as SPEAKERS


# ------------------------------------------------------------------ transcription
def transcribe(p, sid, job=None, chunk=600):
    src = store.source(p, sid)
    pack = store.get_pack(p['packId']) or {}
    wh = pack.get('whisper') or {}
    gloss = ', '.join(sorted(set((p.get('glossary') or {}).values())))
    prompt = ' '.join(x for x in (wh.get('prompt', ''), gloss) if x).strip()
    raw_path = f'{store.pdir(p["id"])}/words/{sid}.raw.json'
    res = store.read_json(raw_path, {})
    dur = src['duration']
    ranges = [(a, min(dur, a + chunk)) for a in range(0, int(dur) + 1, chunk) if a < dur]
    model = store.settings().get('transcription', {}).get('model', 'turbo')
    for i, (a, b) in enumerate(ranges):
        key = f'{a:g}-{b:g}'
        if job: job.step(i / len(ranges), f'transcription {int(a // 60)}–{int(b // 60)} min')
        if key in res: continue
        res[key] = ASR.chunk(src['path'], a, b, wh.get('language') or 'fr', prompt, model)
        store.write_json(raw_path, res)
    words = flatten(res)
    gl = {k.lower(): v for k, v in (p.get('glossary') or {}).items()}
    for w in words:
        core = re.sub(r"[^\wà-ÿ'-]", '', w[2].strip().lower())
        if core in gl: w[2] = w[2].replace(w[2].strip(), gl[core])
    store.write_json(store.words_path(p['id'], sid), [w + [None] for w in words])
    return len(words)


HALLU = re.compile(r"sous-?titr|amara\.org|merci d'avoir regardé|abonnez-vous", re.I)


def flatten(res):
    """{plage: mots} -> liste triée : sans doublons aux raccords, morceaux de mots recollés (« aujourd » + « 'hui »),
    sans les hallucinations connues de Whisper (« Sous-titrage ST' 501 » sur les fins de fichier)."""
    allw = sorted((w for ws in res.values() for w in ws), key=lambda w: w[0])
    out = []
    for w in allw:
        tok = w[2]
        if out and w[0] < out[-1][1] - 0.05 and tok.strip().lower() == out[-1][2].strip().lower():
            continue
        if out and tok and not tok.startswith(' ') and (tok[0] in "'’-" or out[-1][2].rstrip()[-1:] in "'’-") \
                and w[0] - out[-1][1] < 0.35:
            out[-1][2] += tok.strip(); out[-1][1] = w[1]; out[-1][3] = min(out[-1][3], w[3])
            continue
        out.append(list(w[:4]))
    # hallucinations : phrase entière collée en fin de plage, mots de durée nulle
    text = ''.join(w[2] for w in out)
    if HALLU.search(text):
        keep, i = [], 0
        while i < len(out):
            j = i
            while j + 1 < len(out) and out[j + 1][0] - out[j][1] < 0.6 and not out[j][2].rstrip().endswith(('.', '?', '!')): j += 1
            phrase = ''.join(w[2] for w in out[i:j + 1])
            if not HALLU.search(phrase): keep += out[i:j + 1]
            i = j + 1
        out = keep
    return out


# ------------------------------------------------------------------ sous-titres
def _core(t):
    return re.sub(r"[^\wà-ÿ'*-]", '', t.lower())


def make_captions(words, a, b, style, glossary=None, default_speaker=None):
    """mots de [a, b] -> [{t0, t1, text, speaker}] : coupure aux pauses (> 0,45 s), à la ponctuation, au meilleur endroit
    avant « mais / parce que / and… » ; jamais sur un article. Mode « words » (Shorts) : 1-2 mots par sous-titre.
    Casse : « lower » (tout en minuscules sauf noms propres), « upper », ou « natural » (celle de la transcription)."""
    cap = (style or {}).get('captions', {})
    maxlen = cap.get('maxChars', 32)
    per = cap.get('wordsPerCaption', 2) if cap.get('mode') == 'words' else None
    censor = (style or {}).get('censor', {}).get('captions', True)
    case = cap.get('case') or ('upper' if cap.get('uppercase') else 'natural')
    gl = {k.lower(): v for k, v in (glossary or {}).items()}
    ws, prev_tok = [], ''
    for w in words:
        if w[1] <= a or w[0] >= b: continue
        tok = w[2].strip()
        if not tok: continue
        c = _core(tok)
        if c in TX.FILLERS: continue
        if censor: tok = TX.clean_word(tok)
        if c in gl: tok = gl[c]
        elif case == 'lower':
            # un mot capitalisé au milieu d'une phrase = nom propre : on le garde
            proper = tok[:1].isupper() and prev_tok and not prev_tok.endswith(('.', '?', '!'))
            if not proper: tok = tok.lower()
        prev_tok = tok
        ws.append((max(a, w[0]), min(b, w[1]), tok, w[4] if len(w) > 4 else None))
    groups, cur = [], []
    def emit(g):
        g = [x for x in g if re.search(r'[\wà-ÿ]', x[2])]
        if g: groups.append(g)
    def best_cut(g):
        toks = [x[2] for x in g]
        ok = [j for j in range(2, len(toks) - 1) if _core(toks[j - 1]) not in TX.NOEND]
        pref = [j for j in ok if _core(toks[j]) in TX.BREAK_BEFORE or toks[j - 1].endswith(',')]
        if pref: return pref[-1]
        if ok: return min(ok, key=lambda j: abs(len(' '.join(toks[:j])) - len(' '.join(toks[j:]))))
        return len(toks) - 1
    prev_end, prev_spk = None, None
    for w in ws:
        if cur and ((prev_end is not None and w[0] - prev_end > 0.45) or (w[3] and prev_spk and w[3] != prev_spk)):
            emit(cur); cur = []
        cur.append(w)
        if per:
            if len(cur) >= per: emit(cur); cur = []
        else:
            while len(' '.join(x[2] for x in cur)) > maxlen and len(cur) > 2:
                j = best_cut(cur); emit(cur[:j]); cur = cur[j:]
        if w[2].endswith(('.', '?', '!')): emit(cur); cur = []
        prev_end, prev_spk = w[1], w[3]
    if cur: emit(cur)
    out = []
    for g in groups:
        spk = [x[3] for x in g if x[3]]
        who = max(set(spk), key=spk.count) if spk else default_speaker
        text = ' '.join(x[2] for x in g).strip(' ,').rstrip('.')
        if case == 'upper': text = text.upper()
        out.append({'id': store.new_id('c'), 't0': round(g[0][0], 3), 't1': round(g[-1][1], 3), 'text': text,
                    'speaker': who if who != default_speaker else None, 'style': 'normal'})
    return out


def dump(words, a, b, speakers=None, step=6.0):
    """texte compact d'une plage pour l'IA : une ligne toutes les ~6 s avec son temps et qui parle."""
    lines, cur, t0, spk = [], [], None, None
    for w in words:
        if not (a <= w[0] < b): continue
        who = w[4] if len(w) > 4 else None
        if cur and (who != spk or w[0] - t0 >= step or (cur[-1].endswith(('.', '?', '!')) and w[0] - t0 > 2.5)):
            lines.append(f'[{t0:.1f}]' + (f' {spk}:' if spk else '') + ' ' + ' '.join(cur)); cur, t0 = [], None
        if t0 is None: t0, spk = w[0], who
        cur.append(w[2].strip())
    if cur: lines.append(f'[{t0:.1f}]' + (f' {spk}:' if spk else '') + ' ' + ' '.join(cur))
    return '\n'.join(lines)


# ------------------------------------------------------------------ moments forts
HYPE = (r"let'?s go|oh non|non non|quoi \?|c'est pas possible|mdr|ptdr|j'ai gagné|premier|dernier|pourquoi|au secours|"
        r"incroyable|la honte|nooo|ah non|oh my god|no way|what\?|let's go|insane|wow|omg|bro")


def loudness(path, sr=8000):
    """niveau (dB) par seconde du son de la source"""
    raw = ff.run(['-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32); n = len(x) // sr
    return 20 * np.log10(np.sqrt((x[:n * sr].reshape(n, sr) ** 2).mean(1)) + 1e-9)


def moments(p, sid, top=40, spacing=25):
    """passages où il se passe quelque chose : éclats de voix (nettement au-dessus du niveau local), gros mots,
    mots d'émotion. -> [{t, pic, score, extrait}]"""
    src = store.source(p, sid)
    cache = f'{store.pdir(p["id"])}/words/{sid}.loud.npy'
    if os.path.exists(cache): L = np.load(cache)
    else:
        L = loudness(src['path']); np.save(cache, L)
    n = len(L)
    if n == 0: return []
    med = np.array([np.median(L[max(0, i - 60):i + 60]) for i in range(0, n, 10)]).repeat(10)[:n]
    score = np.clip(L - med - 6, 0, 20) / 6
    texts = {}
    for w in store.get_words(p['id'], sid):
        i = int(w[0])
        if i >= n: continue
        texts.setdefault(i, []).append(w[2].strip())
        if TX.is_swear(w[2]): score[i] += 1.5
    for i, ts in texts.items():
        score[i] += 1.2 * len(re.findall(HYPE, ' '.join(ts).lower()))
    sm = np.convolve(score, np.ones(8) / 8, 'same')
    out, used = [], np.zeros(n, bool)
    for i in np.argsort(-sm):
        if len(out) >= top or sm[i] <= 0.2: break
        if used[max(0, i - spacing):i + spacing].any(): continue
        used[i] = True
        a = max(0, i - 15)
        ext = ' '.join(' '.join(texts.get(j, [])) for j in range(a, min(n, i + 12)))
        out.append({'t': int(a), 'pic': int(i), 'score': round(float(sm[i]), 2), 'extrait': re.sub(r'\s+', ' ', ext)[:240]})
    return sorted(out, key=lambda m: m['t'])


# ------------------------------------------------------------------ voix / reste (Demucs)
def stems(p, sid, job=None):
    src = store.source(p, sid)
    if job: job.step(0.05, 'séparation voix / reste…')
    voice, rest = VX.separate(src['path'], 0.0, round(float(src['duration']), 2))
    out = {}
    d = f'{store.pdir(p["id"])}/stems'
    os.makedirs(d, exist_ok=True)
    for wav, name in ((voice, 'voice'), (rest, 'game')):
        m4a = f'{d}/{sid}_{name}.m4a'
        if job: job.step(0.85 if name == 'voice' else 0.92, 'encodage')
        ff.run(['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', m4a], check=True)
        out[name] = file_url(m4a)
    g = VX.read16(rest)
    w = 4410; m = len(g) // w
    eg = 20 * np.log10(np.sqrt((g[:m * w].mean(1).reshape(m, w) ** 2).mean(1)) + 1e-9) if m else np.array([-60.0])
    act = eg[eg > -75]
    out['gameMedianDb'] = round(float(np.median(act)) if len(act) else -60.0, 1)
    return out


# ------------------------------------------------------------------ qui parle (empreintes vocales)
def embed_range(src, a, b):
    x = VX.audio16(src['path'], a, b, src['duration'])
    wins = VX.windows(x)
    if not wins and len(x) >= int(VX.WIN * VX.SR):
        mid = (len(x) / VX.SR - VX.WIN) / 2
        wins = [(round(mid, 2), round(mid + VX.WIN, 2), -30.0)]
    return VX.embed(x, wins), wins


def enroll_from_source(sp_id, p, sid, a, b):
    emb, wins = embed_range(store.source(p, sid), a, b)
    if len(emb) == 0: raise ValueError("pas assez de parole dans l'extrait (au moins 1,2 s de voix)")
    return _add_samples(sp_id, emb, {'project': p['id'], 'source': sid, 't0': a, 't1': b})


def enroll_from_file(sp_id, path):
    raw = ff.run(['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).copy()
    emb = VX.embed(x, VX.windows(x))
    if len(emb) == 0: raise ValueError("pas assez de parole dans l'enregistrement (au moins 5 secondes)")
    return _add_samples(sp_id, emb, {'file': os.path.basename(path)})


def _add_samples(sp_id, emb, info):
    sp = store.get_speaker(sp_id)
    if not sp: raise KeyError(sp_id)
    npz = f'{SPEAKERS}/{sp_id}.npz'
    old = np.load(npz)['emb'] if os.path.exists(npz) else np.zeros((0, emb.shape[1]), np.float32)
    if len(old) == 0 and os.path.exists(f'{SPEAKERS}/{sp_id}.npy'):
        old = np.load(f'{SPEAKERS}/{sp_id}.npy').reshape(1, -1)
    allv = np.concatenate([old, emb]).astype(np.float32)
    np.savez(npz, emb=allv)
    ref = allv.mean(0); ref /= np.linalg.norm(ref) + 1e-9
    np.save(f'{SPEAKERS}/{sp_id}.npy', ref)
    sp.setdefault('samples', []).append({**info, 'windows': int(len(emb))})
    store.save_speaker(sp)
    return {'windows': int(len(emb)), 'total': int(len(allv))}


def identify(p, sid, job=None, threshold=0.22):
    """pose « qui parle » sur chaque mot : fenêtres de 1,2 s comparées aux empreintes des personnes du projet."""
    src = store.source(p, sid)
    refs = {s: np.load(f'{SPEAKERS}/{s}.npy') for s in p.get('speakers', []) if os.path.exists(f'{SPEAKERS}/{s}.npy')}
    if not refs: raise ValueError("aucune personne du projet n'a d'empreinte vocale")
    names = list(refs); R = np.stack([refs[n] for n in names])
    words = store.get_words(p['id'], sid)
    if not words: raise ValueError("transcris d'abord la source")
    dur = float(src['duration']); chunk = 300.0
    labels, t = [], 0.0
    while t < dur:
        b = min(dur, t + chunk)
        if job: job.step(t / dur, f'qui parle : {int(t // 60)}–{int(b // 60)} min')
        x = VX.audio16(src['path'], t, b, src['duration'])
        wins = VX.windows(x)
        if wins:
            S = VX.embed(x, wins) @ R.T
            for (a0, b0, _), s_ in zip(wins, S):
                j = int(np.argmax(s_))
                labels.append((t + a0, t + b0, names[j] if s_[j] >= threshold else None, float(s_[j])))
        t = b
    default = p.get('defaultSpeaker')
    lab = np.array([(a, b) for a, b, _, _ in labels]) if labels else np.zeros((0, 2))
    counts = {}
    for w in words:
        if not len(lab): break
        m = (lab[:, 0] < w[1]) & (lab[:, 1] > w[0])
        acc = {}
        for i in np.nonzero(m)[0]:
            nm, sc = labels[i][2], labels[i][3]
            if nm: acc[nm] = acc.get(nm, 0) + sc
        who = max(acc, key=acc.get) if acc else None
        while len(w) < 5: w.append(None)
        w[4] = who if who and who != default else None
        counts[who or default or '?'] = counts.get(who or default or '?', 0) + 1
    store.write_json(store.words_path(p['id'], sid), words)
    return counts
