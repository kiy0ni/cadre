# Cadre

**A video editor with an AI assistant built in.** Drop in your footage, describe the video you want, and watch the
assistant build the edit on a real multitrack timeline: selects, cuts, captions, pacing, sound design, titles,
transitions, color. Then take over. Everything the AI did is a normal clip, effect or setting you can move, trim,
tweak or undo.

macOS (Apple Silicon and Intel) and Windows 10/11 x64 · interface in English, French, Spanish, German, Italian,
Portuguese and Japanese.

- **AI-first, never a black box.** The assistant lays out its plan as a checklist, works step by step while the
  timeline builds in front of you, explains its choices in the inspector and ends each turn with a summary of what
  changed. Every turn can be rewound, and ⌘Z works too.
- **A real editor.** Source and program monitors, a magnetic main storyline with free placement and gaps, video, title
  and audio tracks, J/K/L, ripple and lift, linked and unlinked audio for J- and L-cuts, a color page with scopes, a
  mixer, stackable effects with presets, transitions, titles, markers.
- **Local by default.** Transcription runs on your machine (Whisper). Your media files never leave your computer.
- **No lock-in.** Export the edit as XML for Premiere Pro or DaVinci Resolve, captions as SRT, video as H.264, HEVC,
  ProRes, 4K or WAV.

## Install

When a version is tagged, installers are attached to the [Releases](../../releases) page:

| System | File | How |
|---|---|---|
| Mac, Apple Silicon (M1 and later) | `Cadre-mac-apple-silicon.dmg` | Open it, drag Cadre to Applications. |
| Mac, Intel | `Cadre-mac-intel.dmg` | Same. |
| Windows 10/11 | `Cadre-Setup-x64.exe` (or `Cadre-win-x64.zip`) | Run the installer (or unzip and start `Cadre.exe`). |

Builds are not code-signed yet, so the first launch asks for confirmation. On macOS: System Settings › Privacy &
Security › "Open Anyway". On Windows: SmartScreen › "More info" › "Run anyway". You can also build from source (see
[Development](#development)).

On first launch Cadre sets up its engine by itself (Python and its components; a few minutes, once). There is nothing
else to install. Manual editing works without AI. For the assistant, either sign in to
[Claude Code](https://claude.com/claude-code) once (Claude subscription) or set an Anthropic API key in
`ANTHROPIC_API_KEY`.

## Using Cadre

1. **New project** (⌘N). Drop your media or paste a link (YouTube, Twitch…). Then describe what the AI should make, or
   pick a recipe (gaming best-of, vertical gaming clip, vlog, short, interview, tutorial, music edit). Set target
   length, captions, music, format and editing style. **Create and edit with AI** imports the media, waits for
   transcription (shown step by step with real progress) and lets the assistant build the edit. Without a request,
   the project opens ready for manual editing.
2. **Assistant** (⌘K). Type `/` for ready-made commands (full edit, tighten pacing, shorten, check captions, color,
   titles…) or ask anything: "cut it down to 8 minutes", "warmer grade", "add lower thirds with the speakers' names",
   "do it like this video: <link>". Modes: *Auto*, *Ask* (approve each change) and *Plan* (proposes without touching
   anything). Right-click a clip › *Ask the AI about this shot…* for a targeted fix.
3. **Edit by hand** in the Edit, Color, Audio and Export workspaces. All shortcuts are listed in Settings › Keyboard
   shortcuts.

**Editing styles** combine written rules the assistant follows with render settings (captions, pacing, framing,
sound). Built in: Dynamic YouTube, Gaming, Vertical gaming clip, Short / Reel / TikTok, Podcast, Tutorial, Cinematic
and Minimal. *New style › Describe the style* lets the AI write a style from a description and, optionally, a
reference video.

**Reference videos.** Give the assistant a link or a file ("make it like …"). It opens it, looks at the frames, reads
the speech and recognizes which sounds and music from your library are used, and when, so it can reproduce them.

**Timeline essentials.** Drag from any panel onto any track. Everything moves and trims: shots, overlays, titles,
music, sound effects, captions and effect markers. On V1, drag a shot freely (a gap opens before it), ⌘-drag to
insert it between two shots, or drag it onto a video track to turn it into an overlay (and back). ⌥-drag duplicates,
Esc cancels the current drag, Q / W trim to the playhead, ⇧Delete lifts, ⌘L unlinks or relinks audio.

**Effects.** Two-keyframe motion (Ken Burns), fades, mirror, blur, sharpen, pixelate, glow, grain, chromatic
aberration, B&W, sepia, hue, invert, letterbox, rounded corners, border and drop shadow, all stackable and
reorderable. Save any setup to *My effects* and reapply it with a click or by drag and drop.

**People.** Per-speaker caption color, notes for the assistant and an optional voiceprint for speaker recognition
(the voices module, about 2 GB, installed from Settings).

**Libraries** (Settings). Folders of music, sound effects and visuals that Cadre indexes and the assistant uses.

**Remote access** (optional). From any device other than the computer running Cadre, a password is always required
(Settings › Remote access; stored as a salted PBKDF2 hash, 30-day sessions, lockout after repeated failures). Without
a password, remote access is closed. With [Tailscale](https://tailscale.com), run
`tailscale serve --bg http://127.0.0.1:8765` for your own devices, or `tailscale funnel --bg http://127.0.0.1:8765` to
reach it from any browser (still behind the password).

## Privacy

Transcription, speaker recognition, previews and rendering run locally. When you use the assistant, the project
description (timeline, transcripts, settings) and the frames it chooses to look at are sent to Anthropic, through your
Claude Code session or your API key. Your media files themselves are never uploaded.

## Development

```
engine/    Python engine (FastAPI): projects, media, transcription, voices, AI tools, rendering     uv
web/       React UI + Remotion composition (the same code renders the preview and the export)       pnpm
desktop/   Electron shell: starts the engine, window and menus, self-contained installers           pnpm
```

Requirements: [uv](https://docs.astral.sh/uv/), Node 22+ and [pnpm](https://pnpm.io). FFmpeg is downloaded
automatically.

```sh
cd engine && uv sync                             # add --extra voix for speaker recognition / stem separation
cd web && pnpm install && pnpm build             # the engine serves the built UI
cd engine && uv run python -m cadre_engine.run   # http://127.0.0.1:8765
cd web && pnpm dev                               # live UI (Vite) against the running engine
```

Desktop app (`desktop/`, after `pnpm install`):

- `pnpm package`: Cadre.app linked to this checkout (uses `engine/.venv`), installed in /Applications.
- `pnpm dist:mac`, `pnpm dist:mac-intel`: self-contained disk images in `desktop/dist/`.
- `pnpm dist:win`: on Windows with Inno Setup, `Cadre-Setup-x64.exe`; elsewhere, a zip.

Translations live in `web/src/lib/locales/*.json`. UI strings are written in French in the source (`tx('…')`) and
that text is the translation key. `node web/scripts/i18n.mjs` lists missing translations.

### Architecture

- A project is a JSON document (`engine/cadre_engine/store.py`, types in `web/src/types.ts`). Shot times are in
  **source** seconds. `web/src/remotion/resolve.ts` resolves everything (silence cuts, speed, gaps, captions,
  effects, tracks) to output frames: one pure function shared by the timeline, the live preview and the final render.
- The assistant (`engine/cadre_engine/ai/`) works through about 40 tools (`tools.py`) that edit the project, and each
  change is pushed to the UI live. It can look at frames (`regarder`, `regarder_montage`) and analyze reference videos
  (`refs.py`). Two providers: the Anthropic API, or Claude Code (`claude -p`) with a small MCP server exposed by the
  engine. Tool names are French identifiers, kept for compatibility with saved conversations.
- Preview: Remotion Player on lightweight proxies, with the playhead driven outside React. Export: the same
  composition rendered by `web/scripts/render.mjs` on the original files, then loudness-normalized to the style's
  target.

### Releases and signing

`.github/workflows/release.yml` builds the three installers for every pushed `v*` tag and attaches them to a GitHub
Release. Signing is optional and driven by repository secrets:

- **macOS** (Developer ID): `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `MAC_SIGN_ID`, plus `APPLE_ID`,
  `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD` for notarization. Locally, set `CADRE_SIGN_ID` and `APPLE_*` before
  `pnpm dist:mac`.
- **Windows** (OV/EV certificate or Azure Trusted Signing): set `CADRE_WIN_CERT` (.pfx) and `CADRE_WIN_CERT_PASSWORD`
  before `pnpm dist:win`.

Data lives in `~/Library/Application Support/Cadre` (macOS) or `%APPDATA%\Cadre` (Windows): projects, styles, people,
caches and the engine environment. Log: `~/Library/Logs/Cadre/cadre.log`.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Sacha Pastor
