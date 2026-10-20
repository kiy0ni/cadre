// Moniteurs : programme (aperçu en direct du montage, Remotion Player) et source (rush brut, points d'entrée / sortie).
// La tête de lecture et le timecode bougent hors de React (onFrame) : la lecture reste fluide même sur un gros projet.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { Main } from '../remotion/Composition';
import { getFrame, getPlayer, onFrame, setPlayer, useStore } from '../lib/store';
import { fmt, tc } from '../lib/format';
import { Icon } from '../lib/icons';
import { useComp } from './comp';
import { getPrefs } from '../lib/prefs';
import { insertSource, jumpEdit, overlaySource } from './actions';
import { sourceCtl } from './shortcuts';
import { DND } from './Timeline';
import { tx } from '../lib/i18n';

export function ProgramMonitor({ compact = false }: { compact?: boolean }) {
  const { props, r } = useComp();
  const ref = useRef<PlayerRef>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const setFrame = useStore((s) => s.setFrame);
  const setPlaying = useStore((s) => s.setPlaying);
  const playing = useStore((s) => s.playing);
  const seek = useStore((s) => s.seek);
  const aiJob = useStore((s) => s.aiJob);
  const live = useStore((s) => s.live);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [full, setFull] = useState(() => getPrefs().previewFull);
  const inputProps = useMemo(() => (!full ? props : { ...props, project: { ...props.project, sources: props.project.sources.map((s) => ({ ...s, proxy: null })) } }), [props, full]);
  const dur = Math.max(1, r.duration);

  useEffect(() => {
    setPlayer(ref.current);
    const p = ref.current;
    if (!p) return;
    const onF = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => { setPlaying(false); setRate(1); };
    p.addEventListener('frameupdate', onF);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    p.seekTo(getFrame());
    return () => { p.removeEventListener('frameupdate', onF); p.removeEventListener('play', onPlay); p.removeEventListener('pause', onPause); setPlayer(null); };
  }, [setFrame, setPlaying]);
  useEffect(() => {
    const on = (e: Event) => setRate((e as CustomEvent<number>).detail);
    window.addEventListener('cadre-rate', on);
    return () => window.removeEventListener('cadre-rate', on);
  }, []);
  useEffect(() => onFrame((f) => {
    if (tcRef.current) tcRef.current.textContent = tc(f, r.fps);
    if (headRef.current) headRef.current.style.left = `${(f / Math.max(1, dur - 1)) * 100}%`;
  }), [r.fps, dur]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth - 16;
      const H = el.clientHeight - 16;
      const ar = r.width / r.height;
      const w = Math.max(120, Math.min(W, H * ar));
      setBox({ w, h: w / ar });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [r.width, r.height]);

  const lastTool = [...(live?.blocks || [])].reverse().find((b) => b.type === 'tool') as { label: string } | undefined;
  const scrubTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * (dur - 1));
  };

  return (
    <div className="monitor">
      <div className="stage" ref={wrap}>
        {aiJob ? <div className="ai-run"><span className="spin" /><span className="ellipsis small">{lastTool?.label?.replace(/^\S+\s+/, '') || tx('L\'assistant travaille…')}</span></div> : null}
        <div className="stage-box" style={{ width: box.w, height: box.h }}>
          <Player ref={ref} component={Main} inputProps={inputProps} durationInFrames={dur} compositionWidth={r.width} compositionHeight={r.height}
            fps={r.fps} style={{ width: box.w, height: box.h }} clickToPlay doubleClickToFullscreen spaceKeyToPlayOrPause={false} playbackRate={rate} loop={loop}
            numberOfSharedAudioTags={12} acknowledgeRemotionLicense bufferStateDelayInMilliseconds={400}
            renderLoading={() => <div style={{ width: '100%', height: '100%', background: '#000' }} />} />
        </div>
        {props.project.timeline.length === 0 && !(props.project.tracks || []).some((t) => t.clips.length) ? <EmptyState /> : null}
      </div>
      <div className="mon-scrub" onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); scrubTo(e); }} onPointerMove={(e) => e.buttons === 1 && scrubTo(e)}>
        <div className="rail" />
        {r.chapters.map((c) => <div key={c.from} style={{ position: 'absolute', left: `${(c.from / dur) * 100}%`, top: 4, width: 1, height: 8, background: 'var(--warn)' }} title={c.label} />)}
        <div className="head" ref={headRef} />
      </div>
      <div className="mon-bar">
        <div className="row" style={{ gap: 6 }}>
          <span className="tc-big" ref={tcRef}>{tc(getFrame(), r.fps)}</span>
          {!compact ? <span className="mono dim d-only">/ {tc(dur, r.fps)}</span> : null}
        </div>
        <div className="row" style={{ gap: 2 }}>
          <button className="btn icon ghost" onClick={() => seek(0)} title={tx('Début (Origine)')}><Icon name="start" size={15} /></button>
          <button className="btn icon ghost" onClick={() => jumpEdit(-1)} title={tx('Coupe précédente (↑)')}><Icon name="prev" size={15} /></button>
          <button className="btn icon ghost" onClick={() => seek(getFrame() - 1)} title={tx('Image précédente (←)')}><Icon name="stepb" size={15} /></button>
          <button className="btn icon" style={{ width: 34 }} onClick={() => getPlayer()?.toggle()} title={tx('Lecture / pause (Espace)')}><Icon name={playing ? 'pause' : 'play'} size={15} /></button>
          <button className="btn icon ghost" onClick={() => seek(getFrame() + 1)} title={tx('Image suivante (→)')}><Icon name="stepf" size={15} /></button>
          <button className="btn icon ghost" onClick={() => jumpEdit(1)} title={tx('Coupe suivante (↓)')}><Icon name="next" size={15} /></button>
          <button className={`btn icon ghost ${loop ? 'on' : ''}`} onClick={() => setLoop(!loop)} title={tx('Lecture en boucle')}><Icon name="loop" size={15} /></button>
        </div>
        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
          {rate !== 1 ? <span className="badge accent">{rate}×</span> : null}
          <button className={`btn sm ghost d-only ${full ? 'on' : ''}`} onClick={() => setFull(!full)} title={full ? tx('Pleine qualité (plus lourd)') : tx('Aperçu allégé (fluide). Clic : pleine qualité')}>{full ? tx('Pleine') : tx('Allégé')}</button>
          <button className="btn icon ghost" onClick={() => { const p = getPlayer(); if (!p) return; if (muted) p.unmute(); else p.mute(); setMuted(!muted); }} title={tx('Son')}><Icon name={muted ? 'mute' : 'volume'} size={15} /></button>
          <button className="btn icon ghost d-only" onClick={() => getPlayer()?.requestFullscreen()} title={tx('Plein écran')}><Icon name="full" size={15} /></button>
        </div>
      </div>
    </div>
  );
}

/** écran vide : la prochaine action, rien d'autre */
function EmptyState() {
  const { props } = useComp();
  const setUi = useStore((s) => s.setUi);
  const askAi = useStore((s) => s.askAi);
  const update = useStore((s) => s.update);
  const aiJob = useStore((s) => s.aiJob);
  const ai = useStore((s) => s.ai);
  const sources = props.project.sources;
  const transcribing = sources.some((s) => s.status.transcript === 'running');
  return (
    <div className="overlay-msg">
      {sources.length === 0 ? (
        <>
          <b>{tx('Importe des médias pour commencer')}</b>
          <span className="small">{tx('Vidéos, sons, images, ou un lien YouTube / Twitch.')}</span>
          <button className="btn primary" onClick={() => { setUi({ workspace: 'edit', lowerTab: 'project' }); setTimeout(() => (document.querySelector('[data-import]') as HTMLButtonElement | null)?.click(), 60); }}>
            <Icon name="import" size={14} /> Importer
          </button>
        </>
      ) : (
        <>
          <b>{transcribing ? tx('Analyse des médias…') : tx('Prêt à monter')}</b>
          <div className="row" style={{ gap: 8 }}>
            {ai?.provider ? (
              <button className="btn primary" disabled={!!aiJob} onClick={() => { setUi({ assistant: true }); askAi(tx('Monte la vidéo complète à partir des médias du projet, en suivant le style de montage.')); }}>
                Monter avec l'assistant
              </button>
            ) : null}
            <button className="btn" onClick={() => update((p) => { for (const s of p.sources) if (s.kind !== 'image') p.timeline.push({ id: Math.random().toString(36).slice(2, 12), type: 'clip', src: s.id, in: 0, out: s.duration, label: '', jump: null, speed: 1, captions: [], fx: [] }); })}>
              Tout mettre dans la timeline
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- moniteur source
const marks = new Map<string, { a: number; b: number | null }>();

export function SourceMonitor() {
  const { props } = useComp();
  const sourceId = useStore((s) => s.sourceId);
  const setUi = useStore((s) => s.setUi);
  const src = props.project.sources.find((s) => s.id === sourceId);
  const vid = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [io, setIo] = useState<{ a: number; b: number | null }>({ a: 0, b: null });
  const dur = src?.duration || 0;
  const out = io.b ?? dur;

  useEffect(() => { if (src) { setIo(marks.get(src.id) || { a: 0, b: null }); setT(0); } }, [src?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (src) marks.set(src.id, io); }, [io, src]);
  useEffect(() => {
    if (!src) return;
    sourceCtl.markIn = () => setIo((x) => ({ a: vid.current?.currentTime ?? 0, b: x.b !== null && x.b <= (vid.current?.currentTime ?? 0) ? null : x.b }));
    sourceCtl.markOut = () => setIo((x) => ({ ...x, b: Math.max(x.a + 0.1, vid.current?.currentTime ?? dur) }));
    sourceCtl.insert = () => insertSource(src.id, io.a, out);
    sourceCtl.overlay = () => overlaySource(src.id, io.a, out);
    sourceCtl.toggle = () => { const v = vid.current; if (v) { if (v.paused) v.play(); else v.pause(); } };
    return () => { sourceCtl.markIn = sourceCtl.markOut = sourceCtl.insert = sourceCtl.overlay = sourceCtl.toggle = undefined; };
  }, [src, io, out, dur]);

  if (!src) {
    return <div className="overlay-msg" style={{ position: 'relative', flex: 1 }}><span className="small">{tx('Double-clique un média du projet pour l\'ouvrir ici.')}</span></div>;
  }
  const url = src.proxy || src.url;
  const seekTo = (x: number) => { const v = vid.current; if (v) v.currentTime = Math.max(0, Math.min(dur, x)); setT(Math.max(0, Math.min(dur, x))); };
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * dur);
  };
  const pct = (x: number) => `${(x / Math.max(0.001, dur)) * 100}%`;

  return (
    <div className="monitor src-mon" tabIndex={-1}>
      <div className="stage">
        {src.kind === 'image' ? <img src={src.url} style={{ maxWidth: '100%', maxHeight: '100%' }} alt="" />
          : <video ref={vid} src={url} style={{ maxWidth: '100%', maxHeight: '100%', background: '#000' }} playsInline preload="auto"
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={() => sourceCtl.toggle?.()} />}
        {src.kind === 'audio' ? <div className="overlay-msg"><Icon name="audio" size={28} /><span className="small">{src.name}</span></div> : null}
      </div>
      <div className="mon-scrub" onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); scrub(e); }} onPointerMove={(e) => e.buttons === 1 && scrub(e)}>
        <div className="rail" />
        <div className="io" style={{ left: pct(io.a), width: `calc(${pct(out)} - ${pct(io.a)})` }} />
        <div className="head" style={{ left: pct(t) }} />
      </div>
      <div className="mon-bar">
        <span className="tc-big">{tc(t * (src.fps || 30), src.fps || 30)}</span>
        <div className="row" style={{ gap: 2 }}>
          <button className="btn icon ghost" onClick={() => sourceCtl.markIn?.()} title={tx('Point d\'entrée (I)')}><Icon name="mark_in" size={15} /></button>
          <button className="btn icon ghost" onClick={() => seekTo(t - 1 / (src.fps || 30))} title={tx('Image précédente')}><Icon name="stepb" size={15} /></button>
          <button className="btn icon" style={{ width: 34 }} onClick={() => sourceCtl.toggle?.()} disabled={src.kind === 'image'}><Icon name={playing ? 'pause' : 'play'} size={15} /></button>
          <button className="btn icon ghost" onClick={() => seekTo(t + 1 / (src.fps || 30))} title={tx('Image suivante')}><Icon name="stepf" size={15} /></button>
          <button className="btn icon ghost" onClick={() => sourceCtl.markOut?.()} title={tx('Point de sortie (O)')}><Icon name="mark_out" size={15} /></button>
        </div>
        <span className="mono dim small" style={{ justifySelf: 'end' }}>{fmt(out - io.a, 1)}</span>
      </div>
      <div className="toolbar" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
        <button className="btn sm" onClick={() => sourceCtl.insert?.()} title={tx('Insérer dans le montage à la tête de lecture (,)')}><Icon name="insert" size={13} /> {tx('Insérer')}</button>
        <button className="btn sm" onClick={() => sourceCtl.overlay?.()} title={tx('Ajouter au-dessus, en incrustation (.)')}><Icon name="overwrite" size={13} /> {tx('Incrustation')}</button>
        <span draggable className="btn icon sm ghost" style={{ cursor: 'grab' }} title={tx('Glisser l\'extrait vers la timeline')}
          onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'source', id: src.id, a: io.a, b: out }))}><Icon name="film" size={13} /></span>
        <span className="spacer" />
        <span className="small dim ellipsis" style={{ maxWidth: 120 }} title={src.name}>{src.name}</span>
        <button className="btn icon sm ghost" onClick={() => setUi({ sourceId: null, upperTab: 'props' })} title={tx('Fermer')}><Icon name="x" size={12} /></button>
      </div>
    </div>
  );
}
