// Effects panel: my effects (saved presets), picture effects by category, color looks, one-off accents
// (at the playhead), transitions, titles. Click: applies to the selection (or to the shot under the
// playhead); drag: onto a timeline clip.
import { useState, type CSSProperties } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { getFrame, uid, useStore } from '../../lib/store';
import type { ClipItem, Fx, Look, TextStyle, TransitionKind } from '../../types';
import { fontFamily } from '../../remotion/fonts';
import { FX_CATS, FX_DEFS } from '../../remotion/effects';
import { COLOR_PRESETS, cssPreview } from '../../remotion/look';
import { clipAt, useComp } from '../comp';
import { addToTrack, applyEffect, applyPreset, effectTarget } from '../actions';
import { DND } from '../Timeline';
import { getPrefs } from '../../lib/prefs';
import { tx } from '../../lib/i18n';

const ACCENTS: { id: string; label: string; icon: string; make: (t: number, z: { face: number; center: number }) => Omit<Fx, 'id'> }[] = [
  { id: 'zc', label: tx('Zoom ponctuel'), icon: 'zoomin', make: (t, z) => ({ kind: 'zoom', t0: t, t1: t + 1.5, target: 'center', scale: z.center }) },
  { id: 'zf', label: tx('Zoom sur le visage'), icon: 'face', make: (t, z) => ({ kind: 'zoom', t0: t, t1: t + 1.2, target: 'face', scale: z.face }) },
  { id: 'sh', label: tx('Secousse'), icon: 'shake', make: (t) => ({ kind: 'shake', t0: t, t1: t + 0.4, amp: 14 }) },
  { id: 'fl', label: tx('Flash'), icon: 'zap', make: (t) => ({ kind: 'tint', t0: t, t1: t + 0.25, mode: 'flash' }) },
  { id: 'bw', label: tx('Passage N&B'), icon: 'contrast', make: (t) => ({ kind: 'tint', t0: t, t1: t + 2, mode: 'bw' }) },
  { id: 'ff', label: tx('Accéléré'), icon: 'fast', make: (t) => ({ kind: 'speed', t0: t, t1: t + 4, rate: 2 }) },
  { id: 'sl', label: tx('Ralenti'), icon: 'play', make: (t) => ({ kind: 'speed', t0: t, t1: t + 2, rate: 0.5 }) },
  { id: 'cut', label: tx('Couper 1 s'), icon: 'razor', make: (t) => ({ kind: 'cut', t0: t, t1: t + 1 }) },
  { id: 'bip', label: tx('Bip (censure)'), icon: 'bleep', make: (t) => ({ kind: 'censor', t0: t, t1: t + 0.4 }) },
];

const TRANS: { kind: TransitionKind; label: string; demo: CSSProperties }[] = [
  { kind: 'fade', label: tx('Fondu au noir'), demo: { background: 'linear-gradient(90deg,#000,#5a6170)' } },
  { kind: 'flash', label: tx('Fondu au blanc'), demo: { background: 'linear-gradient(90deg,#fff,#5a6170)' } },
  { kind: 'zoom', label: tx('Zoom'), demo: { background: 'radial-gradient(circle,#8a93a6 15%,#2a2d33 70%)' } },
  { kind: 'whip', label: tx('Filé'), demo: { background: 'repeating-linear-gradient(90deg,#8a93a6 0 5px,#2a2d33 5px 12px)', filter: 'blur(1px)' } },
  { kind: 'blur', label: tx('Flou'), demo: { background: 'linear-gradient(90deg,#5a6170,#8a93a6)', filter: 'blur(3px)' } },
  { kind: 'glitch', label: tx('Glitch'), demo: { background: 'linear-gradient(90deg,#c25555 33%,#4f9a6b 33% 66%,#4f7fb8 66%)' } },
];

const base: TextStyle = { font: 'Inter', size: 110, weight: 800, color: '#FFFFFF', stroke: 0, strokeColor: '#000000', bg: null, x: 0.5, y: 0.45, align: 'center', anim: 'fade', shadow: true };
export const TEXT_PRESETS: { id: string; label: string; text: string; style: TextStyle }[] = [
  { id: 'titre', label: tx('Titre'), text: tx('Titre'), style: { ...base, size: 140 } },
  { id: 'sous', label: tx('Sous-titre'), text: tx('Sous-titre'), style: { ...base, size: 64, weight: 600, y: 0.8 } },
  { id: 'tiers', label: tx('Tiers inférieur'), text: tx('Nom Prénom\\nFonction'), style: { ...base, size: 46, weight: 700, bg: 'rgba(0,0,0,0.6)', x: 0.22, y: 0.82, align: 'left', anim: 'slide', shadow: false } },
  { id: 'encadre', label: tx('Encadré'), text: tx('À RETENIR'), style: { ...base, size: 58, weight: 800, bg: '#3A82F7', y: 0.15, anim: 'slide', uppercase: true, shadow: false } },
  { id: 'impact', label: tx('Impact'), text: 'BOUM', style: { ...base, font: 'Bebas Neue', weight: 400, size: 230, stroke: 10, rotation: -3, uppercase: true, anim: 'pop' } },
  { id: 'contour', label: tx('Contour'), text: tx('Texte'), style: { ...base, font: 'Montserrat', size: 120, weight: 900, stroke: 9, anim: 'pop' } },
  { id: 'machine', label: tx('Machine à écrire'), text: tx('Pendant ce temps…'), style: { ...base, size: 60, weight: 600, anim: 'type', y: 0.5 } },
  { id: 'citation', label: tx('Citation'), text: tx('« Une phrase marquante »'), style: { ...base, font: 'Poppins', size: 72, weight: 500, y: 0.5, anim: 'fade' } },
];

export function EffectsPanel() {
  const { r, props, style } = useComp();
  const update = useStore((s) => s.update);
  const notify = useStore((s) => s.notify);
  const presets = useStore((s) => s.presets);
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  const show = (label: string) => !ql || label.toLowerCase().includes(ql);

  const accent = (a: (typeof ACCENTS)[number]) => {
    const at = clipAt(r, props.project.timeline, getFrame());
    if (!at) { notify(tx('Place la tête de lecture dans un plan')); return; }
    update((pp) => { const c = pp.timeline.find((x) => x.id === at.clip.id) as ClipItem; c.fx.push({ id: uid('f'), ...a.make(Math.round(at.t * 1000) / 1000, style.zoom) } as Fx); }, undefined, a.label);
  };
  const transition = (t: (typeof TRANS)[number]) => {
    const ref = effectTarget();
    if (!ref || ref.kind !== 'item') { notify(tx('Sélectionne un plan du montage')); return; }
    update((p) => { const it = p.timeline.find((x) => x.id === ref.id); if (it && it.type !== 'card') it.transition = { kind: t.kind, dur: getPrefs().transitionDur }; }, undefined, t.label);
  };
  const look = (k: string) => {
    const ref = effectTarget();
    if (!ref) { notify(tx('Sélectionne un plan ou un clip')); return; }
    update((p) => {
      const t = ref.kind === 'item' ? p.timeline.find((x) => x.id === ref.id) : (p.tracks || []).flatMap((tr) => tr.clips).find((c) => c.id === ref.id);
      if (!t || t.type === 'card' || t.type === 'text' || t.type === 'audio') return;
      const x = t as { look?: Look };
      x.look = { ...(x.look || {}), color: { ...(x.look?.color || {}), preset: k === 'none' ? undefined : k } };
    }, undefined, tx('Look {0}', COLOR_PRESETS[k].label));
  };
  const thumb = props.project.sources.find((s) => s.kind === 'video');
  const thumbUrl = thumb ? `/api/thumb?p=${encodeURIComponent(thumb.proxy ? decodeURIComponent((thumb.proxy.match(/p=([^&]+)/) || [])[1] || '') : thumb.path)}&t=${Math.min(30, thumb.duration / 3).toFixed(1)}&w=200` : '';

  return (
    <div className="col" style={{ gap: 0, flex: 1, minHeight: 0 }}>
      <div className="toolbar"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('Rechercher un effet')} /></div>
      <div className="pbody">
        {presets.length && (!ql || presets.some((p) => show(p.name))) ? (
          <>
            <div className="bin-head">{tx('Mes effets')}</div>
            <div className="fx-grid">
              {presets.filter((p) => show(p.name)).map((p) => (
                <div key={p.id} className="fx-tile" role="button" tabIndex={0} draggable title={tx('Clic : appliquer · glisser sur un clip')}
                  onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'preset', id: p.id }))} onClick={() => applyPreset(p)}>
                  <Icon name="style" size={18} />
                  <span className="ellipsis" style={{ maxWidth: '100%' }}>{p.name}</span>
                  <button className="fx-del" title={tx('Supprimer')} onClick={async (e) => { e.stopPropagation(); if (!confirm(tx('Supprimer « {0} » ?', p.name))) return; await api.deletePreset(p.id); useStore.setState({ presets: await api.presets() }); }}><Icon name="x" size={10} /></button>
                </div>
              ))}
            </div>
          </>
        ) : null}
        {FX_CATS.map(([cat, label]) => {
          const list = FX_DEFS.filter((d) => d.cat === cat && show(tx(d.label)));
          if (!list.length) return null;
          return (
            <div key={cat}>
              <div className="bin-head">{tx(label)}</div>
              <div className="fx-grid">
                {list.map((d) => (
                  <button key={d.kind} className="fx-tile" draggable title={tx('Clic : appliquer à la sélection · glisser sur un clip')}
                    onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'effect', kind: d.kind }))} onClick={() => applyEffect(d.kind)}>
                    <Icon name={d.icon} size={18} />{tx(d.label)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!ql || tx('couleur look').includes(ql) ? (
          <>
            <div className="bin-head">{tx('Looks de couleur')}</div>
            <div className="preset-grid" style={{ padding: 8 }}>
              {Object.entries(COLOR_PRESETS).map(([k, v]) => (
                <div key={k} className="preset" onClick={() => look(k)}>
                  <div className="thumb" style={{ backgroundImage: thumbUrl ? `url(${thumbUrl})` : undefined, filter: cssPreview(v.adj) }} />
                  {tx(v.label)}
                </div>
              ))}
            </div>
          </>
        ) : null}
        {ACCENTS.some((a) => show(a.label)) ? (
          <>
            <div className="bin-head">{tx('Accentuations · à la tête de lecture')}</div>
            <div className="fx-grid">
              {ACCENTS.filter((a) => show(a.label)).map((a) => <button key={a.id} className="fx-tile" onClick={() => accent(a)}><Icon name={a.icon} size={18} />{a.label}</button>)}
            </div>
          </>
        ) : null}
        {TRANS.some((t) => show(t.label)) ? (
          <>
            <div className="bin-head">{tx('Transitions · sur le plan sélectionné')}</div>
            <div className="fx-grid">
              {TRANS.filter((t) => show(t.label)).map((t) => (
                <button key={t.kind} className="fx-tile" draggable onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'transition', kind: t.kind }))} onClick={() => transition(t)}>
                  <span style={{ ...t.demo, width: '100%', height: 26, borderRadius: 3, display: 'block' }} />{t.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
        {TEXT_PRESETS.some((p) => show(p.label)) || show('titre') ? (
          <>
            <div className="bin-head">{tx('Titres')}</div>
            <div className="fx-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(124px, 1fr))' }}>
              {TEXT_PRESETS.filter((p) => show(p.label) || show('titre')).map((p) => (
                <button key={p.id} className="fx-tile" draggable
                  onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'text', preset: p.id, text: p.text, style: p.style }))}
                  onClick={() => addToTrack('text', { id: uid('o'), type: 'text', start: getFrame() / props.project.format.fps, dur: getPrefs().textDur, text: p.text, style: { ...p.style } })}>
                  <span style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', background: '#2a2d33', borderRadius: 3, overflow: 'hidden' }}>
                    <span style={{ fontFamily: fontFamily(p.style.font), fontWeight: p.style.weight, color: p.style.color, fontSize: 15, background: p.style.bg || undefined,
                      padding: p.style.bg ? '1px 6px' : undefined, WebkitTextStroke: p.style.stroke ? `${Math.min(2.5, p.style.stroke / 4)}px ${p.style.strokeColor}` : undefined,
                      paintOrder: 'stroke fill', textTransform: p.style.uppercase ? 'uppercase' : undefined, transform: `rotate(${p.style.rotation || 0}deg)`, whiteSpace: 'nowrap' }}>{p.text.split('\n')[0]}</span>
                  </span>
                  {p.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
