"""ffmpeg / ffprobe: the system ones if present, otherwise a copy downloaded once (static-ffmpeg)."""
import shutil
import subprocess

_paths = {}


def _resolve():
    if _paths: return _paths
    ff, fp = shutil.which('ffmpeg'), shutil.which('ffprobe')
    if not (ff and fp):
        import static_ffmpeg.run as sf
        ff, fp = sf.get_or_fetch_platform_executables_else_raise()
    _paths.update(ffmpeg=ff, ffprobe=fp)
    return _paths


def ffmpeg():
    return _resolve()['ffmpeg']


def ffprobe():
    return _resolve()['ffprobe']


def run(args, **kw):
    """ffmpeg <args> (without the program name)"""
    return subprocess.run([ffmpeg(), *args], **kw)


def probe_run(args, **kw):
    return subprocess.run([ffprobe(), *args], **kw)


def popen(args, **kw):
    return subprocess.Popen([ffmpeg(), *args], **kw)
