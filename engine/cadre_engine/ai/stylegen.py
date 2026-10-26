"""AI-generated editing style: from a description and, optionally, a reference video (link or file) whose pacing
(shots per minute) is measured and a few of whose frames are looked at.
The AI writes the rules and sets the values (captions, pacing, framing, sound), starting from the closest style."""
import base64, json, os, re, shutil, subprocess, sys, uuid
from .. import ff, store
from ..config import CACHE
from .agent import api_credentials, provider

SCHEMA_HINT = """Reply ONLY with a JSON object (no text around it):
{
  "name": "short style name",
  "description": "one sentence shown when creating a project",
  "base": "id of the closest existing style (youtube, short, podcast, tuto, cinematique, sobre)",
  "format": {"width": 1920, "height": 1080, "fps": 30},
  "structure": "typical structure in one line",
  "language": "spoken language code (fr, en, …)",
  "rules": "editing rules in Markdown: a # title then 6 to 12 concrete, checkable bullet points",
  "style": { only the settings that differ from the base style, same keys as below }
}"""


def _reference(ref, work, job):
    """-> (path, text info, [jpeg images]); video downloaded in low quality, first 4 minutes max."""
    if re.match(r'^https?://', ref):
        job.step(0.1, 'downloading the reference…')
        cmd = [sys.executable, '-m', 'yt_dlp', '-f', 'b[height<=480]/bv*[height<=480]+ba/b', '--merge-output-format', 'mp4',
               '--download-sections', '*0-240', '--ffmpeg-location', os.path.dirname(ff.ffmpeg()),
               '-o', f'{work}/ref.%(ext)s', '--print', 'after_move:filepath', ref]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        path = next((l.strip() for l in r.stdout.splitlines() if os.path.isabs(l.strip()) and os.path.exists(l.strip())), None)
        if not path: raise RuntimeError('reference video not found or unreadable')
    else:
        path = os.path.abspath(os.path.expanduser(ref))
        if not os.path.isfile(path): raise RuntimeError('reference file not found')
    pr = json.loads(ff.probe_run(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], capture_output=True, text=True).stdout or '{}')
    v = next((s for s in pr.get('streams', []) if s.get('codec_type') == 'video'), {})
    dur = float(pr.get('format', {}).get('duration') or 0)
    span = min(dur, 240) or 240
    job.step(0.35, 'analyzing the pacing…')
    out = ff.run(['-hide_banner', '-t', str(span), '-i', path, '-vf', "select='gt(scene,0.32)',showinfo", '-an', '-f', 'null', '-'],
                 capture_output=True, text=True).stderr or ''
    cuts = len(re.findall(r'pts_time:', out))
    job.step(0.5, 'key frames…')
    images = []
    for k in range(6):
        t = span * (k + 0.5) / 6
        r = ff.run(['-v', 'error', '-ss', f'{t:.2f}', '-i', path, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', '-'],
                   capture_output=True)
        if r.stdout: images.append(r.stdout)
    w, h = int(v.get('width') or 0), int(v.get('height') or 0)
    info = (f'Reference video: {w}×{h}, {dur / 60:.1f} min in total; over the first {span / 60:.1f} minutes, {cuts} shot changes '
            f'detected, i.e. about {cuts / (span / 60):.0f} shots per minute (a shot lasts ~{span / max(1, cuts):.1f} s). '
            f'{len(images)} frames spread over this excerpt are attached.')
    return path, info, images


def _ask_api(settings, prompt, images):
    import anthropic
    client = anthropic.Anthropic()
    content = [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': base64.b64encode(im).decode()}} for im in images]
    content.append({'type': 'text', 'text': prompt})
    with client.messages.stream(model=settings['ai'].get('model') or 'claude-opus-5-5', max_tokens=16000,
                                thinking={'type': 'adaptive'}, output_config={'effort': 'medium'},
                                messages=[{'role': 'user', 'content': content}]) as s:
        msg = s.get_final_message()
    return ''.join(b.text for b in msg.content if b.type == 'text')


def _ask_cli(settings, prompt, images, work):
    files = []
    for i, im in enumerate(images):
        f = f'{work}/image_{i + 1}.jpg'
        open(f, 'wb').write(im)
        files.append(f)
    if files: prompt = f"Frames from the reference video (read them with the Read tool): {', '.join(files)}\n\n{prompt}"
    cmd = [shutil.which('claude') or 'claude', '-p', '--output-format', 'json', '--model', settings['ai'].get('cliModel') or 'opus',
           '--tools', 'Read', '--allowedTools', 'Read', '--setting-sources', 'local', '--add-dir', work]
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=work, timeout=900)
    try: ev = json.loads(r.stdout)
    except json.JSONDecodeError: raise RuntimeError('Claude Code: unreadable response ' + (r.stderr or '')[-300:])
    if ev.get('is_error'): raise RuntimeError(f"Claude Code: {ev.get('result')}")
    return ev.get('result') or ''


def _merge(base, over):
    out = json.loads(json.dumps(base))
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict): out[k] = _merge(out[k], v)
        elif k in out or k not in ('id',): out[k] = v
    return out


def generate(job, description, reference=None, name=None):
    settings = store.settings()
    pv = provider(settings)
    if not pv: raise RuntimeError("no AI connected (Settings › Artificial intelligence)")
    work = f'{CACHE}/stylegen/{uuid.uuid4().hex[:8]}'
    os.makedirs(work, exist_ok=True)
    try:
        info, images = '', []
        if reference:
            _, info, images = _reference(reference, work, job)
        packs = {p['id']: p for p in store.list_packs() if p.get('builtin')}
        example = packs.get('youtube') or next(iter(packs.values()), {})
        existing = ', '.join(f"{k} ({v.get('description', '')})" for k, v in packs.items())
        prompt = (f"You are configuring an editing style for Cadre, an AI-assisted video editor.\n"
                  f"The person's request: {description}\n" + (f"{info}\n" if info else '') +
                  f"\nExisting styles: {existing}\n"
                  f"Example of full settings (style \"{example.get('id')}\"):\n{json.dumps(example.get('style', {}), ensure_ascii=False)}\n"
                  f"Example rules:\n{example.get('rules', '')}\n\n"
                  "The rules guide an AI that edits: make them concrete (pacing, shot length, when to zoom, captions, music, "
                  "transitions, what to avoid). If a reference video is provided, match the observed pacing and look.\n\n" + SCHEMA_HINT)
        job.step(0.6, "the AI is writing the style…")
        text = _ask_api(settings, prompt, images) if pv == 'api' else _ask_cli(settings, prompt, images, work)
        m = re.search(r'\{.*\}', text, re.S)
        if not m: raise RuntimeError("the AI did not return a style")
        g = json.loads(m.group(0))
        base = packs.get(g.get('base')) or example
        pk = json.loads(json.dumps(base))
        for k in ('id', 'builtin', 'updatedAt'): pk.pop(k, None)
        pk['style'] = _merge(base.get('style', {}), g.get('style') or {})
        pk['name'] = name or g.get('name') or 'New style'
        pk['description'] = g.get('description') or description[:140]
        pk['rules'] = g.get('rules') or base.get('rules', '')
        pk['structure'] = g.get('structure') or base.get('structure', '')
        fm = g.get('format') or {}
        if fm.get('width') and fm.get('height'):
            pk['format'] = {'width': int(fm['width']), 'height': int(fm['height']), 'fps': int(fm.get('fps') or 30)}
        pk['whisper'] = {**base.get('whisper', {}), 'language': g.get('language') or base.get('whisper', {}).get('language', 'fr')}
        if reference: pk['reference'] = reference
        pk['source'] = 'ia'
        saved = store.save_pack(pk)
        job.step(1, 'style created')
        return {'id': saved['id']}
    finally:
        shutil.rmtree(work, ignore_errors=True)
