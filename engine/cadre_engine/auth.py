"""Password-protected remote access.

- From the Mac itself (desktop app, http://127.0.0.1:8765): no password.
- From any other device (Tailscale, public link): the UI pages load, but all data (/api, /mcp) requires a session
  opened with the password. With no password set, remote access is closed.
- Password: hashed (PBKDF2-SHA256, random salt) in DATA/auth.json, never in plain text. Sessions: random token
  in an HttpOnly / Secure / SameSite=Lax cookie, valid for 30 days. Too many failed attempts from one address: blocked."""
import hashlib
import hmac
import os
import secrets
import threading
import time
from .config import DATA
from . import store

AUTH_F = os.path.join(DATA, 'auth.json')
COOKIE = 'cadre_session'
TTL = 30 * 86400
_lock = threading.Lock()
_fails = {}                     # ip -> [failure timestamps]
ITER = 240_000


def _load():
    return store.read_json(AUTH_F, {'hash': None, 'salt': None, 'sessions': {}})


def _save(d):
    store.write_json(AUTH_F, d)
    try: os.chmod(AUTH_F, 0o600)
    except OSError: pass


def configured():
    return bool(_load().get('hash'))


def set_password(pw):
    if len(pw or '') < 8: raise ValueError('8 characters minimum')
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, ITER)
    with _lock:
        d = _load()
        d.update(hash=h.hex(), salt=salt.hex(), sessions={})       # changing the password logs everyone out
        _save(d)


def check_password(pw):
    d = _load()
    if not d.get('hash'): return False
    h = hashlib.pbkdf2_hmac('sha256', (pw or '').encode(), bytes.fromhex(d['salt']), ITER)
    return hmac.compare_digest(h.hex(), d['hash'])


def throttled(ip):
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < 600]
    _fails[ip] = recent
    return len(recent) >= 6


def failed(ip):
    _fails.setdefault(ip, []).append(time.time())


def new_session(label=''):
    tok = secrets.token_urlsafe(32)
    with _lock:
        d = _load()
        now = time.time()
        d['sessions'] = {k: v for k, v in d.get('sessions', {}).items() if v.get('exp', 0) > now}
        d['sessions'][hashlib.sha256(tok.encode()).hexdigest()] = {'exp': now + TTL, 'label': label[:80], 'created': now}
        _save(d)
    return tok


def valid(tok):
    if not tok: return False
    s = _load().get('sessions', {}).get(hashlib.sha256(tok.encode()).hexdigest())
    return bool(s and s.get('exp', 0) > time.time())


def end_session(tok):
    if not tok: return
    with _lock:
        d = _load()
        d.get('sessions', {}).pop(hashlib.sha256(tok.encode()).hexdigest(), None)
        _save(d)


def is_local(req):
    """request from the Mac itself, not through a proxy (Tailscale Serve / Funnel add headers)"""
    host = (req.headers.get('host') or '').rsplit(':', 1)[0].strip('[]')
    client = req.client.host if req.client else ''
    proxied = any(h in req.headers for h in ('x-forwarded-for', 'x-forwarded-host', 'tailscale-user-login', 'tailscale-funnel-request', 'forwarded'))
    return host in ('127.0.0.1', 'localhost', '::1') and client in ('127.0.0.1', '::1') and not proxied


def client_ip(req):
    return (req.headers.get('x-forwarded-for') or (req.client.host if req.client else '')).split(',')[0].strip()
