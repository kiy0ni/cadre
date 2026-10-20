"""Accès à distance protégé par mot de passe.

- Depuis le Mac lui-même (appli de bureau, http://127.0.0.1:8765) : aucun mot de passe.
- Depuis n'importe quel autre appareil (Tailscale, lien public) : les pages de l'interface se chargent, mais toutes les
  données (/api, /mcp) exigent une session ouverte avec le mot de passe. Sans mot de passe défini, l'accès à distance
  est fermé.
- Mot de passe : haché (PBKDF2-SHA256, sel aléatoire) dans DATA/auth.json, jamais en clair. Sessions : jeton aléatoire
  dans un cookie HttpOnly / Secure / SameSite=Lax, valable 30 jours. Trop d'essais ratés depuis une adresse : blocage."""
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
_fails = {}                     # ip -> [instants des échecs]
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
    if len(pw or '') < 8: raise ValueError('8 caractères minimum')
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, ITER)
    with _lock:
        d = _load()
        d.update(hash=h.hex(), salt=salt.hex(), sessions={})       # changer le mot de passe déconnecte tout le monde
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
    """requête venue du Mac lui-même, sans passer par un proxy (Tailscale Serve / Funnel ajoutent des en-têtes)"""
    host = (req.headers.get('host') or '').rsplit(':', 1)[0].strip('[]')
    client = req.client.host if req.client else ''
    proxied = any(h in req.headers for h in ('x-forwarded-for', 'x-forwarded-host', 'tailscale-user-login', 'tailscale-funnel-request', 'forwarded'))
    return host in ('127.0.0.1', 'localhost', '::1') and client in ('127.0.0.1', '::1') and not proxied


def client_ip(req):
    return (req.headers.get('x-forwarded-for') or (req.client.host if req.client else '')).split(',')[0].strip()
