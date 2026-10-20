"""Transcription mot à mot : Whisper large-v3-turbo. MLX sur Mac Apple Silicon (rapide, GPU), faster-whisper ailleurs
(Windows / Linux, GPU NVIDIA si présent). Les deux renvoient le même format : [[début, fin, mot, proba], ...]."""
import os
import platform
import sys
from . import ff
from .config import CACHE

MLX = sys.platform == 'darwin' and platform.machine() == 'arm64'
MODELS = {
    'turbo': ('mlx-community/whisper-large-v3-turbo', 'large-v3-turbo'),
    'rapide': ('mlx-community/whisper-small-mlx', 'small'),
}
_fw = {}


def backend():
    return 'mlx' if MLX else 'faster-whisper'


def _audio16(path, a, b, out):
    ff.run(['-loglevel', 'error', '-y', '-ss', str(a), '-t', str(b - a), '-i', path, '-vn', '-ac', '1', '-ar', '16000', out], check=True)


def chunk(path, a, b, language='fr', prompt='', model='turbo'):
    """transcrit [a, b] de la source -> mots en temps absolus"""
    tmp = os.path.join(CACHE, f'_asr_{os.getpid()}.wav')
    _audio16(path, a, b, tmp)
    mlx_id, fw_id = MODELS.get(model, MODELS['turbo'])
    try:
        if MLX:
            import mlx_whisper
            r = mlx_whisper.transcribe(tmp, path_or_hf_repo=mlx_id, language=language or None, word_timestamps=True,
                                       initial_prompt=prompt or None, condition_on_previous_text=False, verbose=None)
            return [[round(a + w['start'], 3), round(a + w['end'], 3), w['word'], round(w.get('probability', 1), 3)]
                    for s in r['segments'] for w in s.get('words', [])]
        from faster_whisper import WhisperModel
        if fw_id not in _fw:
            try:
                import ctranslate2
                cuda = ctranslate2.get_cuda_device_count() > 0
            except Exception:
                cuda = False
            _fw[fw_id] = WhisperModel(fw_id, device='cuda' if cuda else 'cpu', compute_type='float16' if cuda else 'int8')
        segs, _ = _fw[fw_id].transcribe(tmp, language=language or None, word_timestamps=True, initial_prompt=prompt or None,
                                        condition_on_previous_text=False, vad_filter=False)
        return [[round(a + w.start, 3), round(a + w.end, 3), w.word, round(w.probability, 3)] for s in segs for w in (s.words or [])]
    finally:
        if os.path.exists(tmp): os.remove(tmp)
