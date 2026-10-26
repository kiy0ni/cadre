"""Interchange with other editing software: the Cadre timeline as Final Cut Pro 7 XML ("xmeml"), the format that
Premiere Pro and DaVinci Resolve import (File › Import), Final Cut Pro X via Resolve or a converter.

What carries over: V1 shots (with silence cuts and speed), gaps, full-screen media, video / image overlays from the
free tracks, shot audio and audio clips (music, sound effects, voice), markers and chapters. What stays in Cadre:
subtitles, title cards, effects, color grading, animated titles (they are listed as markers so they can be found)."""
import os
from urllib.parse import quote
from xml.sax.saxutils import escape
from . import store
from .ai import tools as T


def _segments(p):
    """V1 -> [(type, src_or_path, in_s, out_s, start_s, end_s, speed, name)] in seconds, + markers (t, name)"""
    ctx = T.Ctx(p)
    st = ctx.style()
    segs, marks, t = [], [], 0.0
    for it in p.get('timeline', []):
        t += float(it.get('before') or 0)
        if it['type'] == 'clip':
            if it.get('label'): marks.append((t, it['label']))
            parts = T.speed_parts(it, T.pieces(it, ctx.words(it['src']), st), st.get('baseSpeed', 1.0))
            for a, b, k in parts:
                d = (b - a) / k
                segs.append(('src', it['src'], a, b, t, t + d, k, it.get('label') or '', not it.get('audioOff')))
                t += d
        elif it['type'] == 'media':
            d = float(it.get('dur') or 0)
            segs.append(('file', it.get('path') or '', 0.0, d, t, t + d, 1.0, os.path.basename(it.get('path') or 'media'), False))
            t += d
        else:
            d = float(it.get('dur') or 0)
            marks.append((t, f"{'title card' if it['type'] == 'card' else 'freeze frame'}: {(it.get('text') or '').splitlines()[0] if it.get('text') else ''}".strip(' :')))
            t += d
    return segs, marks, t


def fcp7_xml(p):
    fps = float(p['format']['fps'])
    tb = int(round(fps))
    ntsc = 'TRUE' if abs(fps - round(fps)) > 0.01 else 'FALSE'
    F = lambda s: int(round(s * fps))
    rate = f'<rate><timebase>{tb}</timebase><ntsc>{ntsc}</ntsc></rate>'
    srcs = {s['id']: s for s in p.get('sources', [])}
    files, n = {}, [0]

    def file_el(path, dur_s, kind='video', has_audio=True):
        """first time: the full definition; afterwards: a plain reference"""
        if path in files: return f'<file id="{files[path]}"/>'
        fid = files[path] = f'file-{len(files) + 1}'
        url = 'file://localhost' + quote(os.path.abspath(path))
        media = ('<video/>' if kind in ('video', 'image') else '') + ('<audio><channelcount>2</channelcount></audio>' if has_audio else '')
        return (f'<file id="{fid}"><name>{escape(os.path.basename(path))}</name><pathurl>{escape(url)}</pathurl>{rate}'
                f'<duration>{F(dur_s or 1)}</duration><media>{media}</media></file>')

    def clip(name, path, dur_s, a, b, start, end, speed=1.0, kind='video', has_audio=True, level_db=None):
        n[0] += 1
        sp = '' if abs(speed - 1) < 1e-3 else (
            '<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory>'
            '<effecttype>motion</effecttype><mediatype>video</mediatype>'
            f'<parameter><parameterid>speed</parameterid><name>speed</name><value>{speed * 100:.2f}</value></parameter></effect></filter>')
        lv = '' if level_db is None else (
            '<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effecttype>audiolevels</effecttype>'
            f'<mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>{10 ** (level_db / 20):.4f}</value>'
            '</parameter></effect></filter>')
        return (f'<clipitem id="clipitem-{n[0]}"><name>{escape(name)}</name><enabled>TRUE</enabled><duration>{F(dur_s or (b - a))}</duration>{rate}'
                f'<start>{F(start)}</start><end>{F(end)}</end><in>{F(a)}</in><out>{F(b)}</out>'
                f'{file_el(path, dur_s, kind, has_audio)}{sp}{lv}</clipitem>')

    segs, marks, total = _segments(p)
    v1, a1 = [], []
    for kind, ref, a, b, s0, s1, k, label, with_audio in segs:
        if kind == 'src':
            s = srcs.get(ref)
            if not s: continue
            name = label or s['name']
            if s['kind'] != 'audio': v1.append(clip(name, s['path'], s.get('duration'), a, b, s0, s1, k, 'video', s.get('hasAudio', True)))
            if with_audio and (s['kind'] == 'audio' or s.get('hasAudio', True)): a1.append(clip(name, s['path'], s.get('duration'), a, b, s0, s1, k, 'audio'))
        elif ref:
            v1.append(clip(label, ref, b, a, b, s0, s1, 1.0, 'video', False))

    vtracks, atracks = ['<track>' + ''.join(v1) + '</track>'], ['<track>' + ''.join(a1) + '</track>']
    texts = []
    tracks = p.get('tracks', [])
    for tr in reversed([t for t in tracks if t['kind'] == 'video']):            # lowest first (V2, V3…)
        items = []
        for c in sorted(tr['clips'], key=lambda c: c['start']):
            path = c.get('path') or (srcs[c['src']]['path'] if c.get('src') in srcs else '')
            if not path: continue
            dur = srcs[c['src']].get('duration') if c.get('src') in srcs else (c['dur'] if c.get('kind') == 'image' else None)
            sp = float(c.get('speed') or 1)
            items.append(clip(c.get('name') or os.path.basename(path), path, dur or c['in'] + c['dur'] * sp, c['in'], c['in'] + c['dur'] * sp,
                              c['start'], c['start'] + c['dur'], sp, c.get('kind', 'video'), False))
            total = max(total, c['start'] + c['dur'])
        if items: vtracks.append('<track>' + ''.join(items) + '</track>')
    for tr in [t for t in tracks if t['kind'] == 'audio']:
        items = []
        for c in sorted(tr['clips'], key=lambda c: c['start']):
            path = c.get('path') or (srcs[c['src']]['path'] if c.get('src') in srcs else '')
            if not path or not os.path.exists(path): continue
            dur = srcs[c['src']].get('duration') if c.get('src') in srcs else None
            sp = float(c.get('speed') or 1)
            items.append(clip(c.get('name') or os.path.basename(path), path, dur or c['in'] + c['dur'] * sp, c['in'], c['in'] + c['dur'] * sp,
                              c['start'], c['start'] + c['dur'], sp, 'audio', True, float(c.get('volumeDb') or 0) + float(tr.get('volumeDb') or 0)))
            total = max(total, c['start'] + c['dur'])
        if items: atracks.append('<track>' + ''.join(items) + '</track>')
    for tr in tracks:
        if tr['kind'] == 'text':
            for c in tr['clips']: texts.append((c['start'], f"title: {c.get('text', '')[:60]}"))

    allmarks = sorted(marks + texts + [(m['t'], m.get('label') or 'marker') for m in p.get('markers', [])])
    mk = ''.join(f'<marker><name>{escape(lbl)}</name><in>{F(t)}</in><out>-1</out></marker>' for t, lbl in allmarks)
    w, h = p['format']['width'], p['format']['height']
    fmt = (f'<format><samplecharacteristics>{rate}<width>{w}</width><height>{h}</height>'
           '<pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>')
    name = escape(p.get('title') or p['name'])
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">'
            f'<sequence id="sequence-1"><name>{name}</name><duration>{F(total)}</duration>{rate}'
            f'<timecode>{rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>'
            f'<media><video>{fmt}{"".join(vtracks)}</video><audio>{"".join(atracks)}</audio></media>{mk}</sequence></xmeml>\n')


def export_xml(p):
    import re, shutil, time
    d = f'{store.pdir(p["id"])}/renders'
    os.makedirs(d, exist_ok=True)
    name = re.sub(r'[^\w-]+', '_', (p.get('title') or p['name']))[:60].strip('_') or 'edit'
    out = f'{d}/{name}_{time.strftime("%Y%m%d-%H%M")}.xml'
    open(out, 'w', encoding='utf-8').write(fcp7_xml(p))
    copy_to = ((store.settings().get('export') or {}).get('copyTo') or '').strip()
    if copy_to:
        try:
            os.makedirs(os.path.expanduser(copy_to), exist_ok=True)
            shutil.copy2(out, os.path.join(os.path.expanduser(copy_to), os.path.basename(out)))
        except OSError: pass
    return out
