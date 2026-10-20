// Espaces de travail spécialisés : Couleur (scopes + correction), Audio (table de mixage), Export (préréglages, historique).
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type SystemInfo } from '../lib/api';
import { desktop } from '../lib/desktop';
import { ago, fmt, jobLabel, mb } from '../lib/format';
import { Icon } from '../lib/icons';
import { getFrame, useStore } from '../lib/store';
import { Seg } from '../lib/ui';
import { previewPath, thumbUrl } from '../lib/previews';
import type { ClipItem, Look, OClip, Project } from '../types';
import { colorOf, cssPreview } from '../remotion/look';
import { useComp } from './comp';
import { ColorControls, colorTarget, findRef, usePatch } from './Props';
import { startExport } from './actions';
import { getPrefs } from '../lib/prefs';
import { tx } from '../lib/i18n';

// ---------------------------------------------------------------- Couleur
/** image de la source sous la tête de lecture (vignette serveur) pour l'élément ciblé */
function frameImage(p: Project, target: Item | OClip | null, r: ReturnType<typeof useComp>['r']): string {
  if (!target) return '';
  if ('src' in target && target.src) {
    const s = p.sources.find((x) => x.id === target.src);
    if (!s) return '';
    let t = 'in' in target ? target.in || 0 : 0;
    if ((target as ClipItem).type === 'clip') {
      const f = getFrame();
      const ri = r.items.find((x) => x.id === target.id);
      const seg = ri?.segs.find((g) => f >= g.from && f < g.from + g.dur) || ri?.segs[0];
      if (seg) t = seg.a + ((Math.max(seg.from, Math.min(f, seg.from + seg.dur - 1)) - seg.from) / r.fps) * seg.rate;
    }
    return thumbUrl(previewPath(s), t, 480);
  }
  if ('path' in target && target.path) return thumbUrl(target.path, 0.5, 480);
  return '';
}
type Item = Project['timeline'][number];

export function Scopes({ src, look }: { src: string; look: Look }) {
  const [kind, setKind] = useState<'wave' | 'vector' | 'hist'>(() => { try { return (localStorage.getItem('cadre-scope') as 'wave') || 'wave'; } catch { return 'wave'; } });
  const cv = useRef<HTMLCanvasElement>(null);
  const filter = cssPreview(colorOf(look));
  useEffect(() => { try { localStorage.setItem('cadre-scope', kind); } catch { /* stockage indisponible */ } }, [kind]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const W = c.width, H = c.height;
    g.fillStyle = '#0b0c0d';
    g.fillRect(0, 0, W, H);
    if (!src) return;
    let dead = false;
    const t = setTimeout(() => {
      const img = new Image();
      img.onload = () => {
        if (dead) return;
        const w = 240, h = Math.round((img.height / img.width) * 240) || 135;
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        const o = off.getContext('2d', { willReadFrequently: true })!;
        o.filter = filter;
        o.drawImage(img, 0, 0, w, h);
        const d = o.getImageData(0, 0, w, h).data;
        g.fillStyle = '#0b0c0d';
        g.fillRect(0, 0, W, H);
        g.strokeStyle = '#26282d';
        g.lineWidth = 1;
        if (kind === 'wave') {
          for (const v of [0, 25, 50, 75, 100]) { const y = H - 6 - (v / 100) * (H - 12); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillStyle = '#4a4d55'; g.font = '9px monospace'; g.fillText(String(v), 2, y - 2); }
          const im = g.getImageData(0, 0, W, H);
          const px = im.data;
          for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            const X = Math.floor((x / w) * W), Y = Math.floor(H - 6 - (l / 255) * (H - 12));
            const k = (Y * W + X) * 4;
            px[k] = Math.min(255, px[k] + 22); px[k + 1] = Math.min(255, px[k + 1] + 60); px[k + 2] = Math.min(255, px[k + 2] + 30);
          }
          g.putImageData(im, 0, 0);
        } else if (kind === 'vector') {
          const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 8;
          g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
          g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
          g.strokeStyle = '#a8763e'; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + R * Math.cos(-2.15), cy + R * Math.sin(-2.15)); g.stroke(); // ligne des peaux
          const im = g.getImageData(0, 0, W, H);
          const px = im.data;
          for (let i = 0; i < d.length; i += 8) {
            const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
            const cb = -0.1146 * r0 - 0.3854 * g0 + 0.5 * b0, cr = 0.5 * r0 - 0.4542 * g0 - 0.0458 * b0;
            const X = Math.round(cx + (cb / 128) * R), Y = Math.round(cy - (cr / 128) * R);
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const k = (Y * W + X) * 4;
            px[k] = Math.min(255, px[k] + 40); px[k + 1] = Math.min(255, px[k + 1] + 40); px[k + 2] = Math.min(255, px[k + 2] + 40);
          }
          g.putImageData(im, 0, 0);
        } else {
          const bins = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
          for (let i = 0; i < d.length; i += 4) { bins[0][d[i]]++; bins[1][d[i + 1]]++; bins[2][d[i + 2]]++; }
          const mx = Math.max(...bins.flat().slice(2, -2)) || 1;
          g.globalCompositeOperation = 'lighter';
          ['rgba(229,83,75,.7)', 'rgba(63,185,80,.7)', 'rgba(58,130,247,.8)'].forEach((col, ch) => {
            g.fillStyle = col;
            g.beginPath(); g.moveTo(0, H);
            for (let v = 0; v < 256; v++) g.lineTo((v / 255) * W, H - Math.min(1, bins[ch][v] / mx) * (H - 6));
            g.lineTo(W, H); g.closePath(); g.fill();
          });
          g.globalCompositeOperation = 'source-over';
        }
      };
      img.src = src;
    }, 120);
    return () => { dead = true; clearTimeout(t); };
  }, [src, filter, kind]);
  return (
    <div className="col" style={{ gap: 6, flex: 1, minHeight: 0 }}>
      <Seg value={kind} onChange={setKind} options={[['wave', tx('Forme d\'onde')], ['vector', tx('Vecteurscope')], ['hist', tx('Histogramme')]]} />
      <canvas ref={cv} width={480} height={270} className="scope" style={{ aspectRatio: '16 / 9' }} />
      {!src ? <span className="tiny dim">{tx('Place la tête de lecture sur un plan.')}</span> : null}
    </div>
  );
}

export function ColorPanel() {
  const { props, r } = useComp();
  const sel = useStore((s) => s.sel);
  useStore((s) => s.frame);
  const ref = colorTarget(props.project, sel, r);
  const target = ref ? findRef(props.project, ref) : null;
  const patch = usePatch(ref);
  const look: Look = (target && 'look' in target && target.look) || {};
  const src = frameImage(props.project, target, r);
  const copyAll = useStore((s) => s.update);
  const notify = useStore((s) => s.notify);
  const name = !target ? null : 'type' in target && target.type === 'clip' ? tx('Plan {0}', props.project.timeline.findIndex((x) => x.id === target.id) + 1) : (target as { name?: string }).name || tx('Clip');
  const applyEverywhere = () => {
    if (!target || !('look' in target)) return;
    const color = structuredClone(look.color || {});
    copyAll((p) => { for (const it of p.timeline) if (it.type === 'clip' || it.type === 'media' || it.type === 'freeze') it.look = { ...(it.look || {}), color: structuredClone(color) }; });
    notify(tx('Couleur appliquée à tous les plans'));
  };
  return (
    <div className="col" style={{ gap: 0, flex: 1, minHeight: 0 }}>
      <div className="toolbar"><b style={{ paddingLeft: 4 }} className="grow ellipsis">{name || tx('Aucun plan')}</b>
        {target ? <button className="btn sm ghost" onClick={applyEverywhere} title={tx('Copier cette correction sur tous les plans du montage')}>{tx('Appliquer partout')}</button> : null}</div>
      <div className="pbody">
        <div className="pad"><Scopes src={src} look={look} /></div>
        {target && 'type' in target && target.type !== 'text' && target.type !== 'audio' && target.type !== 'card' ? <ColorControls look={look} patch={patch} thumb={src} /> : <div className="pad small dim">{tx('Sélectionne un plan ou un clip vidéo.')}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Audio
export function Mixer() {
  const { props, r } = useComp();
  const update = useStore((s) => s.update);
  const mix = props.project.mix || {};
  const tracks = (props.project.tracks || []).filter((t) => t.kind === 'audio' && !t.role);
  const M = (k: string, v: number | boolean) => update((p) => { p.mix = { ...(p.mix || {}), [k]: v }; }, typeof v === 'number' ? `mix:${k}` : undefined);
  const T = (id: string, fn: (t: NonNullable<Project['tracks']>[number]) => void, m?: string) => update((p) => { const t = (p.tracks || []).find((x) => x.id === id); if (t) fn(t); }, m);
  const strip = (key: string, label: string, db: number, muted: boolean, onDb: (v: number) => void, onMute: () => void, sub?: string) => (
    <div key={key} className="strip">
      <b className="small ellipsis" style={{ maxWidth: '100%' }}>{label}</b>
      {sub ? <span className="tiny dim">{sub}</span> : null}
      <input type="range" min={-30} max={12} step={0.5} value={db} onChange={(e) => onDb(Number(e.target.value))} onDoubleClick={() => onDb(0)} title={tx('Double-clic : 0 dB')} />
      <span className="mono">{db > 0 ? '+' : ''}{db.toFixed(1)} dB</span>
      <button className={`btn sm ${muted ? 'on' : ''}`} style={muted ? { color: 'var(--danger)', borderColor: 'rgba(229,83,75,.5)', background: 'rgba(229,83,75,.12)' } : undefined} onClick={onMute}>M</button>
    </div>
  );
  return (
    <div className="col" style={{ gap: 0, flex: 1, minHeight: 0 }}>
      <div className="toolbar"><b style={{ paddingLeft: 4 }}>{tx('Table de mixage')}</b><span className="spacer" /><span className="small dim">{tx('Niveau final :')} {props.pack.style?.loudness ?? -14} LUFS à l'export</span></div>
      <div className="mixer">
        {strip('voice', tx('Voix'), mix.voiceDb || 0, !!mix.voiceMuted, (v) => M('voiceDb', v), () => M('voiceMuted', !mix.voiceMuted), 'A1')}
        {strip('music', tx('Musique'), mix.musicDb || 0, !!mix.musicMuted, (v) => M('musicDb', v), () => M('musicMuted', !mix.musicMuted), `A2 · ${r.music.length}`)}
        {strip('sfx', tx('Bruitages'), mix.sfxDb || 0, !!mix.sfxMuted, (v) => M('sfxDb', v), () => M('sfxMuted', !mix.sfxMuted), `A3 · ${r.sfx.length}`)}
        {tracks.map((t, i) => strip(t.id, t.name, t.volumeDb || 0, !!t.muted, (v) => T(t.id, (x) => { x.volumeDb = v; }, `trk:${t.id}`), () => T(t.id, (x) => { x.muted = !x.muted; }), `A${i + 4} · ${t.clips.length}`))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Export
export function ExportPage() {
  const { props, r } = useComp();
  const p = props.project;
  const renders = useStore((s) => s.renders);
  const jobs = useStore((s) => s.jobs);
  const notify = useStore((s) => s.notify);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [preset, setPreset] = useState(() => getPrefs().exportPreset || 'web');
  useEffect(() => { api.system().then(setSys).catch(() => undefined); }, []);
  const running = jobs.filter((j) => j.kind === 'render' && j.project === p.id && (j.status === 'running' || j.status === 'queued'));
  const presets = sys?.presets || { web: tx('Web — H.264'), draft: tx('Brouillon (½)') };
  const chapters = (r.chapters.length && r.chapters[0].from > 0 ? tx('0:00 Intro\\n') : '') + r.chapters.map((c) => `${fmt(c.from / r.fps, 0).replace(/\.\d+$/, '')} ${c.label}`).join('\n');
  const srt = useMemo(() => {
    const ts = (f: number) => { const s = f / r.fps; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x.toFixed(3).padStart(6, '0').replace('.', ',')}`; };
    return r.captions.map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.from + c.dur)}\n${c.text}\n`).join('\n');
  }, [r]);
  const download = (name: string, text: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name;
    a.click();
  };
  const desc: Record<string, string> = {
    web: tx('Pour YouTube, les réseaux, le partage. Bon compromis qualité / poids.'), '4k': tx('Rendu deux fois plus grand (si les sources le permettent).'),
    hevc: tx('Fichier plus léger à qualité égale.'), prores: tx('Qualité studio pour retravailler ailleurs. Fichiers lourds.'),
    draft: tx('Demi-résolution, rapide : pour relire le montage.'), audio: tx('Seulement le son, en WAV.'),
  };
  const base = (p.title || p.name).replace(/[^\w-]+/g, '_').slice(0, 60) || 'video';
  return (
    <div className="pbody">
      <div className="page" style={{ maxWidth: 920, padding: '22px 24px 40px' }}>
        <div className="page-head"><h1 className="grow">{tx('Exporter')}</h1><span className="muted small">{p.format.width}×{p.format.height} · {p.format.fps} i/s · {fmt(r.duration / r.fps, 0)}</span></div>
        <div className="col" style={{ gap: 6 }}>
          {Object.entries(presets).map(([k, label]) => (
            <button key={k} className={`export-card ${preset === k ? 'on' : ''}`} onClick={() => setPreset(k)}>
              <Icon name={k === 'audio' ? 'audio' : 'film'} size={16} />
              <span className="col grow" style={{ gap: 1 }}><b>{label}</b><span className="small muted">{desc[k] || ''}</span></span>
              {preset === k ? <Icon name="check" size={14} style={{ color: 'var(--accent-hi)' }} /> : null}
            </button>
          ))}
        </div>
        <div className="row">
          <span className="spacer" />
          <button className="btn primary" style={{ height: 32, padding: '0 18px' }} onClick={() => startExport(preset)} disabled={!p.timeline.length}><Icon name="export" size={14} /> {tx('Exporter')}</button>
        </div>
        {running.map((j) => (
          <div key={j.id} className="card col" style={{ gap: 6, padding: 12 }}>
            <div className="row small"><span className="spin" /><b className="grow">{jobLabel(j)}</b><span className="mono">{Math.round(j.progress * 100)} %</span>
              <button className="btn sm ghost" onClick={() => api.cancelJob(j.id)}>{tx('Annuler')}</button></div>
            <div className="progress"><div style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
            <span className="tiny dim ellipsis">{j.message}</span>
          </div>
        ))}
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn" onClick={() => download(`${base}.srt`, srt)} disabled={!r.captions.length}><Icon name="captions" size={13} /> {tx('Sous-titres (.srt)')}</button>
          <button className="btn" onClick={() => { navigator.clipboard.writeText(chapters); notify(tx('Chapitres copiés')); }} disabled={!r.chapters.length}><Icon name="copy" size={13} /> {tx('Copier les chapitres')}</button>
        </div>
        {renders.length ? (
          <div className="col" style={{ gap: 4 }}>
            <div className="section-title">{tx('Exports')}</div>
            {renders.map((x) => (
              <div key={x.path} className="rowi" style={{ cursor: 'default', border: '1px solid var(--border)', borderRadius: 5 }}>
                <Icon name="film" size={13} className="dim" />
                <a className="grow ellipsis" href={x.url} target="_blank" rel="noreferrer">{x.name}</a>
                <span className="small dim">{mb(x.size)} · {ago(x.created)}</span>
                {desktop() ? <button className="btn icon sm ghost" onClick={() => desktop()!.reveal(x.path)} title={tx('Afficher dans le dossier')}><Icon name="folder" size={12} /></button> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

