"""Voix : empreintes ECAPA (SpeechBrain) pour savoir qui parle, et séparation voix / reste (Demucs).
Modules optionnels (« modules voix », ~2 Go) : si absents, les fonctions lèvent une erreur claire."""
import hashlib
import os
import struct
import subprocess
import sys
import wave
import numpy as np
from . import ff
from .config import CACHE, MODELS

SR = 16000
WIN, HOP = 1.2, 0.4
STEMS = os.path.join(CACHE, 'stems')
SEP_SR = 44100
_model = None


def available():
    try:
        import importlib.util
        return all(importlib.util.find_spec(m) for m in ('torch', 'speechbrain', 'demucs'))
    except Exception:
        return False


def _need():
    if not available():
        raise RuntimeError("modules voix non installés (Réglages › Modules voix)")


def model():
    global _model
    _need()
    if _model is None:
        import warnings; warnings.filterwarnings('ignore')
        from speechbrain.inference.speaker import EncoderClassifier
        _model = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb', savedir=os.path.join(MODELS, 'ecapa'),
                                                run_opts={'device': 'cpu'})
    return _model


def speech_frames(x, hop=0.02):
    n = len(x) // int(SR * hop)
    fr = x[:n * int(SR * hop)].reshape(n, -1)
    db = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)
    ref = np.percentile(db, 97) if n else -20
    return db, db > max(-48.0, ref - 30.0)


def windows(x):
    """fenêtres de 1,2 s couvrant de la parole"""
    db, sp = speech_frames(x)
    out, t, dur = [], 0.0, len(x) / SR
    while t + WIN <= dur + 1e-6:
        i0, i1 = int(t / 0.02), int((t + WIN) / 0.02)
        seg = sp[i0:i1]
        if len(seg) and seg.mean() >= 0.55:
            out.append((round(t, 2), round(t + WIN, 2), float(np.median(db[i0:i1][seg]))))
        t += HOP
    return out


def embed(x, wins):
    import torch
    if not wins: return np.zeros((0, 192), np.float32)
    batch = torch.from_numpy(np.stack([x[int(a * SR):int(a * SR) + int(WIN * SR)] for a, b, _ in wins]))
    with torch.no_grad():
        e = model().encode_batch(batch).squeeze(1).numpy()
    return e / np.linalg.norm(e, axis=1, keepdims=True)


# ------------------------------------------------------------------ séparation voix / reste (Demucs)
def key(path, a, b):
    return hashlib.md5(f'{path}|{a:.2f}|{b:.2f}'.encode()).hexdigest()[:14]


def read16(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), '<i2').reshape(-1, 2).astype(np.float32) / 32768


def _write16(path, x, sr):
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())


def separate(path, a, b):
    """-> (voix.wav, reste.wav) en cache, 44,1 kHz. Demucs htdemucs « two-stems » (GPU Apple ou NVIDIA si présent)."""
    _need()
    os.makedirs(STEMS, exist_ok=True)
    k = key(path, a, b)
    voice, rest = f'{STEMS}/{k}_voix.wav', f'{STEMS}/{k}_jeu.wav'
    if os.path.exists(rest): return voice, rest
    raw = ff.run(['-v', 'error', '-ss', f'{a:.3f}', '-t', f'{b - a:.3f}', '-i', path, '-vn', '-ac', '2', '-ar', str(SEP_SR),
                  '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).reshape(-1, 2)
    tmp = os.path.join(STEMS, f'_lot_{k}')
    os.makedirs(tmp, exist_ok=True)
    _write16(f'{tmp}/lot.wav', x, SEP_SR)
    import torch
    device = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
    subprocess.run([sys.executable, '-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs', '-d', device, '-o', tmp, f'{tmp}/lot.wav'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import shutil
    shutil.move(f'{tmp}/htdemucs/lot/vocals.wav', voice)
    shutil.move(f'{tmp}/htdemucs/lot/no_vocals.wav', rest)
    shutil.rmtree(tmp, ignore_errors=True)
    return voice, rest


def audio16(path, a, b, duration):
    """mono 16 kHz de [a, b] : piste voix séparée si elle existe (plus fiable), sinon le son d'origine."""
    sep = f'{STEMS}/{key(path, 0.0, round(float(duration), 2))}_voix.wav'
    if os.path.exists(sep):
        from scipy.signal import resample_poly
        with wave.open(sep) as wv:
            sr = wv.getframerate(); wv.setpos(int(a * sr))
            x = np.frombuffer(wv.readframes(int((b - a) * sr)), '<i2').reshape(-1, 2).astype(np.float32).mean(1) / 32768
        return resample_poly(x, 160, 441).astype(np.float32)
    raw = ff.run(['-v', 'error', '-ss', f'{a:.3f}', '-t', f'{b - a:.3f}', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
                 capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()
