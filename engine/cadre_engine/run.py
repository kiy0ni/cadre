"""Lance le moteur sur 127.0.0.1, et aussi sur l'adresse Tailscale de la machine si elle en a une (accès à distance
depuis ses propres appareils, jamais depuis le réseau local ni Internet).

    uv run python -m cadre_engine.run"""
import os
import re
import socket
import subprocess
import sys
import threading
import time
import uvicorn
from .config import PORT


def tailscale_ip():
    """adresse Tailscale (100.64.0.0/10) lue sur les interfaces réseau"""
    try:
        if sys.platform == 'win32':
            out = subprocess.run(['ipconfig'], capture_output=True, text=True, timeout=10).stdout
            pat = r'(100\.(\d+)\.\d+\.\d+)'
        else:
            out = subprocess.run(['/sbin/ifconfig'], capture_output=True, text=True, timeout=10).stdout
            pat = r'inet (100\.(\d+)\.\d+\.\d+)'
    except (OSError, subprocess.TimeoutExpired):
        return None
    for m in re.finditer(pat, out):
        if 64 <= int(m.group(2)) <= 127: return m.group(1)
    return None


def bind(host):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, PORT))
    return s


def main():
    socks = [bind('127.0.0.1')]
    ip = tailscale_ip()
    if ip:
        try:
            socks.append(bind(ip)); print(f'Tailscale : http://{ip}:{PORT}', flush=True)
        except OSError as e:
            print(f'adresse Tailscale {ip} indisponible : {e}', flush=True); ip = None
    if not ip:
        def watch():
            while True:
                time.sleep(30)
                if tailscale_ip():
                    print('Tailscale connecté : redémarrage', flush=True); os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    from .main import app
    uvicorn.Server(uvicorn.Config(app, log_level='warning', timeout_graceful_shutdown=2)).run(sockets=socks)


if __name__ == '__main__':
    sys.exit(main())
