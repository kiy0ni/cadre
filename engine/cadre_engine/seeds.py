"""Données de départ : styles intégrés copiés dans le dossier de l'utilisateur (une seule fois, modifiables ensuite)."""
import json
import os
from .config import BUILTIN_STYLES, STYLES


def seed():
    for f in sorted(os.listdir(BUILTIN_STYLES)):
        if f.endswith('.json') and not os.path.exists(os.path.join(STYLES, f)):
            data = json.load(open(os.path.join(BUILTIN_STYLES, f)))
            json.dump(data, open(os.path.join(STYLES, f), 'w'), ensure_ascii=False, indent=1)
