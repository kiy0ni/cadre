import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, followJob } from '../lib/api';
import { fmt } from '../lib/format';
import { uid, useStore } from '../lib/store';
import type { ClipItem, Word } from '../types';
import { srcToFrame } from '../remotion/resolve';
import { useComp } from './comp';
import { Icon } from '../lib/icons';
import { tx } from '../lib/i18n';

interface Line { i0: number; i1: number; t: number; spk: string | null }

function lines(ws: Word[]): Line[] {
  const out: Line[] = [];
  let cur: Line | null = null;
  ws.forEach((w, i) => {
    const spk = w[4] ?? null;
    const prev = ws[i - 1];
    const brk = !cur || spk !== cur.spk || w[0] - cur.t > 7 || (prev && w[0] - prev[1] > 1.2) || (prev && /[.?!]$/.test(prev[2].trim()) && w[0] - cur.t > 3);
    if (brk) { cur = { i0: i, i1: i, t: w[0], spk }; out.push(cur); }
    else if (cur) cur.i1 = i;
  });
  return out;
}

export function TranscriptPanel({ srcId, setSrcId }: { srcId: string | null; setSrcId: (s: string) => void }) {
  const { props, r } = useComp();
  const project = props.project;
  const words = useStore((s) => s.words);
  const speakers = useStore((s) => s.speakers);
  const update = useStore((s) => s.update);
  const setWords = useStore((s) => s.setWords);
  const seek = useStore((s) => s.seek);
  const sel = useStore((s) => s.sel);
  const notify = useStore((s) => s.notify);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [q, setQ] = useState('');
  const [moments, setMoments] = useState<Awaited<ReturnType<typeof api.moments>> | null>(null);
  const [now, setNow] = useState(-1);
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);

  const sources = project.sources.filter((s) => s.kind !== 'image');
  const src = sources.find((s) => s.id === srcId) || sources[0];
  const ws = useMemo(() => (src ? words[src.id] || [] : []), [src, words]);
  const ls = useMemo(() => lines(ws), [ws]);
  const used = useMemo(() => project.timeline.filter((i): i is ClipItem => i.type === 'clip' && i.src === src?.id).map((c) => [c.in, c.out] as const), [project.timeline, src]);
  const spk = (id: string | null | undefined) => speakers.find((s) => s.id === (id || project.defaultSpeaker));
  const projSpeakers = speakers.filter((s) => project.speakers.includes(s.id));

  useEffect(() => { setRange(null); setMoments(null); }, [src?.id]);

  const onTime = () => {
    const v = video.current;
    if (!v) return;
    const t = v.currentTime;
    if (stopAt.current !== null && t >= stopAt.current) { v.pause(); stopAt.current = null; }
    let lo = 0; let hi = ws.length - 1; let found = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ws[m][0] <= t) { found = m; lo = m + 1; } else hi = m - 1; }
    setNow(found >= 0 && t <= ws[found][1] + 0.3 ? found : -1);
  };
  const playFrom = (t: number, until?: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    stopAt.current = until ?? null;
    v.play().catch(() => undefined);
  };

  const clickWord = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && range) setRange([Math.min(range[0], i), Math.max(range[1], i)]);
    else setRange([i, i]);
    const v = video.current;
    if (v) { v.currentTime = ws[i][0]; }
    // if the word is inside a timeline shot, the playhead moves there too
    const clip = project.timeline.find((it): it is ClipItem => it.type === 'clip' && it.src === src!.id && ws[i][0] >= it.in && ws[i][0] <= it.out);
    if (clip) { const f = srcToFrame(r, clip.id, ws[i][0]); if (f !== null) seek(f); }
  };

  if (!src) return <div className="pad"><p className="muted small">{tx('Importe un média pour voir ses paroles.')}</p></div>;

  const a = range ? ws[range[0]][0] : 0;
  const b = range ? ws[range[1]][1] : 0;
  const addClip = () => {
    if (!range) return;
    const c: ClipItem = { id: uid('i'), type: 'clip', src: src.id, in: Math.max(0, a - 0.25), out: Math.min(src.duration, b + 0.35), label: '', jump: null, speed: 1, captions: [], fx: [] };
    api.autoCaptions(project.id, { src: src.id, in: c.in, out: c.out }).then((caps) => {
      update((p) => {
        c.captions = caps;
        const j = p.timeline.findIndex((x) => x.id === sel.itemId);
        if (j >= 0) p.timeline.splice(j + 1, 0, c); else p.timeline.push(c);
      });
      notify(tx('Plan ajouté ({0} s, {1} sous-titres)', fmt(c.out - c.in, 1), caps.length));
    });
  };
  const assign = (id: string) => {
    if (!range) return;
    const next = ws.map((w, i) => (i >= range[0] && i <= range[1] ? ([w[0], w[1], w[2], w[3], id === project.defaultSpeaker ? null : id] as Word) : w));
    setWords(src.id, next);
  };
  const enroll = async (id: string) => {
    if (!range) return;
    if (b - a < 1.5) { notify(tx('Sélectionne au moins 2 secondes où cette personne parle seule.')); return; }
    const { job } = await api.enroll(id, { project: project.id, source: src.id, t0: a, t1: b });
    const j = await followJob(job);
    if (j.status === 'error') notify(j.error || tx('erreur'));
    else { notify(tx('Voix apprise : {0} extraits ajoutés à {1}', (j.result as { windows: number }).windows, spk(id)?.name || '')); useStore.getState().setSpeakers(await api.speakers()); }
  };
  const fix = () => {
    if (!range) return;
    const old = ws.slice(range[0], range[1] + 1).map((w) => w[2].trim()).join(' ');
    const txt = prompt(tx('Corriger le texte (même nombre de mots = même timing) :'), old);
    if (txt === null || txt.trim() === old) return;
    const nw = txt.trim().split(/\s+/);
    const seg = ws.slice(range[0], range[1] + 1);
    let rep: Word[];
    if (nw.length === seg.length) rep = seg.map((w, i) => [w[0], w[1], ' ' + nw[i], 1, w[4] ?? null]);
    else {
      const t0 = seg[0][0]; const t1 = seg[seg.length - 1][1]; const d = (t1 - t0) / nw.length;
      rep = nw.map((x, i) => [t0 + i * d, t0 + (i + 1) * d, ' ' + x, 1, seg[0][4] ?? null]);
    }
    setWords(src.id, [...ws.slice(0, range[0]), ...rep, ...ws.slice(range[1] + 1)]);
    setRange([range[0], range[0] + rep.length - 1]);
  };

  const ql = q.trim().toLowerCase();
  return (
    <div className="col" style={{ gap: 0, flex: 1, minHeight: 0 }}>
      <div className="toolbar">
        <select className="input" style={{ maxWidth: 200 }} value={src.id} onChange={(e) => setSrcId(e.target.value)}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('Rechercher')} />
        <button className={`btn sm ${moments ? 'on' : 'ghost'}`} onClick={async () => setMoments(moments ? null : await api.moments(project.id, src.id))} title={tx('Passages où il se passe le plus de choses')}>{tx('Temps forts')}</button>
      </div>
      <div className="pbody pad" style={{ gap: 8 }}>
        {src.kind === 'video' ? (
          <video ref={video} src={src.proxy || src.url} controls preload="metadata" onTimeUpdate={onTime} style={{ width: '100%', borderRadius: 4, background: 'black', maxHeight: 150 }} />
        ) : <audio ref={video as unknown as React.RefObject<HTMLAudioElement>} src={src.url} controls onTimeUpdate={onTime} style={{ width: '100%' }} />}
        {range ? (
          <div className="col" style={{ gap: 6, padding: 8, position: 'sticky', top: -10, zIndex: 2, background: 'var(--panel-2)', border: '1px solid var(--border-2)', borderRadius: 5 }}>
            <div className="row small"><b className="mono">{fmt(a, 1)} → {fmt(b, 1)}</b><span className="muted">{(b - a).toFixed(1)} s · {tx('{0} mots', range[1] - range[0] + 1)}</span><span className="spacer" />
              <button className="btn icon sm ghost" onClick={() => setRange(null)}><Icon name="x" size={11} /></button></div>
            <div className="row wrap" style={{ gap: 4 }}>
              <button className="btn sm" onClick={() => playFrom(a, b + 0.3)}><Icon name="play" size={10} /> {tx('Écouter')}</button>
              <button className="btn sm primary" onClick={addClip}>{tx('Ajouter au montage')}</button>
              <button className="btn sm" onClick={fix}>{tx('Corriger le texte')}</button>
            </div>
            {projSpeakers.length ? (
              <div className="row wrap" style={{ gap: 4 }}>
                <span className="small muted">{tx('Qui parle')}</span>
                {projSpeakers.map((s) => (
                  <button key={s.id} className="btn sm" onClick={() => assign(s.id)} title={tx('Attribuer à {0}', s.name)}><span className="dot" style={{ background: s.color }} />{s.name}</button>
                ))}
                <span className="small muted" style={{ marginLeft: 6 }}>{tx('Apprendre la voix')}</span>
                {projSpeakers.map((s) => (
                  <button key={`e${s.id}`} className="btn sm ghost" onClick={() => enroll(s.id)} title={tx('Ce passage sert d\'exemple de la voix de {0} (elle doit parler seule)', s.name)}><Icon name="mic" size={11} />{s.name}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {moments ? (
          <div className="col" style={{ gap: 2 }}>
            {moments.map((m) => (
              <div key={m.t} className="list-item small" style={{ alignItems: 'flex-start' }} onClick={() => playFrom(m.t)}>
                <span className="mono" style={{ color: 'var(--accent-hi)' }}>{fmt(m.t, 0)}</span><span className="grow">{m.extrait}</span>
              </div>
            ))}
          </div>
        ) : null}
        {ws.length === 0 ? <p className="muted small">{src.status.transcript === 'running' ? tx('Transcription en cours…') : src.status.transcript === 'error' ? tx('La transcription a échoué.') : tx('Pas encore de transcription.')}</p> : (
          <div className="words">
            {ls.map((l) => {
              const p = spk(l.spk);
              const has = !ql || ws.slice(l.i0, l.i1 + 1).map((w) => w[2]).join('').toLowerCase().includes(ql);
              if (!has) return null;
              return (
                <div key={l.i0} className="tline" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 26px' } as React.CSSProperties}>
                  <span className="t" onClick={() => playFrom(l.t)}>{fmt(l.t, 0)}</span>
                  <span className="grow">
                    {l.spk ? <span className="dot" style={{ background: p?.color, display: 'inline-block', marginRight: 5, verticalAlign: 'middle' }} title={p?.name} /> : null}
                    {ws.slice(l.i0, l.i1 + 1).map((w, k) => {
                      const i = l.i0 + k;
                      const inUse = used.some(([x, y]) => w[0] >= x && w[1] <= y);
                      const cls = `w ${range && i >= range[0] && i <= range[1] ? 'in-sel' : ''} ${i === now ? 'now' : ''} ${w[3] < 0.5 ? 'low' : ''} ${inUse ? 'used' : ''}`;
                      return <span key={i} className={cls} onClick={(e) => clickWord(i, e)}>{w[2]}</span>;
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <span className="tiny dim">{tx('Clic : se placer · ⇧ clic : étendre la sélection · vert : déjà dans le montage · souligné : mot incertain')}</span>
      </div>
    </div>
  );
}
