# Cadre

Logiciel de montage vidéo avec un assistant IA intégré. On importe ses rushs, on choisit un style de montage :
l'assistant monte (dérushage, plans, sous-titres, rythme, habillage sonore, titres, transitions, étalonnage), et tout
reste modifiable à la main dans une interface de montage classique (moniteurs source / programme, timeline multipiste,
propriétés, couleur avec scopes, table de mixage, export).

macOS (Apple Silicon / Intel) et Windows 10/11 x64.

## Installer

| Système | Fichier | Installation |
|---|---|---|
| Mac Apple Silicon (M1…M4) | `Cadre-mac-apple-silicon.dmg` | Ouvrir, glisser Cadre dans Applications. |
| Mac Intel | `Cadre-mac-intel.dmg` | Idem. |
| Windows 10/11 | `Cadre-Setup-x64.exe` (fabriqué sur Windows) ou `Cadre-win-x64.zip` | Installateur : suivant, suivant. Zip : dézipper, lancer `Cadre.exe`. |

Sans signature (voir Distribution), la première ouverture demande une confirmation : Mac → Réglages Système ›
Confidentialité et sécurité › « Ouvrir quand même » ; Windows → SmartScreen › « Informations complémentaires » ›
« Exécuter quand même ».

Au premier lancement, Cadre installe tout seul son moteur (Python et ses composants, quelques minutes, une seule fois).
Rien d'autre à installer. Pour l'assistant : **Claude Code** connecté une fois (abonnement Claude), ou une clé d'API
Anthropic dans la variable `ANTHROPIC_API_KEY`. Le montage manuel fonctionne sans IA.

## Utiliser

1. **Nouveau projet** : un nom, un style de montage (YouTube, Short/TikTok, Podcast, Tutoriel, Cinématique, Sobre, ou un
   style à soi), un format (16:9, 9:16, 1:1, 4:5).
2. **Importer** les médias (fichiers, glisser-déposer, lien YouTube/Twitch). Cadre crée une copie allégée pour un aperçu
   fluide et transcrit la parole.
3. **Assistant** (⌘K) : « /monter », ou n'importe quelle demande (« raccourcis à 8 minutes », « étalonne en plus chaud »,
   « ajoute le nom des intervenants »). Modes : Auto, Demander (validation de chaque modification), Plan (propose sans
   toucher). Chaque message peut être annulé (« Revenir ici ») ; ⌘Z annule aussi tout ce qu'a fait l'assistant.
4. **Retoucher** : espaces Montage, Couleur, Audio, Export. Raccourcis dans Réglages › Raccourcis clavier.

**Styles de montage** : des règles écrites que l'assistant suit + des réglages (sous-titres, rythme, cadrage, son).
« Nouveau style › Décrire le style » : on décrit le montage voulu (et, en option, une vidéo de référence) ; l'IA écrit
les règles et règle les valeurs.

**Effets** (panneau Effets, ou Propriétés › Effets › Ajouter) : mouvement à deux images clés (Ken Burns), fondus,
miroir, flou, netteté, pixellisation, lueur, grain, aberration chromatique, N&B, sépia, teinte, négatif, bandes cinéma,
coins arrondis, bordure, ombre portée ; empilables, réglables, activables, réordonnables. Looks de couleur,
accentuations ponctuelles (zoom, secousse, flash, ralenti, accéléré, bip), transitions, titres. Un réglage réussi
s'enregistre dans **Mes effets** (bouton ↓ du groupe Effets) et se réapplique d'un clic ou par glisser-déposer.

**Langues** : français, anglais, espagnol, allemand, italien, portugais, japonais (Réglages › Général). L'assistant
répond dans la langue choisie. Ajouter ou compléter une langue : `node web/scripts/i18n.mjs` liste les textes manquants
(dictionnaires dans `web/src/lib/locales/*.json`, clé = texte français).

**Timeline** : glisser-déposer depuis les panneaux sur n'importe quelle piste, y compris A1 Voix, A2 Musique et
A3 Bruitages ; déplacer, rogner, ⌥ + glisser pour dupliquer, Échap pour annuler le geste en cours ; plans V1 réordonnés
en les glissant ; clic droit pour couper, copier, coller (⌘C / ⌘X / ⌘V), dupliquer, couper le son, supprimer.

**Vidéo d'exemple** : donne un lien ou un fichier à l'assistant (« fais comme dans … ») ; il l'ouvre, voit ses images,
lit ses paroles et reconnaît les sons et musiques de ta bibliothèque utilisés (instants, position dans le morceau)
pour les reproduire.

**Personnes** : couleur de sous-titres, consignes, empreinte vocale (reconnaissance de qui parle ; module « voix »
à installer depuis Réglages, ~2 Go).

**Bibliothèques** (Réglages) : dossiers de musiques, sons, visuels réutilisables ; Cadre les classe et l'assistant s'en sert.

**Accès à distance** : le moteur écoute aussi sur l'adresse Tailscale de la machine (jamais sur Internet ni le réseau local).

## Développement

```
engine/    moteur Python (FastAPI) : projets, médias, transcription, voix, IA, rendu      uv
web/       interface React + composition Remotion (même code pour l'aperçu et le rendu)   pnpm
desktop/   appli Electron : lance le moteur, fenêtre, menus, installation autonome         pnpm
```

```sh
cd engine && uv sync                       # (+ --extra voix pour la reconnaissance des voix)
cd web && pnpm install && pnpm build       # interface servie par le moteur
cd engine && uv run python -m cadre_engine.run       # http://127.0.0.1:8765
cd web && pnpm dev                         # interface en direct (Vite), moteur à côté
```

Appli de bureau (`desktop/`) :

- `pnpm package` : Cadre.app liée à ce dépôt (utilise `engine/.venv`), installée dans /Applications ;
- `pnpm dist:mac`, `pnpm dist:mac-intel` : images disque autonomes (`desktop/dist/*.dmg`) ;
- `pnpm dist:win` : sur Windows avec Inno Setup → `Cadre-Setup-x64.exe` ; ailleurs → zip.

## Distribution

- **Automatique** : `.github/workflows/release.yml` fabrique les 3 installateurs (Mac Apple Silicon, Mac Intel, Windows)
  à chaque étiquette `v*` poussée sur GitHub et les publie dans une Release (page de téléchargement).
- **Signature Mac** (supprime l'avertissement) : compte Apple Developer (99 $/an), certificat « Developer ID
  Application ». Secrets : `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `MAC_SIGN_ID` (nom du certificat), puis pour la
  notarisation `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` (mot de passe d'application). En local : variables
  `CADRE_SIGN_ID`, `APPLE_*` avant `pnpm dist:mac`.
- **Signature Windows** (supprime SmartScreen) : certificat de signature de code (OV/EV, ou Azure Trusted Signing) ;
  `CADRE_WIN_CERT` (fichier .pfx) et `CADRE_WIN_CERT_PASSWORD` avant `pnpm dist:win`.
- Taille : ~175 Mo à télécharger, puis ~1 Go installé au premier lancement (Python, transcription).

Données : `~/Library/Application Support/Cadre` (macOS), `%APPDATA%\Cadre` (Windows) : projets, styles, personnes,
caches, environnement du moteur. Journal : `~/Library/Logs/Cadre/cadre.log`.

Points d'architecture :

- Le projet est un JSON (`engine/cadre_engine/store.py`, types dans `web/src/types.ts`). Les temps des plans sont en
  secondes **source** ; `web/src/remotion/resolve.ts` calcule tout en images de sortie (coupes des silences, vitesse,
  sous-titres, effets, musique, pistes).
- L'assistant (`engine/cadre_engine/ai/`) appelle des outils (`tools.py`) qui modifient le projet ; chaque modification
  est poussée à l'interface en direct. Il voit les images (`regarder`, `regarder_montage`). Deux accès : API Anthropic,
  ou Claude Code (`claude -p`) avec un petit serveur MCP exposé par le moteur.
- Aperçu : Remotion Player sur les copies allégées ; la tête de lecture est déplacée hors de React (pas de rendu de
  l'interface à chaque image). Export : la même composition rendue par `web/scripts/render.mjs` sur les fichiers
  d'origine, puis son normalisé au niveau du style (LUFS).
