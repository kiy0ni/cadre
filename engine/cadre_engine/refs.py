"""Analyse d'une vidéo de référence (lien YouTube / Twitch / fichier / source du projet) pour l'assistant :
images clés, changements de plan, paroles, évènements sonores, et surtout ce qui vient de la bibliothèque de
l'utilisateur : quels bruitages tombent à quels instants, quelle musique (et à partir d'où dans le morceau).

La comparaison se fait sur des spectrogrammes « mel » : chaque son de la bibliothèque est comparé au début de chaque
évènement sonore de la référence ; chaque musique est cherchée par corrélation glissante. Si la séparation voix / fond
est installée, on compare sur le fond (sans la voix) : les correspondances sont bien plus nettes."""
import hashlib
import json
import os
import re
import subprocess
import sys
import numpy as np
from . import ff, library, store
from .config import CACHE
from .media import path_of

SR = 16000
REFS = os.path.join(CACHE, 'refs')
FEAT = os.path.join(CACHE, 'features')
_FB = None


def _sha(s):
    return hashlib.sha1(s.encode()).hexdigest()[:16]


# ------------------------------------------------------------------ récupération
def fetch(src, a, b, job=None):
    """-> (chemin, décalage, titre, durée totale) ; un lien n'est téléchargé que sur [a, b] (basse définition)."""
    if re.match(r'^https?://', src):
        d = os.path.join(REFS, _sha(f'{src}|{a:.1f}|{b:.1f}'))
        os.makedirs(d, exist_ok=True)
        meta_f = os.path.join(d, 'meta.json')
        if os.path.exists(meta_f):
            m = json.load(open(meta_f))
            if os.path.exists(m['path']): return m['path'], a, m['title'], m['duration']
        if job: job.step(None, 'téléchargement de l’extrait…')
        cmd = [sys.executable, '-m', 'yt_dlp', '-f', 'b[height<=480]/bv*[height<=480]+ba/b', '--merge-output-format', 'mp4',
               '--download-sections', f'*{a:.2f}-{b:.2f}', '--force-keyframes-at-cuts', '--ffmpeg-location', os.path.dirname(ff.ffmpeg()),
               '--no-playlist', '-o', os.path.join(d, 'ref.%(ext)s'), '--print', 'before_dl:%(title)s|%(duration)s', '--print', 'after_move:filepath', src]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
        lines = [l.strip() for l in r.stdout.splitlines() if l.strip()]
        path = next((l for l in lines if os.path.isabs(l) and os.path.exists(l)), None)
        if not path: raise RuntimeError('vidéo impossible à télécharger : ' + (r.stderr or '')[-300:])
        info = next((l for l in lines if '|' in l and not os.path.isabs(l)), '|')
        title, dur = info.rsplit('|', 1)
        m = {'path': path, 'title': title, 'duration': float(dur or 0) if dur.replace('.', '', 1).isdigit() else 0}
        json.dump(m, open(meta_f, 'w'))
        return path, a, m['title'], m['duration']
    path = os.path.abspath(os.path.expanduser(src))
    if not os.path.isfile(path): raise RuntimeError(f'fichier introuvable : {src}')
    return path, 0.0, os.path.basename(path), _duration(path)


def _duration(path):
    r = ff.probe_run(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True)
    try: return float(r.stdout.strip())
    except ValueError: return 0.0


def _pcm(path, a=0.0, d=None):
    args = ['-v', 'error', '-ss', f'{a:.3f}'] + (['-t', f'{d:.3f}'] if d else []) + ['-i', path, '-vn', '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-']
    return np.frombuffer(ff.run(args, capture_output=True).stdout, np.float32)


# ------------------------------------------------------------------ spectrogrammes
def _fb(n_fft=512, n=64, fmin=50, fmax=7600):
    global _FB
    if _FB is not None: return _FB
    hz = lambda m: 700 * (10 ** (m / 2595) - 1)
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    pts = hz(np.linspace(mel(fmin), mel(fmax), n + 2))
    bins = np.floor((n_fft + 1) * pts / SR).astype(int)
    fb = np.zeros((n, n_fft // 2 + 1), np.float32)
    for i in range(n):
        l, c, r = bins[i], bins[i + 1], bins[i + 2]
        for k in range(l, c): fb[i, k] = (k - l) / max(1, c - l)
        for k in range(c, r): fb[i, k] = (r - k) / max(1, r - c)
    _FB = fb
    return fb


def logmel(x, hop):
    """-> (64, T) log-énergie par bande, une colonne toutes les hop/16000 s"""
    n = 512
    if len(x) < n: x = np.pad(x, (0, n - len(x)))
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop]
    spec = np.abs(np.fft.rfft(frames * np.hanning(n).astype(np.float32), axis=1)) ** 2
    return np.log10(_fb() @ spec.T + 1e-7).astype(np.float32)


def _norm_cols(m):
    m = m - m.mean(axis=0, keepdims=True)
    return m / (np.linalg.norm(m, axis=0, keepdims=True) + 1e-6)


# ------------------------------------------------------------------ bibliothèque : empreintes (en cache)
def _sfx_feats():
    lib = library.ready() or library.get()
    os.makedirs(FEAT, exist_ok=True)
    cache_f = os.path.join(FEAT, 'sfx.npz')
    cache = dict(np.load(cache_f, allow_pickle=True)) if os.path.exists(cache_f) else {}
    out, changed = [], False
    for key, s in lib['sfx'].items():
        for v in s['variants']:
            p = path_of(v['url'])
            if not p or not os.path.exists(p): continue
            ck = _sha(f"{p}|{os.path.getmtime(p)}|{v.get('start', 0)}")
            if ck not in cache:
                cache[ck] = logmel(_pcm(p, float(v.get('start', 0)), 1.0), 160)
                changed = True
            out.append((key, s.get('label') or key, os.path.basename(p), cache[ck]))
    if changed: np.savez(cache_f, **cache)
    return out


def _music_feat(path):
    os.makedirs(FEAT, exist_ok=True)
    f = os.path.join(FEAT, f'm_{_sha(f"{path}|{os.path.getmtime(path)}")}.npy')
    if os.path.exists(f): return np.load(f)
    m = _norm_cols(logmel(_pcm(path, 0, 300), 1600))
    np.save(f, m)
    return m


# ------------------------------------------------------------------ analyse
def onsets(x, max_n=32):
    """évènements sonores (attaques) : montée d'énergie par bande (chaque bande pèse pareil, pour ne pas rater les
    sons graves type boum) -> [(t, force, niveau dB)]"""
    m = logmel(x, 160)
    d = np.maximum(0, m[:, 2:] - m[:, :-2])                    # montée sur 20 ms
    d = d / (d.std(axis=1, keepdims=True) + 1e-6)
    flux = np.concatenate([[0, 0], d.mean(axis=0)])
    if len(flux) < 5: return []
    flux = np.convolve(flux, np.ones(3) / 3, 'same')
    thr = flux.mean() + 1.2 * flux.std()
    peaks = [i for i in range(1, len(flux) - 1) if flux[i] > thr and flux[i] >= flux[i - 1] and flux[i] >= flux[i + 1]]
    peaks.sort(key=lambda i: -flux[i])
    keep = []
    for i in peaks:
        if all(abs(i - j) > 20 for j in keep): keep.append(i)
        if len(keep) >= max_n: break
    # 2e détecteur : brusque montée d'énergie dans les graves (boum, impact sourd) que le flux spectral sous-estime
    low = np.log10((10 ** m[:12]).sum(axis=0) + 1e-9)
    cand = []
    for i in range(20, len(low) - 1):
        rise = low[i] - low[i - 20:i].min()
        if rise > 0.9 and low[i] >= low[i - 1] and low[i] >= low[i + 1]: cand.append((rise, i))
    added = 0
    for rise, i in sorted(cand, reverse=True):
        if added >= max_n: break
        if all(abs(i - j) > 15 for j in keep): keep.append(i); added += 1
    out = []
    for i in sorted(keep):
        seg = x[i * 160: i * 160 + 4000]
        db = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9) if len(seg) else -90
        out.append((i * 160 / SR, float(flux[i] / (flux.max() or 1)), float(db)))
    return out


def match_sfx(x, t, feats, top=3):
    """sons de la bibliothèque les plus proches de l'évènement à t (s) dans x"""
    a = max(0, int((t - 0.03) * SR))
    ref = logmel(x[a:a + SR], 160)
    L = min(60, ref.shape[1])
    if L < 8: return []
    R = _norm_cols(ref[:, :L])
    renv = ref[:, :L].mean(axis=1); renv = (renv - renv.mean()) / (renv.std() + 1e-6)
    scores = {}
    for key, label, fname, f in feats:
        Lf = min(L, f.shape[1])
        if Lf < 8: continue
        F = _norm_cols(f[:, :Lf])
        best = -1.0
        for sh in range(0, 4):
            n = min(Lf, L - sh)
            if n < 8: break
            best = max(best, float((R[:, sh:sh + n] * F[:, :n]).sum(axis=0).mean()))
        env = f[:, :Lf].mean(axis=1); env = (env - env.mean()) / (env.std() + 1e-6)
        sc = 0.65 * best + 0.35 * float(np.dot(renv, env) / len(env))
        if sc > scores.get(key, (-9,))[0]: scores[key] = (sc, label, fname)
    return sorted(((v[0], k, v[1], v[2]) for k, v in scores.items()), reverse=True)[:top]


def cuts(path, a, b):
    out = ff.run(['-hide_banner', '-ss', f'{a:.2f}', '-t', f'{b - a:.2f}', '-i', path, '-vf', "select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-'],
                 capture_output=True, text=True).stderr or ''
    return [a + float(m) for m in re.findall(r'pts_time:([\d.]+)', out)]


def frame(path, t, w=640):
    r = ff.run(['-v', 'error', '-ss', f'{max(0, t):.2f}', '-i', path, '-frames:v', '1', '-vf', f'scale={w}:-2', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', '-'],
               capture_output=True)
    return r.stdout or None


def analyse(src, a=0.0, b=None, n_images=8, sounds=True, job=None, lang=None):
    """analyse complète -> {'text': rapport, 'images': [jpeg]}"""
    a = max(0.0, float(a or 0))
    b = float(b) if b else a + 90
    if b - a > 300: b = a + 300
    path, off, title, total = fetch(src, a, b, job)
    la, lb = a - off, b - off                           # temps dans le fichier récupéré
    if total and lb > total: lb = total; b = total + off
    if lb - la < 1: raise RuntimeError("extrait trop court (vérifie debut / fin)")
    lines = [f"Vidéo : {title}" + (f" (durée totale {total / 60:.1f} min)" if total else '') + f" — extrait analysé {a:.1f} → {b:.1f} s (temps de la vidéo)."]
    # plans
    cs = cuts(path, la, lb)
    lines.append(f"Changements de plan ({len(cs)}) : " + (', '.join(f'{c + off:.2f}' for c in cs[:40]) or 'aucun'))
    # images
    times = sorted(set([round(c + 0.15, 2) for c in cs[:max(0, n_images - 2)]] + list(np.linspace(la + 0.3, lb - 0.3, max(2, n_images - len(cs[:n_images - 2]))))))[:n_images]
    images = [(t, frame(path, t)) for t in times]
    images = [(t, im) for t, im in images if im]
    lines.append('Images jointes (dans l’ordre) aux temps : ' + ', '.join(f'{t + off:.2f}' for t, _ in images))
    # paroles
    try:
        if job: job.step(None, 'transcription de l’extrait…')
        from . import transcribe as ASR
        ws = ASR.chunk(path, la, lb, language=lang or None, prompt='', model=(store.settings().get('transcription') or {}).get('model', 'turbo'))
        groups, cur = [], []
        for w in ws:
            if cur and (w[0] - cur[-1][1] > 0.8 or len(cur) > 14): groups.append(cur); cur = []
            cur.append(w)
        if cur: groups.append(cur)
        lines.append('Paroles :' if groups else 'Paroles : aucune.')
        for g in groups: lines.append(f"  [{g[0][0] + off:.1f}] {''.join(x[2] for x in g).strip()}")
    except Exception as e:
        lines.append(f'Paroles : transcription impossible ({e})')
    if sounds:
        x = _pcm(path, la, lb - la)
        bed, sep = x, False
        try:
            from . import voices as VX
            if VX.available():
                if job: job.step(None, 'séparation voix / fond…')
                _, rest = VX.separate(path, la, lb)
                bed = _pcm(rest); sep = True
        except Exception:
            bed = x
        lvl = [20 * np.log10(np.sqrt(np.mean(c ** 2)) + 1e-9) for c in np.array_split(x, max(1, int(len(x) / SR)))]
        lines.append('Niveau sonore par seconde (dB) : ' + ' '.join(f'{v:.0f}' for v in lvl[:300]))
        if job: job.step(None, 'comparaison avec ta bibliothèque…')
        lib_ok = library.ready() is not None or bool(store.settings().get('libraries'))
        ev = onsets(bed, max(20, int(lb - la)))
        feats = _sfx_feats() if lib_ok and ev else []
        lines.append(f"Évènements sonores ({len(ev)}, analysés sur {'le fond sans la voix' if sep else 'le mixage complet'}) — sons de ta bibliothèque reconnus :")
        unknown = []
        for t, force, db in ev:
            m = match_sfx2(bed, t, feats, 8) if feats else []
            groups = []                                  # même score = même fichier (nom court + nom de fichier)
            for sc, k, lab, fname in m:
                if groups and abs(groups[-1][0] - sc) < 1e-4: groups[-1][1].append((k, lab)); continue
                groups.append((sc, [(k, lab)]))
            if not groups or groups[0][0] < 0.63:
                unknown.append(t + a)
                continue
            sc, names = groups[0]
            conf = 'très probable' if sc >= 0.68 else 'plausible'
            alt = [g for g in groups[1:3] if g[0] >= 0.6]
            lines.append(f"  {t + a:.2f} s  ({db:.0f} dB) : {conf} « {names[0][1]} » [{' = '.join(k for k, _ in names)}] (score {sc:.2f})"
                         + (f" ; sinon {', '.join(f'« {g[1][0][1]} » [{g[1][0][0]}] {g[0]:.2f}' for g in alt)}" if alt else ''))
        if unknown: lines.append(f"  autres évènements (bruits du jeu / de la vidéo, rien de ta bibliothèque) : {', '.join(f'{u:.1f}' for u in unknown[:40])}")
        if lib_ok:
            mm = match_music(x, win=6.0, hop=2.0)
            if mm:
                lines.append('Musiques de ta bibliothèque reconnues :')
                for t0, t1, name, n, pos, alts in mm:
                    conf = 'certain' if n >= 40 else 'très probable' if n >= 15 else 'probable'
                    lines.append(f"  {t0 + a:.1f} → {t1 + a:.1f} s : « {name} » ({conf}, {n} correspondances) — à {t0 + a:.1f} s on est à {max(0, pos):.1f} s du morceau"
                                 + (f", donc le morceau démarre vers {t0 + a - pos:.1f} s" if pos >= 0 else f", le morceau démarre vers {t0 + a - pos:.1f} s"))
            else:
                lines.append('Musiques de ta bibliothèque reconnues : aucune.')
        lines.append("Les sons « très probable » et les musiques « certain » viennent presque sûrement de ta bibliothèque ; « plausible » : à vérifier en réécoutant.")
    return {'text': '\n'.join(lines), 'images': [im for _, im in images]}


_STACK = None


def _stack(feats):
    """empreintes des sons empilées (n, 64, 80) + masques des cases significatives"""
    global _STACK
    if _STACK is not None and _STACK[0] is feats: return _STACK[1]
    L = 80
    F = np.full((len(feats), 64, L), np.nan, np.float32)
    for k, (_, _, _, f) in enumerate(feats):
        n = min(L, f.shape[1]); F[k, :, :n] = f[:, :n]
    mx = np.nanmax(F.reshape(len(feats), -1), axis=1)[:, None, None]
    M = (F > mx - 2.0)
    ok = M.reshape(len(feats), -1).sum(axis=1) >= 20
    _STACK = (feats, (F, M, ok))
    return _STACK[1]


def match_sfx2(x, t, feats, top=3):
    """variante « présence » : un son présent dans un mélange y laisse au moins son énergie, case par case du
    spectrogramme. On cherche le gain qui l'explique et on mesure à quel point chaque case reste cohérente."""
    if not feats: return []
    F, M, ok = _stack(feats)
    a = max(0, int((t - 0.06) * SR))
    R = logmel(x[a:a + int(1.25 * SR)], 160)
    L = F.shape[2]
    if R.shape[1] < L + 14: R = np.pad(R, ((0, 0), (0, L + 14 - R.shape[1])), constant_values=-7)
    best = np.zeros(len(feats), np.float32)
    for sh in range(0, 15):
        D = np.where(M, R[None, :, sh:sh + L] - F, np.nan)
        lg = np.nanpercentile(D.reshape(len(feats), -1), 15, axis=1)[:, None, None]
        sc = np.nanmean(np.exp(-1.5 * np.abs(D - lg)).reshape(len(feats), -1), axis=1)
        best = np.maximum(best, np.nan_to_num(sc))
    best[~ok] = 0
    agg = {}
    for k, (key, label, fname, _) in enumerate(feats):
        if best[k] > agg.get(key, (-1,))[0]: agg[key] = (float(best[k]), label, fname)
    return sorted(((v[0], k, v[1], v[2]) for k, v in agg.items()), reverse=True)[:top]


# ------------------------------------------------------------------ musique : empreintes « à la Shazam »
# pics du spectrogramme -> paires (f1, f2, Δt) -> hachages. Une musique présente dans un mélange partage beaucoup de
# hachages avec l'original, tous au même décalage : on compte les décalages communs.
FP_HOP = 256          # 16 ms


def fingerprint(x):
    """-> (hachages int64, instants en trames)"""
    from scipy.ndimage import maximum_filter
    n = 1024
    if len(x) < n * 4: return np.zeros(0, np.int64), np.zeros(0, np.int32)
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::FP_HOP]
    S = np.log(np.abs(np.fft.rfft(frames * np.hanning(n).astype(np.float32), axis=1))[:, 4:300] + 1e-6)   # ~60 Hz – 4,7 kHz
    peaks = (S == maximum_filter(S, size=(15, 21))) & (S > np.percentile(S, 80))
    t, f = np.nonzero(peaks)
    keep = []                                   # au plus ~25 pics par seconde, les plus forts
    per = int(SR / FP_HOP)
    for s0 in range(0, S.shape[0], per):
        sel = np.nonzero((t >= s0) & (t < s0 + per))[0]
        if len(sel) > 25: sel = sel[np.argsort(-S[t[sel], f[sel]])[:25]]
        keep.extend(sel.tolist())
    keep = np.array(sorted(keep, key=lambda i: (t[i], f[i])), dtype=int)
    t, f = t[keep], f[keep]
    hs, ts = [], []
    for i in range(len(t)):
        j = i + 1; k = 0
        while j < len(t) and t[j] - t[i] <= 60 and k < 6:
            dt = t[j] - t[i]
            if dt >= 2 and abs(int(f[j]) - int(f[i])) < 60:
                hs.append((int(f[i]) << 18) | (int(f[j]) << 8) | int(dt)); ts.append(int(t[i])); k += 1
            j += 1
    return np.array(hs, np.int64), np.array(ts, np.int32)


_MIDX = None


def music_index():
    """index de toutes les musiques de la bibliothèque (premières 6 minutes), en cache"""
    global _MIDX
    lib = library.ready() or library.get()
    tracks = [t for t in lib['music'] if t.get('path') and os.path.exists(t['path'])]
    sig = _sha('|'.join(f"{t['path']}{os.path.getmtime(t['path'])}" for t in tracks))
    if _MIDX and _MIDX[0] == sig: return _MIDX[1]
    os.makedirs(FEAT, exist_ok=True)
    H, T, I = [], [], []
    for i, t in enumerate(tracks):
        f = os.path.join(FEAT, f"fp_{_sha(t['path'] + str(os.path.getmtime(t['path'])))}.npz")
        if os.path.exists(f):
            d = np.load(f); h, ts = d['h'], d['t']
        else:
            h, ts = fingerprint(_pcm(t['path'], 0, 360))
            np.savez(f, h=h, t=ts)
        H.append(h); T.append(ts); I.append(np.full(len(h), i, np.int32))
    if not H: return None
    H, T, I = np.concatenate(H), np.concatenate(T), np.concatenate(I)
    o = np.argsort(H, kind='stable')
    idx = {'h': H[o], 't': T[o], 'i': I[o], 'names': [t['name'] for t in tracks]}
    _MIDX = (sig, idx)
    return idx


def match_music(x, win=10.0, hop=5.0):
    """-> [(début, fin, nom, nb de correspondances, position dans le morceau, autres)] (temps en s dans x)"""
    idx = music_index()
    if idx is None or len(x) < SR * 3: return []
    h, ts = fingerprint(x)
    if not len(h): return []
    lo = np.searchsorted(idx['h'], h, 'left'); hi = np.searchsorted(idx['h'], h, 'right')
    sec = FP_HOP / SR
    hits = []
    for w0 in np.arange(0, max(sec, len(x) / SR - win / 2), hop):
        m = (ts * sec >= w0) & (ts * sec < w0 + win)
        cnt = {}
        for q in np.nonzero(m)[0]:
            if hi[q] - lo[q] > 300: continue                 # hachage trop banal
            for r in range(lo[q], hi[q]):
                key = (int(idx['i'][r]), int(round((idx['t'][r] - ts[q]) * sec * 4)))   # décalage à 0,25 s près
                cnt[key] = cnt.get(key, 0) + 1
        if not cnt: continue
        # regroupe les décalages voisins (± 0,25 s)
        best = {}
        for (ti, d), c in cnt.items():
            s = c + cnt.get((ti, d - 1), 0) + cnt.get((ti, d + 1), 0)
            if s > best.get(ti, (0, 0))[0]: best[ti] = (s, d / 4)
        ranked = sorted(((s, ti, d) for ti, (s, d) in best.items()), reverse=True)
        s1, ti, d = ranked[0]
        s2 = ranked[1][0] if len(ranked) > 1 else 0
        if s1 >= 8 and s1 >= 2 * s2:
            hits.append((w0, ti, d, s1, [idx['names'][r[1]] for r in ranked[1:3]]))
    out, cur = [], None
    for w0, ti, d, s1, alts in hits:
        pos = w0 + d                                         # position dans le morceau au début de la fenêtre
        if cur and cur['ti'] == ti and abs((cur['pos'] - cur['t0']) - (pos - w0)) < 1.0:
            cur['t1'] = w0 + win; cur['n'] += s1
        else:
            cur = {'ti': ti, 't0': w0, 't1': w0 + win, 'pos': pos, 'n': s1, 'alts': alts}
            out.append(cur)
    return [(c['t0'], min(c['t1'], len(x) / SR), idx['names'][c['ti']], c['n'], c['pos'], c['alts']) for c in out]
